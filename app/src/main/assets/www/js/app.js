/* app.js - router, boot, polling */

'use strict';

/* rounded creeper face (black silhouette, transparent bg) — generated
   from the launcher artwork; used as the in-app brand mark */
const BRAND_FACE =
  'iVBORw0KGgoAAAANSUhEUgAAAEgAAAA/CAYAAABDyo4+AAABEklEQVR42u3awRLCIAxFUR7j//9y3LlwZDBW0hBuFi7qSOE0pQSrRrTWmn04ptcHMMOQQJkIAQOQXfmxQDkLyP7cXplJ2ha0WeIxb4va1egWs5Un2yFjRgdt8ZVWYiDNvrSg20GJcL7uSy8wX3hhXBeqNwKgtyx2ZfIjOL0zLg80y6Dd1kKKzCoFTaK7rIWmC0VW08VKDYrVu6Gqb5gZQIux2LSf+JxYarjqsdP/FxtlFS4EQZSsjKPKAFUCsp373zfGiWifPWmAAAIIIIAAuucRHHEeJR10mjH3w3Dc42AOAggggAACCCCAACIAAgig+Ih6DXi3lzjJIIAAAggggAC67RF/pd1lm/ZKhPNr++7+PAE47yhgg5dmbwAAAABJRU5ErkJggg==';

const App = {
  view: 'home',
  prevMain: 'home',
  cleanup: [],
  status: { state: 'idle' },
  info: null,
  playersOnline: [],
  fakePlayers: [],
  filesPath: '',
  contentTab: 'plugins',
  onStatus: null,
  onPlayers: null,
  onState: null, // in-place state-change hook (set by the home view)

  /* ---- multi-server (v2.4) ---- */
  profiles: [],
  activeProfile: (() => { try { return localStorage.getItem('pm_profile') || 'default'; } catch (e) { return 'default'; } })(),
  bgSeq: {},          // profileId -> {seq, session} for background consoles
  onProfiles: null,   // (profiles) - home view: bar + bg console cards
  onBgLines: null,    // (profileId, lines)
  onBgReset: null,    // (profileId)

  activeProfileObj() {
    return this.profiles.find((p) => p.id === this.activeProfile) || null;
  },

  setProfile(id) {
    if (id === this.activeProfile) return;
    this.activeProfile = id;
    try { localStorage.setItem('pm_profile', id); } catch (e) { /* private mode */ }
    /* the global console engine now belongs to the new active server */
    Console.seq = 0;
    Console.session = -1;
    Console.recent = [];
    Console.clearViews();
    this.playersOnline = [];
    this.fakePlayers = [];
    this.status = { state: 'idle' };
    this.refreshInfo();
    this.rerender();
  },

  SUB_VIEWS: ['settings', 'players', 'logs', 'backup', 'update', 'about', 'editor', 'fakeplayers', 'compiler', 'downloader', 'importpkg', 'publicip', 'stats', 'market'],

  refreshInfo() {
    const res = API.call('info');
    if (res.ok) this.info = res;
    else this.info = {};
  },

  /* Synchronous profiles refresh (bridge is sync): used right before/after
   * server-list operations so the servers dialog never shows a stale list
   * (the poll loop only runs every 1.3s). */
  refreshProfiles() {
    const pr = API.call('profiles.list');
    if (pr.ok && pr.profiles) {
      this.profiles = pr.profiles;
      if (this.onProfiles) this.onProfiles(this.profiles);
    }
    return this.profiles;
  },

  navigate(view) {
    for (const fn of this.cleanup) { try { fn(); } catch (e) { /* noop */ } }
    this.cleanup = [];
    if (view !== 'editor') this.prevMain = view;
    this.view = view;
    this.render(true);
    const v = qs('#view');
    if (v) v.scrollTop = 0;
    window.scrollTo(0, 0);
  },

  rerender() {
    this.render();
  },

  /* Re-render without losing the scroll position and without leaking
   * console targets (cleanup must run before any rebuild that is not
   * triggered by navigate()). */
  softRender() {
    for (const fn of this.cleanup) { try { fn(); } catch (e) { /* noop */ } }
    this.cleanup = [];
    const v = qs('#view');
    const sc = v ? v.scrollTop : 0;
    this.render(false);
    if (v && this.view !== 'console') v.scrollTop = sc;
  },

  render(animate) {
    const root = qs('#view');
    root.innerHTML = '';
    /* Console view fills the viewport (Termux-style fixed screen); others scroll.
     * Also clear the console-only column class — leaving it on leaks flex
     * layout into other views and squeezes their toolbars. */
    root.classList.toggle('fill', this.view === 'console');
    root.classList.remove('console-page');
    if (this.SUB_VIEWS.includes(this.view)) {
      root.appendChild(subHeader(this.view));
    }
    const fn = Views[this.view] || Views.home;
    fn(root);
    updateNav();
    if (animate !== false) animateViewIn(root);
  },

  poll() {
    try {
      /* multi-server: refresh the profile list first (states + uptimes) */
      const pr = API.call('profiles.list');
      if (pr.ok && pr.profiles) {
        this.profiles = pr.profiles;
        if (this.onProfiles) this.onProfiles(this.profiles);
      }
      const st = API.call('status');
      if (st.ok) {
        const prev = this.status ? this.status.state : 'idle';
        this.status = st;
        updatePill(st.state);
        if (this.onStatus) this.onStatus(st);
        if (prev !== st.state) {
          /* the local server went down: its fake players are gone */
          if (['stopped', 'crashed', 'stopping'].includes(st.state) && typeof BotAPI !== 'undefined') {
            try { BotAPI.onServerDown(); } catch (e) { /* noop */ }
          }
          /* Prefer the in-place hook (home updates its hero live and never
           * rebuilds the DOM, so nothing can flash/shrink/disappear). */
          if (typeof this.onState === 'function') {
            this.onState(st.state, prev);
          } else if (['players', 'backup', 'update'].includes(this.view)) {
            this.softRender();
          }
        }
      }
      const con = API.call('console', { after: Console.seq });
      if (con.ok && con.lines && con.lines.length) Console.addLines(con.lines, con.session);

      /* live consoles of the OTHER running servers (home view cards) */
      for (const p of this.profiles) {
        if (p.id === this.activeProfile) continue;
        if (!['running', 'starting', 'stopping'].includes(p.state)) continue;
        const bg = API.call('console', { after: (this.bgSeq[p.id] || {}).seq || 0, profile: p.id });
        if (bg.ok) {
          let s = this.bgSeq[p.id];
          if (!s) s = this.bgSeq[p.id] = { seq: 0, session: -1 };
          if (bg.session !== s.session) {
            s.session = bg.session;
            s.seq = 0;
            if (this.onBgReset) this.onBgReset(p.id);
          }
          if (bg.lines && bg.lines.length) {
            s.seq = bg.lines[bg.lines.length - 1][0];
            if (this.onBgLines) this.onBgLines(p.id, bg.lines);
          }
        }
      }
    } catch (e) { /* keep polling */ }
  },
};

