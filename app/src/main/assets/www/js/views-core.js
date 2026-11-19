/* views-core.js - console engine, dashboard, console view, terminal overlay */

'use strict';

window.Views = window.Views || {};

/* ================= Console engine (shared) ================= */
const Console = {
  seq: 0,
  session: 0,
  recent: [],
  targets: [],

  attach(el, cap, opts) {
    const tgt = {
      el, cap: cap || 400,
      autoscroll: true,
      atBottom: true,
      pending: 0,
      jumpBtn: (opts && opts.jumpBtn) || null,
    };
    el.addEventListener('scroll', () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (bottom && !tgt.atBottom) {
        tgt.atBottom = true;
        tgt.autoscroll = true;
        tgt.pending = 0;
        this.updateJump(tgt);
      } else if (!bottom) {
        tgt.atBottom = false;
      }
    }, { passive: true });
    this.targets.push(tgt);
    if (this.recent.length) {
      const frag = document.createDocumentFragment();
      for (const pair of this.recent) frag.appendChild(this.makeLine(pair[1]));
      el.appendChild(frag);
      this.trim(tgt);
    } else {
      el.appendChild(h('div', { class: 'ln empty' }, '—'));
    }
    el.scrollTop = el.scrollHeight;
    return tgt;
  },

  detach(tgt) {
    this.targets = this.targets.filter((x) => x !== tgt);
  },

  makeLine(text, cls) {
    const div = h('div', { class: 'ln' + (cls ? ' ' + cls : '') });
    if (cls === 'cmd') div.textContent = text;
    else div.innerHTML = ansiToHtml(text);
    return div;
  },

  trim(tgt) {
    while (tgt.el.childElementCount > tgt.cap && tgt.el.firstElementChild) tgt.el.firstElementChild.remove();
  },

  updateJump(tgt) {
    if (tgt.jumpBtn) {
      tgt.jumpBtn.classList.toggle('hidden', tgt.atBottom);
      if (tgt.pending > 0) {
        tgt.jumpBtn.textContent = '';
        tgt.jumpBtn.appendChild(icon('down', 14));
        tgt.jumpBtn.appendChild(document.createTextNode(' ' + t('new_lines').replace('{n}', tgt.pending)));
      }
    }
  },

  /* A different console session (server restart): wipe everything. */
  reset(session) {
    this.session = session;
    this.recent = [];
    this.seq = 0;
    for (const tgt of this.targets) {
      tgt.el.innerHTML = '';
      tgt.pending = 0;
      tgt.atBottom = true;
      tgt.autoscroll = true;
      this.updateJump(tgt);
    }
  },

  addLines(pairs, session) {
    if (typeof session === 'number' && session !== this.session) {
      this.reset(session);
    }
    let touched = false;
    for (const pair of pairs) {
      const s = pair[0], text = pair[1];
      if (s <= this.seq) continue;
      this.seq = s;
      this.recent.push([s, text]);
      if (this.recent.length > 250) this.recent.shift();
      for (const tgt of this.targets) {
        const first = tgt.el.firstElementChild;
        if (first && first.classList.contains('empty')) first.remove();
        tgt.el.appendChild(this.makeLine(text));
        this.trim(tgt);
        if (tgt.atBottom) {
          tgt.el.scrollTop = tgt.el.scrollHeight;
        } else {
          tgt.pending++;
          this.updateJump(tgt);
        }
      }
      this.parseLine(text);
      touched = true;
    }
    return touched;
  },

  echo(cmd) {
    const text = '> ' + cmd;
    this.seq += 1;
    this.recent.push([this.seq, text]);
    if (this.recent.length > 250) this.recent.shift();
    for (const tgt of this.targets) {
      const first = tgt.el.firstElementChild;
      if (first && first.classList.contains('empty')) first.remove();
      tgt.el.appendChild(this.makeLine(text, 'cmd'));
      this.trim(tgt);
      if (tgt.atBottom) tgt.el.scrollTop = tgt.el.scrollHeight;
    }
  },

  send(cmd) {
    const res = API.call('command', { text: cmd });
    if (res && res.ok === false) {
      toast(res.error || t('error'), 'err');
      return false;
    }
    this.echo(cmd);
    return true;
  },

  parseLine(text) {
    const plain = stripAnsi(text);
    let m = plain.match(/There are \d+\/\d+ players online:?\s*(.*)/);
    if (m) {
      App.playersOnline = m[1] ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (App.onPlayers) App.onPlayers(App.playersOnline.slice());
      return;
    }
    m = plain.match(/^(.{0,40}?)\s*([\w .\-]{2,32}) joined the game/);
    if (m) {
      const name = m[2].trim();
      if (!App.playersOnline.includes(name)) App.playersOnline.push(name);
      if (App.onPlayers) App.onPlayers(App.playersOnline.slice());
      return;
    }
    m = plain.match(/^(.{0,40}?)\s*([\w .\-]{2,32}) left the game/);
    if (m) {
      const name = m[2].trim();
      App.playersOnline = App.playersOnline.filter((n) => n !== name);
      if (App.onPlayers) App.onPlayers(App.playersOnline.slice());
      return;
    }
    /* PMPanelBot fake players: "Fake players (N): a, b, c" (console or RCON) */
    m = plain.match(/Fake players \((\d+)\)(?::\s*(.*))?/);
    if (m) {
      App.fakePlayers = (!m[2] || m[1] === '0') ? [] : m[2].split(',').map((s) => s.trim()).filter(Boolean);
      if (App.onFakePlayers) App.onFakePlayers(App.fakePlayers.slice());
    }
  },

  clearViews() {
    for (const tgt of this.targets) {
      tgt.el.innerHTML = '';
      tgt.pending = 0;
      tgt.atBottom = true;
      this.updateJump(tgt);
    }
  },

  copyLast(n) {
    const lines = this.recent.slice(-(n || 100)).map((p) => stripAnsi(p[1]));
    if (!lines.length) { toast(t('console_empty'), 'err'); return; }
    if (copyText(lines.join('\n'))) toast(t('copied'), 'ok');
    else toast(t('error'), 'err');
  },
};

