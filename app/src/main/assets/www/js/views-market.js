/* views-market.js - Poggit plugin market (Tools > Plugin market) v2.8
 * The classic Poggit site/API is offline since late 2026; every approved
 * release now lives in the static GitHub repo poggit/release-archive
 * (author/Plugin/Version/info.json + phar). The app ships a compact index
 * of that archive and searches it offline; downloads come straight from
 * raw.githubusercontent.com.
 *
 * v2.8 market overhaul:
 *  - every card shows the plugin's real IMAGE when the release has one
 *    (icon_url in info.json, fetched + disk-cached natively, lazy-loaded)
 *  - tapping a card opens a detail sheet with the plugin's DESCRIPTION
 *    (its GitHub README), stats, license, categories and the installer
 *  - richer cards: author, tagline, downloads/score/API/category chips */

'use strict';

/* ---------- tiny helpers ---------- */
function mkShort(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
/* deterministic hue from a string - for letter avatars / category chips */
function mkHue(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x % 360;
}
function mkAvatar(name, cls) {
  const hue = mkHue(name || '?');
  const letter = (name || '?').replace(/^[^A-Za-z0-9]+/, '').charAt(0).toUpperCase() || '?';
  return h('div', { class: 'mk-avatar ' + (cls || ''), style: 'background:linear-gradient(135deg,hsl(' + hue + ',55%,42%),hsl(' + ((hue + 40) % 360) + ',60%,30%))' }, letter);
}
/* icons load lazily through the native cache; keyed per plugin+release */
const MK_ICON_CACHE = {};

/* ---------- super-small markdown renderer (READMEs) ----------
 * escape-first by construction: text is escaped, then we add back only the
 * few tags we generate ourselves. */
function mkMd(src) {
  if (!src) return '';
  let s = String(src).replace(/\r\n?/g, '\n');
  /* strip anything that looks like raw html/script before escaping */
  s = s.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
       .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, '')
       .replace(/<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi, '');
  s = esc(s);
  const codeBlocks = [];
  /* fenced code blocks first (keep original text) */
  s = s.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
  });
  /* images: only https, lazy */
  s = s.replace(/!\[([^\]]*)\]\((https:[^)\s]+)\)/g,
    '<img class="mk-md-img" loading="lazy" alt="$1" src="$2">');
  /* links: [text](https...) -> tappable span via openUrl */
  s = s.replace(/\[([^\]]+)\]\((https:[^)\s]+)\)/g,
    '<span class="mk-md-link" data-href="$2">$1</span>');
  /* inline code */
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  /* bold */
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  /* headings + lists, line-based */
  const lines = s.split('\n');
  let out = '', inUl = false, para = [];
  const flushPara = () => {
    if (para.length) {
      out += '<p>' + para.join('<br>') + '</p>';
      para = [];
    }
  };
  const closeUl = () => { if (inUl) { out += '</ul>'; inUl = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeUl(); continue; }
    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      flushPara(); closeUl();
      const idx = parseInt(line.trim().replace(/\u0000CODE|\u0000/g, ''), 10);
      out += '<pre class="mk-md-code">' + codeBlocks[idx] + '</pre>';
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flushPara(); closeUl();
      const lvl = Math.min(hm[1].length + 2, 6);
      out += '<h' + lvl + '>' + hm[2] + '</h' + lvl + '>';
      continue;
    }
    const lm = line.match(/^\s*[-*+]\s+(.*)$/);
    if (lm) {
      flushPara();
      if (!inUl) { out += '<ul>'; inUl = true; }
      out += '<li>' + lm[1] + '</li>';
      continue;
    }
    const nm = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (nm) {
      flushPara();
      if (!inUl) { out += '<ul>'; inUl = true; }
      out += '<li>' + nm[1] + '</li>';
      continue;
    }
    closeUl();
    para.push(line);
  }
  flushPara(); closeUl();
  return out;
}