function updatePill(state) {
  const pill = qs('#statePill');
  if (pill) {
    /* keep the frameless "bare" modifier: the topbar status is colored text
     * only (no box, no dot); the class list is rebuilt on every poll, so
     * dropping "bare" here would bring the box back after ~1.3s. */
    pill.className = 'pill bare state-' + state;
    /* v2.7: with several servers the bare state text was ambiguous - show
     * WHICH server this status belongs to (the active one). */
    const nm = qs('#statePillName');
    if (nm) {
      const p = App.activeProfileObj();
      nm.textContent = p && p.name ? p.name + ' · ' : '';
    }
    qs('#statePillText').textContent = t(state);
  }
  const tp = qs('#termState');
  if (tp) {
    tp.className = 'pill state-' + state;
    qs('#termStateText').textContent = t(state);
  }
  const sb = qs('#topSettingsBtn');
  if (sb) sb.classList.toggle('active', App.view === 'settings');
}

function updateNav() {
  const map = { settings: 'tools', players: 'tools', logs: 'tools', backup: 'tools', update: 'tools', about: 'tools', editor: 'files', fakeplayers: 'tools', compiler: 'tools', downloader: 'tools', importpkg: 'tools', publicip: 'tools', stats: 'tools', market: 'tools' };
  const activeTab = map[App.view] || App.view;
  qsa('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === activeTab));
  const sb = qs('#topSettingsBtn');
  if (sb) sb.classList.toggle('active', App.view === 'settings');
  moveNavIndicator();
}

/* ---------- nav dock: sliding selection pill ----------
 * The pill mirrors the .segmented active button: it fills the active tab's
 * own box (inset by the dock frame) and glides between tabs on a spring.
 * The very first placement is instant so it doesn't fly across the screen. */
let navIndicatorReady = false;
function moveNavIndicator() {
  const bar = qs('#bottomnav');
  const ind = qs('#navIndicator');
  if (!bar || !ind) return;
  const btn = bar.querySelector('.nav-btn.active');
  if (!btn) { ind.classList.remove('on'); return; }
  const w = btn.offsetWidth;
  const x = btn.offsetLeft;
  if (!navIndicatorReady) {
    ind.style.transition = 'none';
    ind.style.width = w + 'px';
    ind.style.transform = 'translateX(' + Math.round(x) + 'px)';
    void ind.offsetWidth; /* flush the instant jump before re-enabling motion */
    ind.style.transition = '';
    navIndicatorReady = true;
  } else {
    ind.style.width = w + 'px';
    ind.style.transform = 'translateX(' + Math.round(x) + 'px)';
  }
  ind.classList.add('on');
}

/* ---------- view transition: staggered fade-up (iOS feel) ----------
 * Top-level blocks of the fresh view rise in one after another. */
function animateViewIn(root) {
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.add('view-in');
    kids[i].style.animationDelay = Math.min(i * 60, 320) + 'ms';
  }
}

