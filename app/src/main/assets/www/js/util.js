/* util.js - icons, helpers, ANSI parser, modal, toast */

'use strict';

/* ---------- tiny DOM helpers ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}
function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- formatting ---------- */
function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtRel(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t('rel_now');
  if (m < 60) return t('rel_min').replace('{n}', m);
  const h = Math.floor(m / 60);
  if (h < 24) return t('rel_hour').replace('{n}', h);
  const d = Math.floor(h / 24);
  if (d < 30) return t('rel_day').replace('{n}', d);
  return fmtDate(ms).split(' ')[0];
}
function fmtUptime(sec) {
  if (!sec || sec < 0) sec = 0;
  const d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60), ss = Math.floor(sec % 60);
  if (d > 0) return d + 'd ' + hh + 'h ' + mm + 'm';
  if (hh > 0) return hh + 'h ' + mm + 'm ' + ss + 's';
  if (mm > 0) return mm + 'm ' + ss + 's';
  return ss + 's';
}
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------- icons (inline SVG, stroke-based) ---------- */
const ICONS = {
  home: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>',
  terminal: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6.5 9 3.5 3-3.5 3"/><path d="M12.5 15H17"/></svg>',
  folder: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  puzzle: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5a1.8 1.8 0 1 1 3.6 0c0 .6-.3 1-.6 1.4h3.4c.9 0 1.6.7 1.6 1.6v3.2c.4-.3.9-.5 1.5-.5a1.8 1.8 0 1 1 0 3.6c-.6 0-1.1-.2-1.5-.5v3.7c0 .9-.7 1.6-1.6 1.6h-3.6c.3-.4.6-.9.6-1.4a1.8 1.8 0 1 0-3.6 0c0 .5.3 1 .6 1.4H6.6c-.9 0-1.6-.7-1.6-1.6v-3.4c-.4.3-1 .6-1.6.6a1.8 1.8 0 1 1 0-3.6c.6 0 1.2.3 1.6.6V6.5c0-.9.7-1.6 1.6-1.6h3.4c-.3-.4-.6-.8-.6-1.4z"/></svg>',
  grid: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  play: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  stop: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
  restart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  upload: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m6.5 9.5 5.5-5.5 5.5 5.5"/><path d="M4 20h16"/></svg>',
  download: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6.5 10.5 5.5 5.5 5.5-5.5"/><path d="M4 20h16"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16"/><path d="M9 6.5V4.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v1.7"/><path d="M6 6.5 7 20c.1.8.7 1.4 1.5 1.4h7c.8 0 1.4-.6 1.5-1.4l1-13.5"/><path d="M10 11v6M14 11v6"/></svg>',
  edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3.5a2.1 2.1 0 0 1 3 3L8 18.5l-4.5 1.5L5 15.5z"/></svg>',
  file: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  filecode: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9.5 12-2 2 2 2M14.5 12l2 2-2 2"/></svg>',
  fileimg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><circle cx="9.5" cy="12" r="1.3"/><path d="m7 18 4-4 2.5 2.5L16 14l2.5 2.5"/></svg>',
  filephar: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c2 2.6 3 5.4 3 8.2 0 2-.6 3.7-1.6 5.3-.7 1.1-1.6 2-2.7 2.7.2-1.2 0-2.3-.7-3.2-.7 1.7-1.9 3-3.7 3.8.4-1.3.3-2.5-.3-3.6C5 14 4.5 12.2 4.5 10.4c0-2.7 1-5.3 2.9-7.9.2 1.6.9 2.8 2 3.7.5-1.6 1.3-2.9 2.6-3.7z"/></svg>',
  folderopen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/></svg>',
  /* standard even-tooth gear (Feather "settings") - the old hand-drawn
     path had uneven teeth and looked broken at small sizes */
  settings: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  users: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17.5" cy="9" r="2.6"/><path d="M16 15.2c2.6.2 4.6 1.9 5.4 4.8"/></svg>',
  scroll: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v14l-4 4H6z"/><path d="M18 17h-4v4"/><path d="M9 8h6M9 12h4"/></svg>',
  archive: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5"/><path d="M10 13h4"/></svg>',
  refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  info: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".4" fill="currentColor"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  save: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3h8v5H8z"/><rect x="7.5" y="13" width="9" height="7" rx="1"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  globe: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z"/></svg>',
  world: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2.5 2.5 0 0 0-2 4c.5.7 0 2-2 2z"/><circle cx="8" cy="10" r="1.1" fill="currentColor"/><circle cx="12" cy="7" r="1.1" fill="currentColor"/><circle cx="16" cy="10" r="1.1" fill="currentColor"/></svg>',
  shield: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 6v6c0 5-3.5 8-8 9.5C7.5 20 4 17 4 12V6z"/></svg>',
  x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>',
  battery: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8" width="17" height="9" rx="2"/><path d="M21.5 11.5v2.5"/><rect x="5" y="10.5" width="8" height="4" rx="1" fill="currentColor" stroke="none"/></svg>',
  dots: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  sort: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16m0 0-3-3.5M7 20l3-3.5"/><path d="M17 20V4m0 0-3 3.5M17 4l3 3.5"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15m0 0 6-6m-6 6-6-6"/></svg>',
  pharfile: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 10.5c.8 1 1.2 2 1.2 3s-.4 2-1.2 3c-.8-1-1.2-2-1.2-3s.4-2 1.2-3z"/></svg>',
  openfolder: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/></svg>',
  chart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M21 20H3.5"/></svg>',
  market: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M8.5 10V6.5a3.5 3.5 0 0 1 7 0V10"/></svg>',
  import: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/></svg>',
};
function icon(name, size) {
  const wrap = document.createElement('span');
  wrap.innerHTML = ICONS[name] || ICONS.file;
  const el = wrap.firstChild;
  if (size) el.setAttribute('width', size), el.setAttribute('height', size);
  return el;
}