/* ================= Terminal overlay ================= */
const Terminal = {
  tgt: null,
  open() {
    qs('#terminalOverlay').classList.remove('hidden');
    const screen = qs('#termScreen');
    if (!this.tgt) this.tgt = Console.attach(screen, 1200);
    setTimeout(() => qs('#termInput').focus(), 120);
  },
  close() {
    qs('#terminalOverlay').classList.add('hidden');
    Console.detach(this.tgt);
    this.tgt = null;
  },
  init() {
    qs('#termBackBtn').addEventListener('click', () => this.close());
    const input = qs('#termInput');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (!v) return;
        Console.send(v);
        input.value = '';
      }
    });
  },
};

/* ================= Dashboard ================= */
Views.home = (root) => {
  const st = App.status || {};
  const info = App.info || {};
  const bundle = info.bundle || {};

  /* ---- profile bar: one chip per server + add/manage button ---- */
  const profileBar = h('div', { class: 'profile-bar' });
  let barSig = '';
  function renderBar() {
    const sig = JSON.stringify(App.profiles.map((p) => [p.id, p.name, p.state]));
    if (sig === barSig) return;
    barSig = sig;
    profileBar.innerHTML = '';
    for (const p of App.profiles) {
      profileBar.appendChild(h('button', {
        class: 'p-chip' + (p.id === App.activeProfile ? ' active' : '') + ' st-' + p.state,
        onclick: () => App.setProfile(p.id),
      },
      h('span', { class: 'pc-dot' }),
      h('span', { class: 'pc-name' }, p.name)));
    }
    profileBar.appendChild(h('button', {
      class: 'p-chip add', onclick: serversModal,
    }, icon('plus', 14), h('span', { class: 'pc-name' }, t('servers'))));
  }
  renderBar();

  /* ---- add / rename / delete servers ---- */
  function serversModal() {
    /* fresh list every time the dialog opens - never a stale poll snapshot */
    App.refreshProfiles();
    const listEl = h('div', {});
    function renderList() {
      listEl.innerHTML = '';
      for (const p of App.profiles) {
        const actions = h('div', { class: 'fm-actions' });
        /* rename: available for EVERY server, including the first one */
        actions.appendChild(h('button', {
          class: 'icon-btn', title: t('rename'),
          onclick: () => {
            const inp = h('input', { class: 'text-input', type: 'text', value: p.name });
            modal({
              title: t('rename'),
              body: h('div', {}, inp),
              actions: [
                { label: t('cancel'), class: 'btn ghost' },
                {
                  label: t('save'), class: 'btn primary',
                  onClick: () => {
                    const r = API.call('profiles.rename', { profile: p.id, name: inp.value });
                    if (r.ok === false) toast(r.error, 'err');
                    else { toast(t('saved'), 'ok'); App.refreshProfiles(); renderList(); }
                  },
                },
              ],
            });
          },
        }, icon('edit')));
        if (p.id !== 'default') {
          actions.appendChild(h('button', {
            class: 'icon-btn', title: t('delete'),
            onclick: () => {
              confirmModal(t('delete_server'), p.name + ' — ' + t('delete_server_confirm'), t('delete'), () => {
                const r = API.call('profiles.delete', { profile: p.id });
                if (r.ok === false) { toast(r.error, 'err'); return; }
                if (p.id === App.activeProfile) App.setProfile('default');
                toast(t('saved'), 'ok');
                App.refreshProfiles(); renderList();
              }, true);
            },
          }, icon('trash')));
        }
        /* v2.7: START / STOP directly per row - no need to switch the whole
         * panel to a server just to (re)start it; the two can run together. */
        const isActiveRun = ['running', 'starting'].includes(p.state);
        if (isActiveRun) {
          actions.appendChild(h('button', {
            class: 'btn sm danger',
            onclick: () => {
              const r = API.call('stop', { profile: p.id });
              if (r.ok === false) toast(r.error, 'err'); else toast(t('stopping') + '...', 'ok');
              App.refreshProfiles(); renderList();
            },
          }, icon('stop'), t('stop_server')));
        } else {
          actions.appendChild(h('button', {
            class: 'btn sm success',
            onclick: () => {
              const r = API.call('start', { profile: p.id });
              if (r.ok === false) {
                const friendly = String(r.error || '').indexOf('not enough free RAM') >= 0 ? t('err_ram_low') : r.error;
                toast(t('err_start_fail') + ': ' + friendly, 'err');
              }
              else { toast(t('starting') + '...', 'ok'); }
              App.refreshProfiles(); renderList();
            },
          }, icon('play'), t('start_server')));
        }
        if (p.id !== App.activeProfile) {
          actions.appendChild(h('button', {
            class: 'btn sm primary',
            onclick: () => { App.setProfile(p.id); close(); },
          }, t('switch_to')));
        }
        listEl.appendChild(h('div', { class: 'fm-row' },
          h('span', { class: 'fm-ic', style: 'color:var(--green)' }, icon('world')),
          h('div', { class: 'fm-main' },
            h('div', { class: 'fm-name' }, p.name + (p.id === App.activeProfile ? '  ✓' : '')),
            h('div', { class: 'fm-meta' }, h('span', { class: 'm' },
              t('port') + ' ' + (p.port || '—') + ' · ' + t(p.state)
              + (p.id === 'default' ? ' · ' + t('default_no_delete') : '')))),
          actions));
      }
    }
    renderList();
    const nameIn = h('input', { class: 'text-input', type: 'text', placeholder: t('server_name_ph'), autocomplete: 'off', spellcheck: 'false' });
    /* v2.8: the create dialog also asks for the UDP port - empty = auto pick */
    const portIn = h('input', {
      class: 'text-input mono-ltr', type: 'text', inputmode: 'numeric',
      placeholder: t('server_port_ph'), autocomplete: 'off', spellcheck: 'false',
    });
    portIn.addEventListener('input', () => {
      portIn.value = portIn.value.replace(/[^0-9]/g, '').slice(0, 5);
    });
    const addBtn = h('button', {
      class: 'btn primary block mt',
      onclick: () => {
        const name = nameIn.value.trim();
        if (!name) { toast(t('server_name'), 'err'); return; }
        const portTxt = portIn.value.trim();
        let port = 0;
        if (portTxt) {
          port = parseInt(portTxt, 10);
          if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            toast(t('err_port_range'), 'err');
            return;
          }
        }
        addBtn.disabled = true;
        const r = API.call('profiles.create', { name, port });
        if (r.ok === false) { toast(r.error, 'err'); addBtn.disabled = false; return; }
        toast(t('server_added') + ' (:' + (r.port || '—') + ')', 'ok');
        nameIn.value = '';
        portIn.value = '';
        addBtn.disabled = false;
        App.refreshProfiles();
        App.setProfile(r.id);
        close();
      },
    }, icon('plus'), t('add_server'));
    const close = modal({
      title: t('servers'),
      body: h('div', {},
        listEl,
        h('div', { class: 'row', style: 'gap:8px;align-items:flex-start' },
          h('label', { class: 'field mt', style: 'flex:1.5' }, h('span', { class: 'fl' }, t('server_name')), nameIn),
          h('label', { class: 'field mt', style: 'flex:1' }, h('span', { class: 'fl' }, t('server_port')), portIn)),
        addBtn,
        h('div', { class: 'hint mt' }, t('servers_hint'))),
      actions: [{ label: t('close'), class: 'btn ghost' }],
    });
  }

  const isRunning = () => {
    const s = (App.status || {}).state;
    return s === 'running' || s === 'starting';
  };

  /* hero */
  const uptimeEl = h('span', { class: 'v' }, '0s');
  const playersEl = h('span', { class: 'v' }, String(App.playersOnline.length));
  const ramEl = h('span', { class: 'v' }, '—');
  const freeEl = h('span', { class: 'v' }, fmtBytes(st.freeSpace));

  const startBtn = h('button', { class: 'btn success', onclick: () => doStart() }, icon('play'), t('start_server'));
  const stopBtn = h('button', { class: 'btn danger', onclick: () => doStop() }, icon('stop'), t('stop_server'));
  const restartBtn = h('button', { class: 'btn', onclick: () => doRestart() }, icon('restart'), t('restart_server'));
  const termBtn = h('button', { class: 'btn', onclick: () => Terminal.open() }, icon('terminal'), t('open_terminal'));

  /* Both button groups stay in the DOM; only visibility flips —
   * the hero is never rebuilt, so it can't flash or shrink away. */
  const startGrp = h('div', { class: 'row wrap' }, startBtn, termBtn);
  const runGrp = h('div', { class: 'row wrap' }, stopBtn, restartBtn,
    h('button', { class: 'btn', onclick: () => Terminal.open() }, icon('terminal'), t('open_terminal')));

  const heroTitleEl = h('div', { class: 'h-title' }, (App.activeProfileObj() || {}).name || t('dash_title'));
  const hero = h('div', { class: 'hero' },
    heroTitleEl,
    h('div', { class: 'h-sub' }, t('dash_sub')),
    h('div', { class: 'h-stats' },
      h('div', { class: 'h-stat' }, uptimeEl, h('div', { class: 'k' }, t('uptime'))),
      h('div', { class: 'h-stat' }, playersEl, h('div', { class: 'k' }, t('players'))),
      h('div', { class: 'h-stat' }, ramEl, h('div', { class: 'k' }, t('ram_usage'))),
      h('div', { class: 'h-stat' }, freeEl, h('div', { class: 'k' }, t('free_space')))),
    h('div', { class: 'row wrap', style: 'gap:8px' }, startGrp, runGrp));

  /* slot for the crash card — filled/cleared in place, no rebuild */
  const stateSlot = h('div');

  function renderCrashCard() {
    stateSlot.innerHTML = '';
    const s = App.status || {};
    if (App.startError && !['running', 'starting'].includes(s.state)) {
      stateSlot.appendChild(h('div', { class: 'card', style: 'border-color:rgba(243,18,96,.5);box-shadow:0 10px 34px -14px rgba(243,18,96,.35)' },
        h('div', { class: 'card-title', style: 'color:#ff6d9c' }, icon('info'), t('err_start_fail')),
        h('div', { class: 'mono-ltr', style: 'font-size:12px;color:#ff6d9c;word-break:break-all' }, App.startError)));
    }
    if (s.state === 'crashed' && s.lastError) {
      stateSlot.appendChild(h('div', { class: 'card', style: 'border-color:rgba(243,18,96,.5);box-shadow:0 10px 34px -14px rgba(243,18,96,.35)' },
        h('div', { class: 'card-title', style: 'color:#ff6d9c' }, icon('info'), t('last_crash')),
        h('div', { class: 'mono-ltr', style: 'font-size:12px;color:#ff6d9c;word-break:break-all' }, s.lastError)));
    }
  }

  const hintCard = h('div', { class: 'card hint' });
  function renderHint() {
    hintCard.textContent = isRunning() ? t('tip_console') : t('not_installed_hint') + ' ' + t('start_hint');
  }

  function applyState() {
    const run = isRunning();
    startGrp.style.display = run ? 'none' : 'flex';
    runGrp.style.display = run ? 'flex' : 'none';
    renderCrashCard();
    renderHint();
  }
  applyState();

  function doStart() {
    const res = API.call('start');
    if (res.ok === false) {
      /* persistent, visible failure - a 2s toast was easy to miss and made
       * people think "I started server 2 but server 1 is the one running" */
      App.startError = res.error || t('error');
      const r = API.call('status');
      if (r.ok) { App.status = r; }
      renderCrashCard();
      /* friendly, localized text for the most common failure */
      const friendly = String(App.startError).indexOf('not enough free RAM') >= 0 ? t('err_ram_low') : App.startError;
      toast(t('err_start_fail') + ': ' + friendly, 'err');
    } else {
      App.startError = null;
      renderCrashCard();
      Console.clearViews();
      toast(t('starting') + '...', 'ok');
    }
  }
  function doStop() {
    API.call('stop');
    toast(t('stopping') + '...');
  }
  function doRestart() {
    confirmModal(t('restart_server'), t('update_note'), t('restart_server'), () => { API.call('restart'); });
  }

  /* info card */
  const pharInfo = info.phar || {};
  const kvWrap = h('div', { class: 'kv2col' },
    kv('NG ' + t('version'), bundle.ngVersion || '—'),
    kv(t('mc_support'), bundle.mcSupport || '—'),
    kv(t('php_version'), bundle.phpVersion || '—'),
    kv(t('app_version'), info.appVersion || '—'),
    kv('Phar', pharInfo.exists ? fmtBytes(pharInfo.size) : '—'),
    kv('CPU', ((info.device || {}).abi || '—') + ' / ' + ((info.device || {}).model || '')),
    kv('Android', (info.device || {}).android || '—'),
    kv(t('ram_usage') + ' (device)', fmtBytes((info.device || {}).totalRam || 0)));
  const infoCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('info'), t('server_info')),
    kvWrap);

  function kv(k, v) {
    return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  }

  /* mini console */
  const mini = h('div', { class: 'console mini-attach' });
  const jumpBtn = h('button', { class: 'jump-bottom hidden' });
  const consoleShell = h('div', { class: 'console-shell', style: 'flex:none;height:248px' }, mini, jumpBtn);
  const consoleCard = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('terminal'), t('console_title')),
      h('button', { class: 'btn sm', onclick: () => App.navigate('console') }, t('nav_console'))),
    h('div', { class: 'mt' }, consoleShell));

  jumpBtn.addEventListener('click', () => {
    mini.scrollTop = mini.scrollHeight;
  });

  const hint = hintCard;

  /* ---- consoles of the OTHER running servers (collapsible cards) ---- */
  const bgBox = h('div', {});
  const bgCards = {}; // profileId -> card handle

  function makeBgCard(p) {
    const logEl = h('div', { class: 'console', style: 'height:170px' });
    const upEl = h('span', { class: 'badge', style: 'font-size:11px' }, t(p.state));
    const input = h('input', {
      class: 'cmd-input', type: 'text', dir: 'ltr',
      placeholder: t('command_placeholder'), autocomplete: 'off', spellcheck: 'false',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (!v) return;
      const r = API.call('command', { text: v, profile: p.id });
      if (r && r.ok === false) { toast(r.error || t('error'), 'err'); return; }
      addLine('> ' + v);
      input.value = '';
    });
    const head = h('div', { class: 'spread' },
      h('div', { class: 'row', style: 'gap:8px;align-items:center;min-width:0' },
        h('span', { class: 'pill bare st-' + p.state, style: 'padding:0' }, h('span', { class: 'pc-dot' })),
        h('span', { style: 'font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, p.name)),
      h('div', { class: 'row', style: 'gap:6px;flex:none' },
        upEl,
        h('button', {
          class: 'btn sm',
          onclick: () => App.setProfile(p.id),
        }, t('switch_to')),
        h('button', {
          class: 'btn sm danger',
          onclick: () => { API.call('stop', { profile: p.id }); toast(t('stopping') + '...'); },
        }, t('stop_server'))));
    const shell = h('div', { class: 'console-shell', style: 'flex:none' }, logEl,
      h('div', { class: 'cmd-input-row' }, h('span', { class: 'prompt' }, '❯'), input));
    const card = collapsibleCard(head, null, [shell], 'pm_bg_' + p.id);
    function addLine(text) {
      const first = logEl.firstElementChild;
      if (first && first.classList.contains('empty')) first.remove();
      const div = h('div', { class: 'ln' });
      div.innerHTML = ansiToHtml(text);
      logEl.appendChild(div);
      while (logEl.childElementCount > 120 && logEl.firstElementChild) logEl.firstElementChild.remove();
      logEl.scrollTop = logEl.scrollHeight;
    }
    addLine('—');
    return {
      card: card.card,
      addLine,
      wipe() { logEl.innerHTML = ''; addLine('—'); },
      setState(state, uptimeSec) {
        upEl.textContent = t(state) + (uptimeSec > 0 ? ' · ' + fmtUptime(uptimeSec) : '');
        upEl.className = 'badge st-badge-' + state;
      },
    };
  }

  function syncBg(profiles) {
    const others = profiles.filter((p) => p.id !== App.activeProfile
      && ['running', 'starting', 'stopping'].includes(p.state));
    for (const id of Object.keys(bgCards)) {
      if (!others.find((p) => p.id === id)) {
        bgCards[id].card.remove();
        delete bgCards[id];
      }
    }
    for (const p of others) {
      if (!bgCards[p.id]) {
        bgCards[p.id] = makeBgCard(p);
        bgBox.appendChild(bgCards[p.id].card);
      }
      bgCards[p.id].setState(p.state, p.uptimeSec);
    }
  }

  App.onProfiles = (profiles) => {
    renderBar();
    syncBg(profiles);
    const cur = profiles.find((p) => p.id === App.activeProfile);
    if (cur) heroTitleEl.textContent = cur.name;
  };
  App.onBgLines = (id, lines) => {
    const c = bgCards[id];
    if (!c) return;
    for (const pair of lines) c.addLine(pair[1]);
  };
  App.onBgReset = (id) => { if (bgCards[id]) bgCards[id].wipe(); };
  syncBg(App.profiles);

  root.appendChild(profileBar);
  root.appendChild(hero);
  root.appendChild(stateSlot);
  root.appendChild(infoCard);
  root.appendChild(consoleCard);
  root.appendChild(bgBox);
  root.appendChild(hint);

  const tgt = Console.attach(mini, 120, { jumpBtn });

  /* live updates without rerender */
  App.onStatus = (s) => {
    uptimeEl.textContent = fmtUptime(s.uptimeSec);
    ramEl.textContent = s.rssKb ? fmtBytes(s.rssKb * 1024) : '—';
    freeEl.textContent = fmtBytes(s.freeSpace);
    playersEl.textContent = String(App.playersOnline.length);
  };
  App.onPlayers = () => {
    playersEl.textContent = String(App.playersOnline.length);
  };
  /* state flips update the hero in place — the panel never disappears */
  App.onState = (state, prev) => {
    /* a start that worked clears the persistent failure card */
    if (['running', 'starting'].includes(state)) {
      if (App.startError) { App.startError = null; renderCrashCard(); }
      if (prev === 'idle' || prev === 'stopped' || prev === 'crashed') renderCrashCard();
    }
    if (state === 'stopped' || state === 'idle') {
      /* keep showing the last start error if the start never succeeded */
      renderCrashCard();
    }
    applyState();
  };
  App.cleanup.push(() => {
    Console.detach(tgt);
    App.onStatus = null;
    App.onPlayers = null;
    App.onState = null;
    App.onProfiles = null;
    App.onBgLines = null;
    App.onBgReset = null;
  });
};

/* ================= Console view (Termux-like, fixed viewport) ================= */
Views.console = (root) => {
  root.classList.add('console-page');

  const headerRow = h('div', { class: 'spread', style: 'flex:none;margin-bottom:10px' },
    h('div', { class: 'card-title', style: 'margin:0' }, icon('terminal'), t('console_title')),
    h('div', { class: 'row' },
      h('button', { class: 'icon-btn plain', title: t('copy_log'), onclick: () => Console.copyLast(200) }, icon('copy')),
      h('button', { class: 'icon-btn plain', title: t('clear_view'), onclick: () => Console.clearViews() }, icon('trash')),
      h('button', { class: 'icon-btn plain', title: t('export_log'), onclick: exportLog }, icon('download')),
      h('button', { class: 'icon-btn plain', title: t('terminal'), onclick: () => Terminal.open() }, icon('terminal'))));

  const screen = h('div', { class: 'console' });
  const jumpBtn = h('button', { class: 'jump-bottom hidden' });
  const input = h('input', {
    class: 'cmd-input', type: 'text',
    placeholder: t('command_placeholder'), autocomplete: 'off', spellcheck: 'false',
  });

  const shell = h('div', { class: 'console-shell' },
    screen,
    jumpBtn,
    h('div', { class: 'cmd-input-row' },
      h('span', { class: 'prompt' }, '❯'),
      input,
      h('button', { class: 'btn sm primary', onclick: () => doSend() }, t('send'))));

  jumpBtn.addEventListener('click', () => {
    screen.scrollTop = screen.scrollHeight;
  });

  function exportLog() {
    const res = API.call('logs.list');
    const entries = (res.entries || []);
    if (!entries.length) { toast(t('console_empty'), 'err'); return; }
    API.callAsync('download.save', { path: 'logs/' + entries[0].name, suggested: entries[0].name })
      .then(() => toast(t('saved'), 'ok'))
      .catch((e) => toast(e.error || t('error'), 'err'));
  }

  /* quick commands */
  const quick = h('div', { class: 'quick-cmds', style: 'flex:none' });
  ['help', 'status', 'list', 'gc', 'save-all', 'version'].forEach((c) => {
    quick.appendChild(h('button', { class: 'quick-cmd', onclick: () => Console.send(c) }, c));
  });
  quick.appendChild(h('button', {
    class: 'quick-cmd', style: 'color:var(--red)',
    onclick: () => confirmModal(t('stop_server'), t('delete_confirm'), t('stop_server'), () => Console.send('stop'), true),
  }, 'stop'));

  const history = JSON.parse(localStorage.getItem('pm_cmd_hist') || '[]');
  let histIdx = -1;
  function doSend() {
    const v = input.value.trim();
    if (!v) return;
    if (Console.send(v)) {
      history.unshift(v);
      if (history.length > 30) history.pop();
      localStorage.setItem('pm_cmd_hist', JSON.stringify(history));
      histIdx = -1;
      input.value = '';
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { doSend(); return; }
    if (e.key === 'ArrowUp' && history.length) {
      histIdx = Math.min(histIdx + 1, history.length - 1);
      input.value = history[histIdx];
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && history.length) {
      histIdx = Math.max(histIdx - 1, -1);
      input.value = histIdx === -1 ? '' : history[histIdx];
      e.preventDefault();
    }
  });

  root.appendChild(headerRow);
  root.appendChild(shell);
  root.appendChild(quick);

  const tgt = Console.attach(screen, 900, { jumpBtn });
  App.cleanup.push(() => { Console.detach(tgt); });
};