const SUB_TITLES = {
  settings: 'settings_title', players: 'players_title', logs: 'logs_title',
  backup: 'backup_title', update: 'update_title', about: 'about_title',
  fakeplayers: 'fakeplayers_title', compiler: 'compiler_title', downloader: 'downloader_title',
  importpkg: 'import_title', publicip: 'publicip_title', stats: 'stats_title', market: 'market_title',
};

function subHeader(view) {
  const backTarget = view === 'editor' ? (App.editorReturn || 'files')
    : (['settings', 'players', 'logs', 'backup', 'update', 'about', 'fakeplayers', 'compiler', 'downloader', 'importpkg', 'publicip', 'stats', 'market'].includes(view) ? 'tools' : 'home');
  return h('div', { class: 'spread mb' },
    h('button', { class: 'btn sm ghost', onclick: () => App.navigate(backTarget) },
      icon('back'), h('span', { 'data-t': 'back' }, t('back'))),
    h('div', { class: 'card-title', style: 'margin:0' },
      icon('grid'), view === 'editor' ? t('file_editor') : t(SUB_TITLES[view] || view)));
}

/* ---------- keyboard-safe viewport ----------
 * Some Android WebViews do not resize the layout viewport when the soft
 * keyboard opens, so position:fixed panels get squeezed or covered.
 * Pin the shell to the *visible* viewport while the keyboard is up. */
function initViewportFix() {
  const vv = window.visualViewport;
  if (!vv) return;
  const shell = qs('#appShell');
  let raf = 0;
  const apply = () => {
    raf = 0;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (kb > 80) {
      shell.style.top = vv.offsetTop + 'px';
      shell.style.height = vv.height + 'px';
      shell.style.bottom = 'auto';
    } else if (shell.style.bottom === 'auto') {
      shell.style.top = '';
      shell.style.height = '';
      shell.style.bottom = '';
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
}

/* ---------- first-launch language choice ----------
 * Shown once, only while no language has been saved yet: the user picks
 * Persian or English before anything else. Labels are bilingual by design
 * (the reader has no language yet). If the dialog is dismissed without a
 * choice, the default (Persian) is kept and the question returns next boot. */
function maybeAskLanguage() {
  try { if (localStorage.getItem('pm_lang')) return; } catch (e) { return; }
  const pick = (lang) => {
    setLang(lang); /* setLang persists pm_lang, so this is a one-time question */
    close();
  };
  const close = modal({
    title: 'زبان برنامه · App language',
    body: h('div', {},
      h('div', { class: 'hint', style: 'text-align:center;line-height:1.9' }, 'زبان مورد نظر خود را انتخاب کنید'),
      h('div', { class: 'hint', style: 'text-align:center;line-height:1.9' }, 'Choose your preferred language'),
      h('div', { class: 'row mt', style: 'gap:8px' },
        h('button', { class: 'btn primary block', onclick: () => pick('fa') }, 'فارسی'),
        h('button', { class: 'btn block', onclick: () => pick('en') }, 'English'))),
    actions: [],
  });
}

/* ---------- boot ---------- */
function boot() {
  /* brand mark = the app's rounded creeper icon, inlined as a data URI */
  qs('#brandIcon').innerHTML =
    '<svg width="26" height="26" viewBox="0 0 26 26" fill="none">'
    + '<rect x="0.75" y="0.75" width="24.5" height="24.5" rx="7" fill="#07F917"/>'
    + '<image href="data:image/png;base64,' + BRAND_FACE + '" x="4.35" y="4.5" width="17.3" height="17"/>'
    + '</svg>';

  /* boot render: do not persist yet — a fresh install must stay "no choice
     made" so the first-launch language question appears (maybeAskLanguage). */
  setLang(LANG, false);

  /* inject the dock tab icons (data-ic spans ship empty in index.html) */
  qsa('.nav-ic').forEach((el) => {
    const name = el.getAttribute('data-ic');
    if (name) el.appendChild(icon(name));
  });

  /* topbar settings button (next to the server status) */
  const sb = qs('#topSettingsBtn');
  if (sb) {
    qs('.tb-ic', sb).appendChild(icon('settings'));
    sb.addEventListener('click', () => App.navigate('settings'));
  }

  qsa('.nav-btn').forEach((b) => b.addEventListener('click', () => App.navigate(b.dataset.view)));

  /* keep the dock pill pinned to its tab through resizes/rotation/keyboard */
  window.addEventListener('resize', debounce(() => moveNavIndicator(), 120));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', debounce(() => moveNavIndicator(), 120));
  }

  Terminal.init();
  try { API.call('bootstrap'); } catch (e) { /* shown on start */ }
  App.refreshInfo();
  App.navigate('home');
  App.poll();
  setInterval(() => App.poll(), 1300);
  initViewportFix();
  maybeAskLanguage();
}

document.addEventListener('DOMContentLoaded', boot);