/* ---------- ANSI to HTML (full: 16/256/truecolor, bold, bg, ...) ----------
 * PocketMine on Android emits 256-color SGR codes (e.g. "\x1b[38;5;87m") and uses a
 * LONE ESC byte as its reset marker. Everything below is handled. */
const ANSI_16 = {
  30: '#5b657c', 31: '#ff6b6b', 32: '#3ddc84', 33: '#ffc24b', 34: '#4f8cff',
  35: '#c084fc', 36: '#22d3ee', 37: '#e2e8f0',
  90: '#8b94ab', 91: '#ff9aa4', 92: '#7ef0b0', 93: '#ffd98a', 94: '#9cc0ff',
  95: '#ddb4fe', 96: '#8ae9f5', 97: '#ffffff',
  40: '#2a3244', 41: '#7c2b32', 42: '#1e5c3a', 43: '#6b5420', 44: '#24406e',
  45: '#4a2b66', 46: '#155a66', 47: '#3d4657',
  100: '#4a5468', 101: '#a34a51', 102: '#35855c', 103: '#93763a', 104: '#3a5c94',
  105: '#6a478e', 106: '#277883', 107: '#5d6880',
};
/* 256-color palette (xterm): 16 base + 6x6x6 cube + 24 grays */
const ANSI_256 = (() => {
  const p = new Array(256);
  const base = ['#5b657c', '#ff6b6b', '#3ddc84', '#ffc24b', '#4f8cff', '#c084fc', '#22d3ee', '#e2e8f0',
    '#8b94ab', '#ff9aa4', '#7ef0b0', '#ffd98a', '#9cc0ff', '#ddb4fe', '#8ae9f5', '#ffffff'];
  for (let i = 0; i < 16; i++) p[i] = base[i];
  const lv = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    p[16 + 36 * r + 6 * g + b] = 'rgb(' + lv[r] + ',' + lv[g] + ',' + lv[b] + ')';
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p[232 + i] = 'rgb(' + v + ',' + v + ',' + v + ')';
  }
  return p;
})();