Views.market = (root) => {
  let sort = localStorage.getItem('pm_market_sort') || 'downloads';
  let query = '';
  let busy = {};

  const metaEl = h('div', { class: 'mk-meta hint', style: 'margin-top:6px' }, t('loading'));
  const searchIn = h('input', {
    class: 'text-input', type: 'text', placeholder: t('mk_search_ph'),
    autocomplete: 'off', spellcheck: 'false',
  });
  const searchWrap = h('div', { class: 'mk-search' },
    h('span', { class: 'mk-search-ic' }, icon('search')),
    searchIn,
    h('button', {
      class: 'mk-search-clear hidden',
      onclick: () => { searchIn.value = ''; query = ''; load(); },
    }, icon('x')));
  const seg = h('div', { class: 'segmented', style: 'margin-top:10px' });
  const results = h('div', { class: 'mk-list', style: 'margin-top:10px' });

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('market'), t('market_title')),
    h('div', { class: 'hint mb' }, t('market_hint')),
    searchWrap,
    seg,
    metaEl));
  root.appendChild(results);

  const running = App.status && ['running', 'starting'].includes(App.status.state);
  if (running) {
    root.appendChild(h('div', { class: 'card', style: 'border-color:rgba(245,185,66,.45)' },
      h('div', { class: 'hint', style: 'color:var(--yellow)' }, '⚠ ' + t('mk_running_note'))));
  }

  /* sort segmented control */
  const SORTS = [['downloads', 'mk_sort_downloads'], ['name', 'mk_sort_name'], ['updated', 'mk_sort_updated']];
  function paintSeg() {
    seg.innerHTML = '';
    for (const [id, key] of SORTS) {
      seg.appendChild(h('button', {
        class: sort === id ? 'active' : '',
        onclick: () => {
          sort = id;
          try { localStorage.setItem('pm_market_sort', id); } catch (e) { /* private mode */ }
          paintSeg();
          load();
        },
      }, h('span', {}, t(key))));
    }
  }
  paintSeg();

  function metaText(meta) {
    const d = new Date((meta.built || 0));
    return t('mk_meta').replace('{n}', String(meta.count || 0))
      .replace('{date}', isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10));
  }

  function load() {
    const res = API.call('market.search', { q: query, sort, limit: 40 });
    results.innerHTML = '';
    if (searchIn.value.trim()) searchWrap.querySelector('.mk-search-clear').classList.remove('hidden');
    else searchWrap.querySelector('.mk-search-clear').classList.add('hidden');
    if (res.ok === false) {
      results.appendChild(h('div', { class: 'card' },
        h('div', { class: 'hint', style: 'color:var(--red)' }, res.error || t('error'))));
      return;
    }
    const list = res.results || [];
    if (!list.length) {
      results.appendChild(h('div', { class: 'card' },
        h('div', { class: 'empty-note' }, t('mk_no_results'))));
      return;
    }
    let i = 0;
    for (const p of list) {
      const card = row(p, i++);
      results.appendChild(card);
    }
    loadIcons(list);
  }

  /* -------- lazy plugin images: one native fetch per card, cached -------- */
  function loadIcons(list) {
    for (const p of list) {
      const key = p.n + '@' + p.v;
      if (MK_ICON_CACHE[key] !== undefined) {
        const el = results.querySelector('[data-mk="' + cssEsc(p.n + '|' + p.v) + '"] .mk-avatar-slot');
        if (el && MK_ICON_CACHE[key]) applyIcon(el, MK_ICON_CACHE[key]);
        continue;
      }
      const reqId = 'mki' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      API.callAsync('market.fetch', { name: p.n, ph: pathFor(p, p.v), reqId }).then((r) => {
        const data = r && r.ok ? (r.iconData || null) : null;
        MK_ICON_CACHE[key] = data;
        if (!data) return; /* keep the letter avatar */
        const el = results.querySelector('[data-mk="' + cssEsc(p.n + '|' + p.v) + '"] .mk-avatar-slot');
        if (el) applyIcon(el, data);
      }).catch(() => { /* network hiccup - avatar stays */ });
    }
  }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }
  function applyIcon(slot, dataUrl) {
    slot.innerHTML = '';
    slot.appendChild(h('img', { class: 'mk-img', src: dataUrl, alt: '', loading: 'lazy' }));
  }

  function pathFor(p, v) {
    const versions = (p.vp && p.vp.length ? p.vp : [[p.v, p.ph]]);
    const hit = versions.find((x) => x[0] === v);
    return hit ? hit[1] : p.ph;
  }

  /* ---------------- list card ---------------- */
  function row(p, idx) {
    const versions = (p.vp && p.vp.length ? p.vp : [[p.v, p.ph]]);
    const cat = (p.c && p.c.category_name) ? p.c.category_name : '';
    const hue = mkHue(cat || p.n);
    const nameEl = h('div', { class: 'mk-name' }, p.n);
    if (p.off) nameEl.appendChild(h('span', { class: 'mk-badge off' }, icon('shield'), t('mk_official')));
    if (p.ab) nameEl.appendChild(h('span', { class: 'mk-badge ab' }, t('mk_abandoned')));
    if (/\b(beta|alpha|rc)\b/i.test(String(p.v || ''))) {
      nameEl.appendChild(h('span', { class: 'mk-badge pre' }, 'pre'));
    }

    const verSel = h('select', { class: 'text-input mk-ver', title: 'version' });
    for (const [v] of versions) verSel.appendChild(h('option', { value: v, selected: v === p.v }, 'v' + v));

    const prog = h('div', { class: 'progress mk-prog', style: 'display:none' }, h('div', { style: 'width:0%' }));
    const btn = h('button', { class: 'btn sm primary mk-btn' }, icon('download'), t('mk_install'));

    const card = h('div', {
      class: 'mk-card', 'data-mk': p.n + '|' + p.v,
      style: 'animation-delay:' + Math.min(idx * 35, 500) + 'ms',
      onclick: (e) => {
        if (e.target.closest('.mk-ver') || e.target.closest('.mk-btn')) return;
        openDetail(p);
      },
    },
    h('div', { class: 'mk-avatar-slot' }, mkAvatar(p.n)),
    h('div', { class: 'mk-main' },
      nameEl,
      h('div', { class: 'mk-author mono-ltr' }, p.a),
      p.t ? h('div', { class: 'mk-tag' }, p.t) : null,
      h('div', { class: 'mk-chips' },
        h('span', { class: 'mk-chip' }, icon('download'), mkShort(p.dl || p.d || 0)),
        p.s ? h('span', { class: 'mk-chip star' }, '★', String(p.s)) : null,
        p.api ? h('span', { class: 'mk-chip api mono-ltr' }, apiText(p.api)) : null,
        cat ? h('span', { class: 'mk-chip cat', style: 'color:hsl(' + hue + ',70%,72%);background:hsla(' + hue + ',70%,60%,.14)' }, cat) : null),
      h('div', { class: 'mk-actions' }, verSel, btn, prog)));

    btn.addEventListener('click', () => install(p, pathFor(p, verSel.value), verSel.value, btn, prog));
    return card;
  }

  /* "{'from': '5.0.0', 'to': '5.36.0'}" -> "5.0.0+" (short) */
  function apiText(api) {
    const m = String(api || '').match(/'from'\s*:\s*'([^']+)'[\s\S]*?'to'\s*:\s*'([^']+)'/);
    if (!m) return 'API';
    const to = m[2];
    const from = m[1];
    /* same prefix family -> just show the range tail */
    return 'API ' + from + (to && to !== from ? '–' + to : '');
  }

  /* ---------------- detail sheet ---------------- */
  function openDetail(p) {
    const versions = (p.vp && p.vp.length ? p.vp : [[p.v, p.ph]]);
    const verSel = h('select', { class: 'text-input mk-ver', title: 'version' });
    for (const [v] of versions) verSel.appendChild(h('option', { value: v, selected: v === p.v }, 'v' + v));
    const prog = h('div', { class: 'progress mk-prog', style: 'display:none' }, h('div', { style: 'width:0%' }));
    const btn = h('button', { class: 'btn primary mk-btn' }, icon('download'), t('mk_install'));

    const iconSlot = h('div', { class: 'mk-avatar-slot big' }, mkAvatar(p.n, 'big'));
    const cached = MK_ICON_CACHE[p.n + '@' + p.v];
    if (cached) { iconSlot.innerHTML = ''; iconSlot.appendChild(h('img', { class: 'mk-img', src: cached, alt: '' })); }

    const catWrap = h('div', { class: 'mk-chips' });
    const stats = h('div', { class: 'mk-stats' });
    const descTitle = h('div', { class: 'mk-desc-title' }, icon('file'), t('mk_desc'));
    const desc = h('div', { class: 'mk-desc' }, h('div', { class: 'mk-desc-loading' }, t('mk_loading_desc')));

    const body = h('div', {},
      h('div', { class: 'mk-hero' },
        iconSlot,
        h('div', { class: 'mk-hero-main' },
          h('div', { class: 'mk-name big' }, p.n),
          h('div', { class: 'mk-author mono-ltr' }, p.a),
          h('div', { class: 'mk-chips' },
            h('span', { class: 'mk-chip' }, icon('download'), mkShort(p.dl || p.d || 0) + ' ' + t('mk_downloads')),
            p.s ? h('span', { class: 'mk-chip star' }, '★ ' + p.s) : null,
            p.ab ? h('span', { class: 'mk-chip warn' }, t('mk_abandoned')) : null,
            p.off ? h('span', { class: 'mk-chip good' }, t('mk_official')) : null,
            h('span', { class: 'mk-chip mono-ltr' }, 'v' + p.v)))),
      stats,
      h('div', { class: 'row mt', style: 'gap:8px;align-items:center' }, verSel, btn, prog),
      catWrap,
      descTitle,
      desc);

    /* install (same flow as the card) */
    btn.addEventListener('click', () => {
      if (busy[p.n]) return;
      if (App.status && ['running', 'starting'].includes(App.status.state)) {
        toast(t('stopped_first'), 'err');
        return;
      }
      busy[p.n] = true;
      btn.disabled = true;
      prog.style.display = 'block';
      prog.firstChild.style.width = '6%';
      API.callAsync('market.install', {
        path: pathFor(p, verSel.value), name: p.n, version: verSel.value,
        reqId: 'mk' + Date.now() + Math.floor(Math.random() * 1000),
      }, (percent) => {
        if (percent >= 0) prog.firstChild.style.width = Math.max(6, percent) + '%';
      }).then((r) => {
        busy[p.n] = false;
        prog.style.display = 'none';
        btn.disabled = false;
        if (r.ok) {
          prog.firstChild.style.width = '100%';
          toast(t('mk_installed').replace('{f}', r.name || p.n), 'ok');
          btn.innerHTML = '';
          btn.appendChild(icon('check'));
          btn.appendChild(h('span', {}, t('mk_done')));
          MK_ICON_CACHE[p.n + '@' + verSel.value] = MK_ICON_CACHE[p.n + '@' + p.v];
        } else toast(r.error || t('error'), 'err');
      }).catch((e) => {
        busy[p.n] = false;
        prog.style.display = 'none';
        btn.disabled = false;
        toast((e && e.error) || t('error'), 'err');
      });
    });

    const close = modal({
      title: t('mk_details'),
      body,
      actions: [{ label: t('close'), class: 'btn ghost' }],
    });

    /* enrich: info.json (categories, license, repo) + README description */
    API.callAsync('market.fetch', {
      name: p.n, ph: pathFor(p, p.v), readme: true,
      reqId: 'mkd' + Date.now() + Math.floor(Math.random() * 1e6),
    }).then((r) => {
      if (!r || r.ok === false) {
        desc.innerHTML = '';
        desc.appendChild(h('div', { class: 'hint' }, p.t || t('mk_no_desc')));
        return;
      }
      const info = r.info || {};
      if (r.iconData && !cached) {
        MK_ICON_CACHE[p.n + '@' + p.v] = r.iconData;
        iconSlot.innerHTML = '';
        iconSlot.appendChild(h('img', { class: 'mk-img', src: r.iconData, alt: '' }));
        const el = results.querySelector('[data-mk="' + cssEsc(p.n + '|' + p.v) + '"] .mk-avatar-slot');
        if (el) applyIcon(el, r.iconData);
      }
      /* stats grid */
      stats.innerHTML = '';
      stats.appendChild(h('div', { class: 'mk-stat' }, h('span', { class: 'v mono-ltr' }, mkShort(p.dl || p.d || 0)), h('span', { class: 'k' }, t('mk_downloads'))));
      stats.appendChild(h('div', { class: 'mk-stat' }, h('span', { class: 'v mono-ltr' }, p.s ? '★' + p.s : '—'), h('span', { class: 'k' }, t('mk_score'))));
      stats.appendChild(h('div', { class: 'mk-stat' }, h('span', { class: 'v' }, p.date ? fmtRel(p.date * 1000) : '—'), h('span', { class: 'k' }, t('mk_updated'))));
      stats.appendChild(h('div', { class: 'mk-stat' }, h('span', { class: 'v mono-ltr' }, info.license || '—'), h('span', { class: 'k' }, t('mk_license'))));
      /* categories + keywords chips */
      catWrap.innerHTML = '';
      let chips = 0;
      for (const c of (info.categories || [])) {
        if (!c) continue;
        const hue2 = mkHue(c);
        catWrap.appendChild(h('span', { class: 'mk-chip cat', style: 'color:hsl(' + hue2 + ',70%,72%);background:hsla(' + hue2 + ',70%,60%,.14)' }, c));
        chips++;
      }
      for (const k of (info.keywords || [])) {
        if (chips >= 7) break;
        catWrap.appendChild(h('span', { class: 'mk-chip kw mono-ltr' }, k));
        chips++;
      }
      if (info.repo) {
        catWrap.appendChild(h('button', {
          class: 'mk-chip repo',
          onclick: () => {
            const u = 'https://github.com/' + info.repo;
            const res = API.call('openUrl', { url: u });
            if (res && res.ok === false) toast(res.error, 'err');
          },
        }, icon('globe'), t('mk_open_repo')));
      }
      /* description: README > tagline > nothing */
      const md = r.readme;
      desc.innerHTML = '';
      if (md) {
        desc.appendChild(h('div', { class: 'mk-md', html: mkMd(md) }));
      } else if (info.tagline || p.t) {
        desc.appendChild(h('div', { class: 'hint' }, info.tagline || p.t));
      } else {
        desc.appendChild(h('div', { class: 'hint' }, t('mk_no_desc')));
      }
    }).catch(() => {
      desc.innerHTML = '';
      desc.appendChild(h('div', { class: 'hint' }, p.t || t('mk_no_desc')));
    });
  }

  /* shared card install (kept from v2.7) */
  function install(p, path, version, btn, prog) {
    if (busy[p.n]) return;
    if (App.status && ['running', 'starting'].includes(App.status.state)) {
      toast(t('stopped_first'), 'err');
      return;
    }
    busy[p.n] = true;
    btn.disabled = true;
    prog.style.display = 'block';
    prog.firstChild.style.width = '6%';
    API.callAsync('market.install', {
      path, name: p.n, version, reqId: 'mk' + Date.now() + Math.floor(Math.random() * 1000),
    }, (percent) => {
      if (percent >= 0) prog.firstChild.style.width = Math.max(6, percent) + '%';
    }).then((r) => {
      busy[p.n] = false;
      prog.style.display = 'none';
      btn.disabled = false;
      if (r.ok) {
        prog.firstChild.style.width = '100%';
        toast(t('mk_installed').replace('{f}', r.name || p.n), 'ok');
        btn.innerHTML = '';
        btn.appendChild(icon('check'));
        btn.appendChild(h('span', {}, t('mk_done')));
      } else {
        toast(r.error || t('error'), 'err');
      }
    }).catch((e) => {
      busy[p.n] = false;
      prog.style.display = 'none';
      btn.disabled = false;
      toast((e && e.error) || t('error'), 'err');
    });
  }

  /* live search (debounced) */
  let deb = 0;
  searchIn.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      query = searchIn.value.trim();
      load();
    }, 260);
  });

  /* boot: meta + default (popular) list */
  const meta = API.call('market.meta');
  if (meta.ok && meta.meta) metaEl.textContent = metaText(meta.meta);
  load();
};