function ansiToHtml(text) {
  if (!text) return '';
  let s = String(text);
  // strip OSC (window title etc.)
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  // lone ESC = PocketMine's fallback RESET marker
  s = s.replace(/\x1b(?![\[\]])/g, '\x1b[0m');
  s = esc(s);
  s = s.replace(/\x1b\[[0-9;?]*[A-HJKSTfhlnsu]/g, ''); // non-SGR CSI
  const parts = s.split(/(\x1b\[[0-9;]*m)/);
  let out = '';
  let fg = null, bg = null, bits = '';
  let open = false;
  const flush = () => { if (open) { out += '</span>'; open = false; } };
  const push = () => {
    let st = '';
    if (fg) st += 'color:' + fg + ';';
    if (bg) st += 'background-color:' + bg + ';';
    out += '<span' + (st ? ' style="' + st + '"' : '') + (bits ? ' class="' + bits + '"' : '') + '>';
    open = true;
  };
  for (const p of parts) {
    if (!p) continue;
    if (p.charAt(0) === '\x1b') {
      const codes = p.slice(2, -1).split(';');
      let i = 0;
      let changed = false;
      while (i < codes.length) {
        let c = parseInt(codes[i] || '0', 10);
        if (isNaN(c)) { i++; continue; }
        if (c === 38 || c === 48) {
          // extended color: 38;5;N  |  38;2;R;G;B
          const mode = codes[i + 1] === undefined ? '' : parseInt(codes[i + 1], 10);
          if (mode === 5 && codes[i + 2] !== undefined) {
            const n = parseInt(codes[i + 2], 10);
            if (n >= 0 && n < 256) { if (c === 38) fg = ANSI_256[n]; else bg = ANSI_256[n]; }
            i += 3;
          } else if (mode === 2 && codes[i + 4] !== undefined) {
            const col = 'rgb(' + Math.max(0, Math.min(255, parseInt(codes[i + 2], 10) || 0)) + ','
              + Math.max(0, Math.min(255, parseInt(codes[i + 3], 10) || 0)) + ','
              + Math.max(0, Math.min(255, parseInt(codes[i + 4], 10) || 0)) + ')';
            if (c === 38) fg = col; else bg = col;
            i += 5;
          } else i += 2;
          changed = true;
          continue;
        }
        if (c === 0) { fg = null; bg = null; bits = ''; }
        else if (c === 1) bits = (bits + ' ansi-b').trim();
        else if (c === 2) bits = (bits + ' ansi-dim').trim();
        else if (c === 3) bits = (bits + ' ansi-i').trim();
        else if (c === 4) bits = (bits + ' ansi-u').trim();
        else if (c === 9) bits = (bits + ' ansi-s').trim();
        else if (c === 22) bits = bits.split(' ').filter((x) => x !== 'ansi-b' && x !== 'ansi-dim').join(' ');
        else if (c === 23) bits = bits.split(' ').filter((x) => x !== 'ansi-i').join(' ');
        else if (c === 24) bits = bits.split(' ').filter((x) => x !== 'ansi-u').join(' ');
        else if (c === 29) bits = bits.split(' ').filter((x) => x !== 'ansi-s').join(' ');
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (c >= 30 && c <= 37) fg = ANSI_16[c];
        else if (c >= 40 && c <= 47) bg = ANSI_16[c];
        else if (c >= 90 && c <= 97) fg = ANSI_16[c];
        else if (c >= 100 && c <= 107) bg = ANSI_16[c];
        changed = true;
        i++;
      }
      if (changed) flush();
    } else {
      if (!open) push();
      out += p;
    }
  }
  flush();
  return out;
}
function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-HJKSTfhlnsum]/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b/g, '');
}

/* ---------- toast ---------- */
function toast(msg, type) {
  const root = qs('#toastRoot');
  const t = h('div', { class: 'toast ' + (type || '') }, msg);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

/* ---------- modal ---------- */
function modal(opts) {
  const root = qs('#modalRoot');
  const close = () => { backdrop.remove(); };
  const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
  const actions = h('div', { class: 'modal-actions' });
  (opts.actions || [{ label: t('ok'), class: 'btn primary' }]).forEach((a) => {
    actions.appendChild(h('button', {
      class: a.class || 'btn',
      onclick: () => { if (!a.onClick || a.onClick(close) !== false) close(); },
    }, a.label));
  });
  const box = h('div', { class: 'modal' },
    h('h3', {}, opts.title || ''),
    h('div', { class: 'modal-body' }, body),
    actions);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, box);
  root.appendChild(backdrop);
  return close;
}
function confirmModal(title, body, okLabel, onOk, danger) {
  modal({
    title,
    body,
    actions: [
      { label: t('cancel'), class: 'btn ghost' },
      {
        label: okLabel || t('ok'),
        class: danger ? 'btn danger' : 'btn primary',
        onClick: () => { onOk(); },
      },
    ],
  });
}

/* ---------- misc ---------- */
function debounce(fn, ms) {
  let id;
  return function (...args) { clearTimeout(id); id = setTimeout(() => fn.apply(this, args), ms); };
}
function bytesBase64Len(n) { return Math.ceil(n * 4 / 3); }

/* ---------- action sheet (mobile bottom sheet) ---------- */
function actionSheet(opts) {
  // opts: {title, subtitle, icon, iconColor, actions:[{icon,label,danger,onClick}]}
  const root = qs('#modalRoot');
  const close = () => {
    sheet.style.transform = 'translateY(100%)';
    backdrop.style.opacity = '0';
    setTimeout(() => backdrop.remove(), 200);
  };
  const list = h('div', { class: 'sheet-actions' });
  for (const a of opts.actions || []) {
    if (!a) continue;
    list.appendChild(h('button', {
      class: 'sheet-item' + (a.danger ? ' danger' : ''),
      onclick: () => { close(); setTimeout(() => a.onClick && a.onClick(), 120); },
    },
    h('span', { class: 'sheet-ic', style: a.color ? 'color:' + a.color : '' }, icon(a.icon || 'info')),
    h('span', { class: 'sheet-lb' }, a.label)));
  }
  const head = h('div', { class: 'sheet-head' },
    h('div', { class: 'sheet-grab' }),
    opts.icon ? h('span', { class: 'sheet-big-ic', style: opts.iconColor ? 'color:' + opts.iconColor : '' }, icon(opts.icon, 26)) : null,
    h('div', { class: 'sheet-titles' },
      h('div', { class: 'sheet-title' }, opts.title || ''),
      opts.subtitle ? h('div', { class: 'sheet-sub' }, opts.subtitle) : null));
  const sheet = h('div', { class: 'sheet' }, head, list,
    h('button', { class: 'sheet-cancel', onclick: close }, t('cancel')));
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, sheet);
  root.appendChild(backdrop);
  requestAnimationFrame(() => {
    sheet.style.transform = 'translateY(0)';
    backdrop.style.opacity = '1';
  });
  return close;
}

/* ---------- copy to clipboard (WebView-safe) ---------- */
function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/* ---------- file type helpers ---------- */
function fileKind(name) {
  const n = (name || '').toLowerCase();
  if (/\.(phar)$/.test(n)) return 'phar';
  if (/\.(zip|mcworld|mcpack|tar|gz)$/.test(n)) return 'archive';
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(n)) return 'image';
  if (/\.(yml|yaml)$/.test(n)) return 'yml';
  if (/\.(json)$/.test(n)) return 'json';
  if (/\.(php)$/.test(n)) return 'php';
  if (/\.(properties|ini|conf|txt|md|log)$/.test(n)) return 'text';
  if (/\.(js|ts|css|html|xml|sh|py)$/.test(n)) return 'code';
  if (/\.(dat|db)$/.test(n)) return 'data';
  return 'file';
}
const FILE_ICON = {
  phar: 'filephar', archive: 'archive', image: 'fileimg', yml: 'filecode', json: 'filecode',
  php: 'filecode', text: 'file', code: 'filecode', data: 'file', file: 'file',
};
const FILE_COLOR = {
  phar: 'var(--purple)', archive: 'var(--yellow)', image: 'var(--green)', yml: 'var(--cyan)',
  json: 'var(--cyan)', php: 'var(--accent2)', text: 'var(--muted)', code: 'var(--accent2)',
  data: 'var(--muted)', file: 'var(--muted)',
};
function isEditableFile(name) {
  return /\.(yml|yaml|json|php|properties|ini|txt|md|conf|js|ts|css|html|xml|sh|py|log)$/i.test(name || '');
}

/* ---------- bidi helper: isolate LTR runs (numbers/units) inside RTL text ---------- */
function ltr(v) {
  return h('span', { dir: 'ltr', style: 'unicode-bidi:isolate;display:inline-block' }, String(v));
}
