/* views-v2.js - v2.0.0 tools: fake players, plugin compiler, public IP */

'use strict';

window.Views = window.Views || {};

/* ================= Fake Players ================= */

/* ---- Bot engine bridge: talks to the native libpmbot.so process ----
 * The engine is a real Bedrock protocol client (no server plugin needed):
 * bots genuinely join the target server like ordinary players. */
const BotAPI = (() => {
  function status() { return API.call('bot.status'); }
  function ensure() {
    const st = status();
    if (st.ok === false) return st;
    if (!st.engine) return { ok: false, error: 'no-engine' };
    if (!st.running) {
      const r = API.call('bot.start');
      if (r.ok === false) return r;
    }
    return { ok: true };
  }
  function op(o) {
    const st = ensure();
    if (st.ok === false) return st;
    return API.call('bot.cmd', { line: JSON.stringify(o) });
  }
  function stop() { return API.call('bot.stop'); }
  function dropBot(name) {
    FP.bots = FP.bots.filter((b) => b.name !== name);
    FP.refreshChips && FP.refreshChips();
  }
  /* Handle one engine event. Registered once, active for all views. */
  function handleEvent(ev) {
    if (!ev || !ev.ev) return;
    if (ev.ev === 'ready') { FP.engineInfo = ev; return; }
    if (ev.ev === 'status') {
      const b = FP.bots.find((x) => x.name === ev.name);
      if (b) { b.state = ev.state; b.msg = ev.msg || ''; b.code = ev.code || ''; b.gamertag = ev.gamertag || ''; }
      else FP.bots.push({ name: ev.name, state: ev.state, msg: ev.msg || '', code: ev.code || '', gamertag: ev.gamertag || '' });
    } else if (ev.ev === 'bots') {
      FP.bots = (ev.list || []).slice();
    } else if (ev.ev === 'pong') {
      FP.lastPong = ev;
    } else if (ev.ev === 'auth') {
      FP.auth = Object.assign({ state: 'none' }, FP.auth || {}, ev);
      FP.authHook && FP.authHook(FP.auth);
    } else if (ev.ev === 'packs') {
      /* pack fetcher events (Tools > server pack download) */
      FP.packs = ev;
      FP.packsBusy = ['started', 'downloading', 'cached', 'progress', 'packdone'].includes(ev.phase);
      FP.packHook && FP.packHook(ev);
    }
    FP.logBuf.push(ev);
    while (FP.logBuf.length > 250) FP.logBuf.shift();
    if (ev.ev === 'status' || ev.ev === 'bots') FP.refreshChips && FP.refreshChips();
    FP.uiHook && FP.uiHook(ev);
  }
  function onServerDown() {
    /* the local server stopped: its bots are gone; drop the engine */
    const st = status();
    if (st.ok && st.running) stop();
    FP.bots = [];
    FP.logBuf.push({ ev: 'chat', text: '-- server stopped --' });
    FP.uiHook && FP.uiHook({ ev: 'chat', text: '-- server stopped --' });
  }
  return { status, ensure, op, stop, handleEvent, onServerDown };
})();

/* global sink for native engine events (set once by MainActivity.pushBotEvent) */
window.__pmBotEvent = (ev) => { try { BotAPI.handleEvent(ev); } catch (e) { /* keep engine alive */ } };

/* ---- persisted fake-player state ---- */
const FP = {
  target: localStorage.getItem('pm_fp_target') || 'local',
  remote: (() => {
    try { return JSON.parse(localStorage.getItem('pm_fp_remote')) || {}; } catch (e) { return {}; }
  })(),
  accepted: localStorage.getItem('pm_fp_disclaimer') === '1',
  useXbox: localStorage.getItem('pm_fp_use_xbox') === '1',
  bots: [],          /* {name, state, msg, code, gamertag}  state: joining|online|left|failed */
  logBuf: [],        /* recent engine events, survives view switches */
  uiHook: null,      /* set by the fakeplayers view while visible */
  authHook: null,    /* live updater while the Xbox sign-in modal is open */
  auth: null,        /* latest engine auth event {state, code, url, gamertag} */
  engineInfo: null,  /* ready event {engine, protocol, version} */
  lastPong: null,    /* latest ping result {ok, motd, version, protocol, compat, ...} */
  packs: null,       /* latest pack-fetcher event {ev:'packs', phase, ...} */
  packsBusy: false,  /* a pack fetch is currently running */
  packHook: null,    /* live updater while the downloader view is visible */
};

/* Persian message for an engine failure code (falls back to empty). */
function fpErrText(code) {
  if (!code) return '';
  const key = 'fp_err_' + code;
  return t(key) === key ? '' : t(key);
}

/* Collapsible card with a smooth height animation. Tapping the header toggles
 * the body (buttons/inputs/labels inside the header stay clickable). The open
 * state persists in localStorage so view switches keep it. */
function collapsibleCard(headLeft, headRight, bodyChildren, storageKey) {
  const chev = icon('down');
  chev.classList.add('acc-chev');
  const head = h('div', { class: 'acc-head' },
    h('div', { class: 'acc-head-main' }, headLeft),
    headRight || null,
    chev);
  const inner = h('div', { class: 'acc-inner' }, bodyChildren);
  const body = h('div', { class: 'acc-body' }, inner);
  const card = h('div', { class: 'card acc' }, head, body);
  let open = true;
  try { open = localStorage.getItem(storageKey) !== '0'; } catch (e) { /* private mode */ }
  const apply = () => {
    card.classList.toggle('open', open);
    try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch (e) { /* ignore */ }
  };
  head.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select, textarea, a, label')) return;
    open = !open;
    apply();
  });
  apply();
  return { card, setOpen(v) { if (open !== !!v) { open = !!v; apply(); } }, isOpen: () => open };
}

function fpSaveRemote() {
  localStorage.setItem('pm_fp_remote', JSON.stringify(FP.remote));
}

/* Address of the bot target. Local = this device's server; remote = user-entered. */
function fpTargetAddr(portFallback) {
  if (FP.target === 'remote') {
    return (FP.remote.host || '').trim() + ':' + (parseInt(FP.remote.port, 10) || 19132);
  }
  return '127.0.0.1:' + (portFallback || 19132);
}

/* Names must look like ordinary Bedrock players (3-16, A-Za-z0-9_). */
const FP_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

Views.fakeplayers = (root) => {
  const running = App.status.state === 'running' || App.status.state === 'starting';
  const isRemote = FP.target !== 'local';

  /* server port for the local target */
  let localPort = 19132;
  const props = API.call('props.get');
  const xboxAuthOn = (() => {
    if (props.ok) {
      for (const l of props.lines || []) {
        if (l.type === 'k' && l.key === 'server-port') localPort = parseInt(l.value, 10) || 19132;
        if (l.type === 'k' && l.key === 'xbox-auth') return l.value === 'on';
      }
    }
    return false;
  })();
  const propsMissing = !props.ok || !(props.lines || []).some((l) => l.type === 'k');

  /* ---- engine status chip ---- */
  const eng = API.call('bot.status');
  const engineCard = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('terminal'), t('fp_engine_title')),
      eng.ok && eng.engine ? h('span', { class: 'badge green' }, '✓ ' + t('fp_engine_ok'))
                           : h('span', { class: 'badge red' }, t('fp_engine_missing'))),
    h('div', { class: 'hint mt' }, t('fp_engine_hint')));
  if (eng.ok && eng.engine && FP.engineInfo) {
    engineCard.appendChild(h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'protocol'),
      h('span', { class: 'v mono-ltr' }, 'v' + FP.engineInfo.protocol + ' (MC ' + FP.engineInfo.version + ')')));
  }
  root.appendChild(engineCard);
  if (eng.ok === false || !eng.engine) {
    root.appendChild(h('div', { class: 'card hint', style: 'color:var(--red)' }, t('fp_engine_unsupported')));
    return;
  }

  /* ---- Xbox account card: real authentication for xbox-auth=on servers ---- */
  BotAPI.op({ op: 'auth_state' }); /* engine answers async with an auth event */
  const authChip = h('span', { class: 'badge' }, '');
  const authOutBtn = h('button', {
    class: 'btn ghost sm', style: 'display:none',
    onclick: () => BotAPI.op({ op: 'auth_logout' }),
  }, icon('stop'), t('fp_auth_out'));
  function paintAuthChip(a) {
    const st = (a && a.state) || 'none';
    if (st === 'ok') {
      authChip.className = 'badge green';
      authChip.textContent = '✓ ' + t('fp_auth_connected') + (a.gamertag ? ': ' + a.gamertag : '');
      authOutBtn.style.display = '';
    } else if (st === 'code' || st === 'signing') {
      authChip.className = 'badge yellow';
      authChip.textContent = t('fp_auth_waiting');
      authOutBtn.style.display = 'none';
    } else if (st === 'error') {
      authChip.className = 'badge red';
      authChip.textContent = t('fp_auth_failed');
      authOutBtn.style.display = 'none';
    } else {
      authChip.className = 'badge';
      authChip.textContent = t('fp_auth_none');
      authOutBtn.style.display = 'none';
    }
  }
  paintAuthChip(FP.auth);
  FP.authHook = paintAuthChip;

  function openAuthModal() {
    const codeEl = h('div', { class: 'mono-ltr', style: 'font-size:22px;letter-spacing:3px;text-align:center;margin:10px 0' }, '····-····');
    const statusEl = h('div', { class: 'hint center' }, t('fp_auth_waiting'));
    function paintModal(a) {
      if (a && a.code) codeEl.textContent = a.code;
      if (a && a.state === 'ok') {
        statusEl.textContent = t('fp_auth_done');
        statusEl.style.color = 'var(--green)';
        FP.authHook = paintAuthChip;
      } else if (a && a.state === 'error') {
        statusEl.textContent = t('fp_auth_failed') + (a.error ? ' - ' + a.error : '');
        statusEl.style.color = 'var(--red)';
        FP.authHook = paintAuthChip;
      }
    }
    paintModal(FP.auth);
    FP.authHook = paintModal;
    modal({
      title: t('fp_auth_modal_title'),
      body: h('div', {},
        h('div', { class: 'hint', style: 'line-height:1.9' }, t('fp_auth_step1')),
        h('button', {
          class: 'btn primary block mt',
          onclick: () => API.call('openUrl', { url: (FP.auth && FP.auth.url) || 'https://www.microsoft.com/link' }),
        }, icon('globe'), t('fp_auth_open')),
        h('div', { class: 'hint mt' }, t('fp_auth_step2')),
        codeEl,
        h('div', { class: 'row mt', style: 'justify-content:center' },
          h('button', {
            class: 'btn sm',
            onclick: () => { const c = FP.auth && FP.auth.code; if (c && copyText(c)) toast(t('copied'), 'ok'); },
          }, icon('copy'), t('fp_auth_copy_code'))),
        statusEl),
      actions: [
        { label: t('cancel'), class: 'btn ghost', onClick: () => { BotAPI.op({ op: 'auth_cancel' }); FP.authHook = paintAuthChip; } },
      ],
    });
  }

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('shield'), t('fp_auth_title')),
      authChip),
    h('div', { class: 'hint mt' }, t('fp_auth_hint')),
    h('div', { class: 'row mt' },
      h('button', {
        class: 'btn primary',
        onclick: () => { openAuthModal(); BotAPI.op({ op: 'auth_start' }); },
      }, icon('shield'), t('fp_auth_btn')),
      authOutBtn)));

  /* ---- target selector ---- */
  const seg = h('div', { class: 'segmented' });
  [['local', 'fp_local'], ['remote', 'fp_remote']].forEach(([id, key]) => {
    seg.appendChild(h('button', {
      class: FP.target === id ? 'active' : '',
      onclick: () => selectTarget(id),
    }, h('span', {}, t(key))));
  });
  root.appendChild(seg);

  function selectTarget(id) {
    if (id === FP.target) return;
    if (id === 'remote' && !FP.accepted) {
      modal({
        title: t('fp_disclaimer_title'),
        body: h('div', {}, h('div', { class: 'hint', style: 'line-height:2' }, t('fp_disclaimer'))),
        actions: [
          { label: t('cancel'), class: 'btn ghost' },
          {
            label: t('fp_accept'), class: 'btn danger',
            onClick: () => {
              FP.accepted = true;
              localStorage.setItem('pm_fp_disclaimer', '1');
              FP.target = 'remote';
              localStorage.setItem('pm_fp_target', 'remote');
              App.rerender();
            },
          },
        ],
      });
      return;
    }
    FP.target = id;
    localStorage.setItem('pm_fp_target', id);
    App.rerender();
  }

  /* ---- remote server settings ---- */
  if (isRemote) {
    const host = h('input', { class: 'text-input mono-ltr', type: 'text', value: FP.remote.host || '', placeholder: 'play.example.com', autocomplete: 'off', spellcheck: 'false' });
    const port = h('input', { class: 'text-input mono-ltr', type: 'number', value: FP.remote.port || 19132 });
    const testOut = h('div', { class: 'hint mt', style: 'line-height:1.9' }, '');
    const testBtn = h('button', {
      class: 'btn sm',
      onclick: () => {
        FP.remote.host = host.value.trim();
        FP.remote.port = parseInt(port.value, 10) || 19132;
        fpSaveRemote();
        if (!FP.remote.host) { toast(t('fp_need_host'), 'err'); return; }
        testBtn.disabled = true;
        testOut.textContent = '';
        testOut.appendChild(h('span', { class: 'badge yellow' }, t('fp_testing')));
        FP.lastPong = null;
        BotAPI.op({ op: 'ping', addr: fpTargetAddr() });
        /* the pong event lands in BotAPI; poll briefly for the result */
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          if (FP.lastPong) {
            clearInterval(timer);
            testBtn.disabled = false;
            const p = FP.lastPong;
            testOut.innerHTML = '';
            if (p.ok) {
              testOut.appendChild(h('div', {},
                h('span', { class: 'badge green' }, '✓ ' + t('fp_connected')),
                h('span', { class: 'badge accent', style: 'margin-inline-start:6px' },
                  'MC ' + (p.version || '?') + ' · protocol ' + (p.protocol || '?'))));
              if (p.compat === 'ok') {
                testOut.appendChild(h('div', { class: 'hint mt', style: 'color:var(--green)' }, '✓ ' + t('fp_compat_ok')));
              } else if (p.compat === 'mismatch') {
                testOut.appendChild(h('div', { class: 'hint mt', style: 'color:var(--red);line-height:1.9' },
                  '⚠ ' + t('fp_compat_bad').replace('{srv}', 'MC ' + (p.version || '?'))
                    .replace('{sup}', (FP.engineInfo && FP.engineInfo.supported) || '1.21.40 - 1.26.60')));
              }
              testOut.appendChild(h('div', { class: 'kv mt' },
                h('span', { class: 'k' }, 'MOTD'),
                h('span', { class: 'v' }, p.motd || '—')));
              testOut.appendChild(h('div', { class: 'kv' },
                h('span', { class: 'k' }, t('players')),
                h('span', { class: 'v mono-ltr' }, (p.players || '?') + ' / ' + (p.max || '?'))));
            } else {
              testOut.appendChild(h('span', { class: 'badge red' }, p.error || t('error')));
            }
          } else if (tries > 24) {
            clearInterval(timer);
            testBtn.disabled = false;
            testOut.innerHTML = '';
            testOut.appendChild(h('span', { class: 'badge red' }, t('fp_ping_timeout')));
          }
        }, 350);
      },
    }, icon('check'), t('fp_test_conn'));

    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, icon('globe'), t('fp_remote_title')),
      h('div', { class: 'hint mb' }, t('fp_remote_hint')),
      h('label', { class: 'field' }, h('span', { class: 'fl' }, t('fp_host')), host),
      h('label', { class: 'field' }, h('span', { class: 'fl' }, t('fp_port')), port),
      h('div', { class: 'row mt' }, testBtn),
      testOut));
  }

  /* ---- local preconditions ---- */
  if (!isRemote) {
    if (propsMissing) {
      root.appendChild(h('div', { class: 'card hint', style: 'color:var(--red)' }, t('not_installed_hint')));
      return;
    }
    if (xboxAuthOn) {
      const card = h('div', { class: 'card' },
        h('div', { class: 'card-title', style: 'margin:0' }, icon('shield'), t('fp_xbox_title')),
        h('div', { class: 'hint mt', style: 'color:var(--yellow)' }, '⚠ ' + t('fp_xbox_hint')));
      card.appendChild(h('button', {
        class: 'btn primary block mt',
        onclick: () => {
          API.call('props.set', {
            lines: (props.lines || []).map((l) =>
              (l.type === 'k' && l.key === 'xbox-auth') ? { type: 'k', key: 'xbox-auth', value: 'off' } : l),
          });
          toast(t('fp_xbox_fixed'), 'ok');
          if (['running', 'starting'].includes(App.status.state)) toast(t('fp_xbox_restart'), 'warn');
          App.rerender();
        },
      }, icon('check'), t('fp_xbox_fix')));
      root.appendChild(card);
    }
    if (!['running', 'starting'].includes(App.status.state)) {
      root.appendChild(h('div', { class: 'card hint', style: 'color:var(--yellow)' },
        '⚠ ' + t('fp_need_running')));
    }
  }

  /* ---- add fake players ---- */
  let addMode = localStorage.getItem('pm_fp_mode') || 'names';
  const addModeSeg = h('div', { class: 'segmented' });
  [['names', 'fp_mode_names'], ['pattern', 'fp_mode_pattern']].forEach(([id, key]) => {
    addModeSeg.appendChild(h('button', {
      'data-mode': id,
      class: addMode === id ? 'active' : '',
      onclick: () => {
        addMode = id;
        localStorage.setItem('pm_fp_mode', id);
        qsa('button', addModeSeg).forEach((b) => b.classList.toggle('active', b.dataset.mode === id));
        namesArea.style.display = addMode === 'names' ? '' : 'none';
        patternRow.style.display = addMode === 'pattern' ? '' : 'none';
      },
    }, h('span', {}, t(key))));
  });

  const namesArea = h('textarea', {
    class: 'text-input', rows: '3', spellcheck: 'false', autocomplete: 'off',
    placeholder: t('fp_names_hint'), style: 'min-height:64px',
  });
  const baseName = h('input', { class: 'text-input', type: 'text', placeholder: 'Player', autocomplete: 'off', spellcheck: 'false' });
  const countIn = h('input', { class: 'text-input', type: 'number', min: '1', max: '200', value: '10' });
  const patternRow = h('div', { class: 'row', style: 'display:none' },
    h('label', { class: 'field', style: 'flex:1.6' }, h('span', { class: 'fl' }, t('fp_base_name')), baseName),
    h('label', { class: 'field', style: 'flex:1' }, h('span', { class: 'fl' }, t('fp_count')), countIn));
  if (addMode === 'pattern') {
    namesArea.style.display = 'none';
    patternRow.style.display = 'flex';
  }

  const addBtn = h('button', {
    class: 'btn success block mt',
    onclick: doAdd,
  }, icon('plus'), t('fp_add'));

  const xboxCheck = h('input', { type: 'checkbox' });
  xboxCheck.checked = !!FP.useXbox;
  xboxCheck.addEventListener('change', () => {
    FP.useXbox = xboxCheck.checked;
    localStorage.setItem('pm_fp_use_xbox', FP.useXbox ? '1' : '0');
  });
  const xboxRow = h('label', { class: 'row mt', style: 'align-items:center;gap:8px;cursor:pointer' },
    xboxCheck,
    h('div', {},
      h('div', {}, t('fp_auth_use')),
      h('div', { class: 'hint', style: 'font-size:11px' }, t('fp_auth_use_hint'))));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('users'), t('fp_add_title')),
    addModeSeg,
    h('div', { class: 'mt' }, namesArea),
    patternRow,
    h('div', { class: 'hint mt' }, t('fp_names_rule')),
    xboxRow,
    addBtn));

  function buildNames() {
    const out = [];
    if (addMode === 'names') {
      for (let line of namesArea.value.split('\n')) {
        line = line.trim();
        if (!line) continue;
        if (!FP_NAME_RE.test(line)) return { err: line };
        if (!out.includes(line)) out.push(line);
      }
    } else {
      const base = baseName.value.trim();
      if (!FP_NAME_RE.test(base)) return { err: base || '?' };
      const n = Math.max(1, Math.min(200, parseInt(countIn.value, 10) || 1));
      out.push(base);
      for (let i = 2; i <= n; i++) out.push(base + i);
    }
    if (out.length > 200) out.length = 200; // engine hard limit (maxBots)
    return { names: out };
  }

  function doAdd() {
    if (isRemote && FP.lastPong && FP.lastPong.compat === 'mismatch') {
      toast(t('fp_compat_bad').replace('{srv}', 'MC ' + (FP.lastPong.version || '?'))
        .replace('{sup}', (FP.engineInfo && FP.engineInfo.supported) || '1.21.40 - 1.26.60'), 'err');
      return;
    }
    const b = buildNames();
    if (b.err !== undefined) { toast(t('fp_bad_name').replace('{s}', b.err), 'err'); return; }
    let names = b.names;
    if (!names.length) { toast(t('fp_names_hint'), 'err'); return; }
    const useAuth = !!FP.useXbox;
    if (useAuth) {
      if (!(FP.auth && FP.auth.state === 'ok')) { toast(t('fp_err_need_auth'), 'err'); return; }
      names = [FP.auth.gamertag || names[0]];
    }
    if (isRemote && !FP.remote.host) { toast(t('fp_need_host'), 'err'); return; }
    if (!isRemote && !['running', 'starting'].includes(App.status.state)) {
      toast(t('fp_need_running'), 'err');
      return;
    }
    const r = BotAPI.op({ op: 'spawn', addr: fpTargetAddr(localPort), names: names, useAuth: useAuth });
    if (r.ok === false) {
      if (r.error === 'no-engine') toast(t('fp_engine_missing'), 'err');
      else toast(r.error || t('error'), 'err');
      return;
    }
    /* optimistic chips; engine status events refine them */
    for (const n of names) {
      if (!FP.bots.find((x) => x.name === n)) FP.bots.push({ name: n, state: 'joining', msg: '' });
    }
    FP.refreshChips && FP.refreshChips();
    toast(t('fp_spawning').replace('{n}', names.length), 'ok');
    /* smooth-open the players panel so big batches are visible immediately */
    playersCard.setOpen(true);
    chips.scrollTop = 0;
  }

  /* ---- fake player chips + actions ---- */
  const chips = h('div', { class: 'row wrap fp-chips' });
  const playersTitle = h('span', {}, '');
  FP.refreshChips = renderChips;
  function renderChips() {
    chips.innerHTML = '';
    const order = { online: 0, joining: 1, failed: 2, left: 3 };
    const list = FP.bots.slice().sort((a, b) => (order[a.state] != null ? order[a.state] : 9) - (order[b.state] != null ? order[b.state] : 9) || a.name.localeCompare(b.name));
    if (!list.length) {
      chips.appendChild(h('div', { class: 'hint' }, t('fp_none')));
    }
    for (const b of list) {
      const cls = b.state === 'online' ? 'green' : b.state === 'joining' ? 'yellow' : 'red';
      const label = b.gamertag || b.name;
      const errTxt = fpErrText(b.code);
      chips.appendChild(h('span', {
        class: 'badge ' + cls + ' fp-chip' + (b.state === 'left' || b.state === 'failed' ? ' fp-dim' : ''),
        onclick: () => playerSheet(label),
        title: (b.msg || '') + (errTxt ? ' — ' + errTxt : ''),
      }, '● ' + label + (b.state === 'joining' ? ' …' : '')));
    }
    playersTitle.textContent = t('fp_players') + ' (' + FP.bots.filter((x) => x.state === 'online').length + ')';
  }
  renderChips();
  App.cleanup.push(() => { FP.uiHook = null; FP.refreshChips = null; FP.authHook = null; });

  const sel = h('select', { class: 'text-input', style: 'flex:0 0 116px' });
  function renderSelect() {
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: 'all' }, t('fp_all_bots')));
    for (const b of FP.bots.filter((x) => x.state === 'online')) {
      sel.appendChild(h('option', { value: b.name }, b.name));
    }
  }
  renderSelect();
  const oldRefresh = FP.refreshChips;
  FP.refreshChips = function () { oldRefresh(); renderSelect(); };

  const chatIn = h('input', { class: 'text-input', type: 'text', placeholder: t('fp_chat_ph'), autocomplete: 'off', spellcheck: 'false' });
  const cmdIn = h('input', { class: 'text-input', type: 'text', placeholder: t('fp_cmd_ph'), autocomplete: 'off', spellcheck: 'false' });

  function sendKind(kind, input) {
    const text = input.value.trim();
    if (!text) return;
    const to = sel.value || 'all';
    const onlineCount = FP.bots.filter((x) => x.state === 'online').length;
    if (!onlineCount) { toast(t('fp_none'), 'err'); return; }
    input.value = '';
    BotAPI.op({ op: kind, to: to, text: text });
  }

  const kickAllBtn = h('button', {
    class: 'btn danger sm',
    onclick: () => {
      if (!FP.bots.length) { toast(t('fp_none'), 'err'); return; }
      confirmModal(t('fp_kick_all'), t('fp_kick_all_confirm'), t('kick'), () => {
        BotAPI.op({ op: 'kick', to: 'all' });
      }, true);
    },
  }, icon('stop'), t('fp_kick_all'));

  const syncBtn = h('button', {
    class: 'icon-btn', title: t('fp_sync'),
    onclick: () => BotAPI.op({ op: 'list' }),
  }, icon('refresh'));

  const playersCard = collapsibleCard(
    h('div', { class: 'card-title', style: 'margin:0' }, icon('users'), playersTitle),
    h('div', { class: 'row' }, syncBtn, kickAllBtn),
    [
      chips,
      h('label', { class: 'field mt' }, h('span', { class: 'fl' }, t('fp_target_bot')), sel),
      h('div', { class: 'row mt', style: 'gap:6px' },
        chatIn,
        h('button', { class: 'btn sm primary', onclick: () => sendKind('say', chatIn) }, t('send'))),
      h('div', { class: 'row mt', style: 'gap:6px' },
        cmdIn,
        h('button', { class: 'btn sm primary', onclick: () => sendKind('cmd', cmdIn) }, t('send'))),
    ],
    'pm_fp_players_open');
  root.appendChild(playersCard.card);

  function playerSheet(name) {
    actionSheet({
      title: name,
      icon: 'users',
      iconColor: 'var(--green)',
      actions: [
        {
          icon: 'edit', label: t('fp_chat_one'),
          onClick: () => inputModal(t('fp_chat_one') + ' — ' + name, t('fp_chat_ph'),
            (v) => BotAPI.op({ op: 'say', to: name, text: v })),
        },
        {
          icon: 'terminal', label: t('fp_cmd_one'),
          onClick: () => inputModal(t('fp_cmd_one') + ' — ' + name, t('fp_cmd_ph'),
            (v) => BotAPI.op({ op: 'cmd', to: name, text: v })),
        },
        {
          icon: 'stop', label: t('kick'),
          onClick: () => BotAPI.op({ op: 'kick', to: name }),
        },
      ],
    });
  }

  /* ---- live log (engine events + server chat heard by the listener bot) ---- */
  const logEl = h('div', { class: 'console', style: 'height:300px' });
  const jumpBtn = h('button', { class: 'jump-bottom hidden' });
  jumpBtn.addEventListener('click', () => { logEl.scrollTop = logEl.scrollHeight; });

  function renderLine(ev) {
    let text = '';
    let cls = '';
    if (ev.ev === 'chat') text = ev.text || '';
    else if (ev.ev === 'status') {
      text = '[' + (ev.gamertag || ev.name || '') + '] ' + (ev.state || '') + (ev.msg ? ' - ' + ev.msg : '');
      const errTxt = fpErrText(ev.code);
      if (errTxt) text += ' — ' + errTxt;
      cls = ev.state === 'online' ? 'ok' : (ev.state === 'joining' ? '' : 'err');
    } else if (ev.ev === 'log') text = ev.text || '';
    else if (ev.ev === 'auth') {
      if (ev.state === 'code') text = 'xbox sign-in code ' + (ev.code || '') + ' - ' + (ev.url || '');
      else if (ev.state === 'ok') text = 'xbox account connected' + (ev.gamertag ? ': ' + ev.gamertag : '');
      else if (ev.state === 'error') text = 'xbox sign-in failed' + (ev.error ? ': ' + ev.error : '');
      else text = 'xbox: ' + ev.state;
      cls = ev.state === 'ok' ? 'ok' : (ev.state === 'error' ? 'err' : '');
    } else if (ev.ev === 'pong') {
      text = ev.ok ? 'ping ' + ev.addr + ' -> MC ' + ev.version + ' (' + ev.players + '/' + ev.max + ')'
                   : 'ping ' + ev.addr + ' failed: ' + (ev.error || '');
      cls = ev.ok ? 'ok' : 'err';
    } else if (ev.ev === 'ready') {
      text = 'engine v' + ev.engine + ' ready (protocol ' + ev.protocol + ')';
      cls = 'ok';
    } else return;
    if (!text) return;
    const div = h('div', { class: 'ln' + (cls ? ' ' + cls : '') });
    div.textContent = text;
    logEl.appendChild(div);
    while (logEl.childElementCount > 250) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  for (const ev of FP.logBuf.slice(-120)) renderLine(ev);
  FP.uiHook = renderLine;

  const logCard = collapsibleCard(
    h('div', { class: 'card-title', style: 'margin:0' }, icon('terminal'), t('fp_live_log')),
    null,
    [
      h('div', { class: 'hint mb' }, t('fp_log_hint')),
      h('div', { class: 'console-shell', style: 'flex:none;height:300px' }, logEl, jumpBtn),
    ],
    'pm_fp_log_open');
  root.appendChild(logCard.card);
}

function inputModal(title, placeholder, onOk) {
  const input = h('input', { class: 'text-input', type: 'text', placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'false' });
  modal({
    title: title,
    body: h('div', {}, input),
    actions: [
      { label: t('cancel'), class: 'btn ghost' },
      {
        label: t('send'), class: 'btn primary',
        onClick: () => { const v = input.value.trim(); if (v) onOk(v); },
      },
    ],
  });
  setTimeout(() => { try { input.focus(); } catch (e) { /* noop */ } }, 150);
}

/* ================= Plugin Compiler / Decompiler ================= */
/* Pure-Java backend (no PHP process): works on every device, with or without
 * the server running. Inputs: a source folder (from the server, a previous
 * decompile, or an uploaded zip) for compile; a .phar/.zip (server plugin or
 * uploaded) for decompile. */

Views.compiler = (root) => {
  let mode = App.compilerMode === 'decompile' ? 'decompile' : 'compile';
  App.compilerMode = mode;
  const preset = App.compilerPreset || '';
  App.compilerPreset = '';

  const seg = h('div', { class: 'segmented' });
  [['compile', 'comp_compile', 'pharfile'], ['decompile', 'comp_decompile', 'filecode']].forEach(([id, key, ic]) => {
    seg.appendChild(h('button', {
      class: mode === id ? 'active' : '',
      onclick: () => { mode = id; App.compilerMode = id; render(); },
    }, icon(ic, 16), h('span', {}, t(key))));
  });
  root.appendChild(seg);

  const pickBox = h('div', {});
  const outName = h('input', { class: 'text-input', type: 'text', placeholder: t('comp_out_name_ph'), autocomplete: 'off', spellcheck: 'false' });
  const manual = h('input', { class: 'text-input mono-ltr', type: 'text', value: preset, autocomplete: 'off', spellcheck: 'false' });
  const runBtn = h('button', { class: 'btn primary block mt', onclick: run }, icon('play'), t('comp_run'));
  const resultBox = h('div', {});
  const hintCard = h('div', { class: 'card hint' }, t('comp_hint'));

  function upload() {
    const wantZip = mode === 'compile';
    API.call('files.mkdir', { path: 'uploads' });
    API.callAsync('upload.pick', { dir: 'uploads', multiple: false })
      .then((ev) => {
        const f = (ev.files || []).find((x) => !x.error
          && (wantZip ? /\.zip$/i.test(x.name) : /\.(phar|zip)$/i.test(x.name)));
        if (!f) { toast(wantZip ? t('comp_upload_zip_bad') : t('comp_upload_phar_bad'), 'err'); return; }
        manual.value = 'uploads/' + f.name;
        toast(t('comp_auto_started'), 'ok');
        run();
      })
      .catch((e) => toast((e && e.error === 'cancelled' ? '' : (e.error || t('error'))) || '', 'err'));
  }

  function render() {
    qsa('button', seg).forEach((b, i) => b.classList.toggle('active', (i === 0) === (mode === 'compile')));
    pickBox.innerHTML = '';
    resultBox.innerHTML = '';

    /* upload button: zip sources for compile, phar/zip for decompile */
    pickBox.appendChild(h('button', {
      class: 'btn block mb', onclick: upload,
    }, icon('upload'), mode === 'compile' ? t('comp_upload_zip') : t('comp_upload_phar')));

    const res = API.call('plugins.list');
    const plugins = (res.ok && res.plugins) || [];
    const items = mode === 'compile'
      ? plugins.filter((p) => p.format === 'source' || p.format === 'dir')
      : plugins.filter((p) => p.format === 'phar');

    if (items.length) {
      pickBox.appendChild(h('div', { class: 'cc-section' },
        mode === 'compile' ? t('comp_source_plugins') : t('comp_phar_plugins'),
        h('span', { class: 'count' }, items.length)));
      for (const p of items) {
        pickBox.appendChild(h('div', {
          class: 'fm-row',
          onclick: (e) => {
            manual.value = p.file;
            qsa('.fm-row', pickBox).forEach((x) => x.classList.remove('sel'));
            e.currentTarget.classList.add('sel');
          },
        },
        h('span', { class: 'fm-ic', style: 'color:var(--purple)' }, icon(mode === 'compile' ? 'folder' : 'filephar')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, p.name || p.file),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm mono-ltr', dir: 'ltr' }, (p.file || '') + ' · ' + fmtBytes(p.size)))),
        h('span', { class: 'fm-actions' })));
      }
    }
    pickBox.appendChild(h('label', { class: 'field mt' }, h('span', { class: 'fl' }, t('comp_manual_path')), manual));
    if (mode === 'compile') {
      pickBox.appendChild(h('label', { class: 'field mt' }, h('span', { class: 'fl' }, t('comp_out_name')), outName));
    }
    pickBox.appendChild(runBtn);
    pickBox.appendChild(resultBox);
  }

  function run() {
    const path = manual.value.trim();
    if (!path) { toast(t('comp_need_path'), 'err'); return; }
    runBtn.disabled = true;
    resultBox.innerHTML = '';
    resultBox.appendChild(h('div', { class: 'hint center mt' }, t('comp_working')));
    const cmd = mode === 'compile' ? 'tool.compile' : 'tool.decompile';
    const params = mode === 'compile'
      ? { src: path, name: outName.value.trim() }
      : { src: path };
    API.callAsync(cmd, params)
      .then((ev) => { renderResult(ev); runBtn.disabled = false; })
      .catch((e) => {
        resultBox.innerHTML = '';
        resultBox.appendChild(h('div', { class: 'hint', style: 'color:var(--red)' }, (e && e.error) || t('error')));
        runBtn.disabled = false;
      });
  }

  function renderResult(ev) {
    resultBox.innerHTML = '';
    const card = h('div', { class: 'card', style: 'border-color:rgba(23,201,100,.4)' },
      h('div', { class: 'spread' },
        h('div', { class: 'card-title', style: 'margin:0;color:#34e07c' }, icon('check'), t('comp_done')),
        h('span', { class: 'badge green' }, (ev.files || 0) + ' ' + t('files_c'))),
      h('div', { class: 'kv mt' }, h('span', { class: 'k' }, t('comp_result')), h('span', { class: 'v mono-ltr' }, ev.file || '—')),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, t('size')), h('span', { class: 'v' }, ev.size ? fmtBytes(ev.size) : '—')));
    const row = h('div', { class: 'row wrap mt' });
    row.appendChild(h('button', {
      class: 'btn sm',
      onclick: () => {
        const f = ev.file || '';
        App.filesPath = f.split('/').slice(0, -1).join('/');
        App.navigate('files');
      },
    }, icon('openfolder'), t('open_folder')));
    if (mode === 'compile') {
      row.appendChild(h('button', {
        class: 'btn sm success',
        onclick: () => {
          const name = (ev.file || '').split('/').pop();
          const r = API.call('files.move', { path: ev.file, dest: 'plugins/' + name });
          if (r.ok === false) toast(r.error, 'err');
          else toast(t('comp_installed'), 'ok');
        },
      }, icon('puzzle'), t('comp_install_plugin')));
    } else if (ev.file) {
      row.appendChild(h('button', {
        class: 'btn sm',
        onclick: () => { App.compilerMode = 'compile'; App.compilerPreset = ev.file; App.rerender(); },
      }, icon('pharfile'), t('comp_now_compile')));
    }
    card.appendChild(row);
    resultBox.appendChild(card);
  }

  root.appendChild(pickBox);
  root.appendChild(hintCard);
  render();
};

/* ================= Xbox sign-in modal (shared) =================
 * Device-code flow against the bot engine. Used by the fake-players view
 * and (v2.7) by the pack downloader: public servers with xbox-auth=on
 * reject offline clients, so the fetch must run under the user account. */
function openEngineAuthModal(afterOk) {
  const codeEl = h('div', { class: 'mono-ltr', style: 'font-size:22px;letter-spacing:3px;text-align:center;margin:10px 0' }, '····-····');
  const statusEl = h('div', { class: 'hint center' }, t('fp_auth_waiting'));
  const prevHook = FP.authHook;
  function paint(a) {
    if (a && a.code) codeEl.textContent = a.code;
    if (a && a.state === 'ok') {
      statusEl.textContent = t('fp_auth_done');
      statusEl.style.color = 'var(--green)';
      FP.authHook = prevHook;
      if (typeof afterOk === 'function') afterOk();
    } else if (a && a.state === 'error') {
      statusEl.textContent = t('fp_auth_failed') + (a.error ? ' - ' + a.error : '');
      statusEl.style.color = 'var(--red)';
    }
  }
  paint(FP.auth);
  FP.authHook = paint;
  modal({
    title: t('fp_auth_modal_title'),
    body: h('div', {},
      h('div', { class: 'hint', style: 'line-height:1.9' }, t('fp_auth_step1')),
      h('button', {
        class: 'btn primary block mt',
        onclick: () => API.call('openUrl', { url: (FP.auth && FP.auth.url) || 'https://www.microsoft.com/link' }),
      }, icon('globe'), t('fp_auth_open')),
      h('div', { class: 'hint mt' }, t('fp_auth_step2')),
      codeEl,
      h('div', { class: 'row mt', style: 'justify-content:center' },
        h('button', {
          class: 'btn sm',
          onclick: () => { const c = FP.auth && FP.auth.code; if (c && copyText(c)) toast(t('copied'), 'ok'); },
        }, icon('copy'), t('fp_auth_copy_code'))),
      statusEl),
    actions: [
      { label: t('cancel'), class: 'btn ghost', onClick: () => { BotAPI.op({ op: 'auth_cancel' }); FP.authHook = prevHook; } },
    ],
  });
}

/* ================= Server Pack Downloader (protocol fetch) =================
 * Enter the address of a PUBLIC Minecraft Bedrock server - the protocol engine
 * (libpmbot.so) joins it exactly like a real client, saves every resource pack
 * the server pushes onto its players as .mcpack files into downloads/ and
 * hands them over. No URLs to guess; works on every Bedrock server. */

Views.downloader = (root) => {
  const addrInput = h('input', {
    class: 'text-input mono-ltr', type: 'text', dir: 'ltr',
    placeholder: t('pk_addr_ph'), autocomplete: 'off', spellcheck: 'false',
  });
  const bar = h('div', { class: 'progress', style: 'display:none' }, h('div', { style: 'width:0%' }));
  const statusLine = h('div', { class: 'hint center', style: 'display:none' });
  const resultBox = h('div', {});
  const startBtn = h('button', { class: 'btn primary block mt', onclick: start }, icon('download'), t('pk_start'));
  const stopBtn = h('button', { class: 'btn danger block', style: 'display:none', onclick: cancel }, icon('x'), t('pk_cancel'));

  /* v2.7: connectivity self-test - "does this app even have internet?" */
  const netOut = h('div', { class: 'hint mt', style: 'line-height:2' }, '');
  const netBtn = h('button', {
    class: 'btn sm',
    onclick: () => {
      netBtn.disabled = true;
      netOut.innerHTML = '';
      netOut.appendChild(h('span', { class: 'badge yellow' }, t('pk_net_testing')));
      API.callAsync('net.check', { reqId: 'nc' + Date.now() }).then((r) => {
        netBtn.disabled = false;
        netOut.innerHTML = '';
        const mk = (okFlag, label, extra) => h('span', {
          class: 'badge ' + (okFlag ? 'green' : 'red'), style: 'margin-inline-end:6px',
        }, (okFlag ? '✓ ' : '✗ ') + label + (extra ? ' · ' + extra : ''));
        netOut.appendChild(mk(r.dns, 'DNS', (r.dnsMs >= 0 ? r.dnsMs + 'ms' : (r.dnsError || ''))));
        netOut.appendChild(mk(r.https, 'HTTPS', (r.via || '') + (r.httpsMs >= 0 ? ' ' + r.httpsMs + 'ms' : '')));
        const gh = r.github || {};
        netOut.appendChild(mk(gh['raw.githubusercontent.com'] === true, 'GitHub', (gh['raw.githubusercontent.comMs'] ? gh['raw.githubusercontent.comMs'] + 'ms' : (gh['raw.githubusercontent.comError'] || ''))));
      }).catch((e) => {
        netBtn.disabled = false;
        netOut.innerHTML = '';
        netOut.appendChild(h('span', { class: 'badge red' }, '✗ ' + ((e && e.error) || t('error'))));
      });
    },
  }, icon('globe'), t('pk_net_test'));
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('download'), t('downloader_title')),
    h('div', { class: 'hint mb' }, t('pk_hint')),
    h('label', { class: 'field' }, h('span', { class: 'fl' }, t('pk_addr')), addrInput),
    startBtn, stopBtn, bar, statusLine, resultBox,
    h('div', { class: 'row mt', style: 'gap:8px' }, netBtn),
    netOut));

  /* v2.7: Xbox account card - public servers reject offline clients */
  const authOut = h('div', { class: 'row mt', style: 'gap:8px;flex-wrap:wrap' });
  function paintAuth() {
    authOut.innerHTML = '';
    const ok = FP.auth && FP.auth.state === 'ok';
    authOut.appendChild(h('span', {
      class: 'badge ' + (ok ? 'green' : 'yellow'),
    }, ok ? '✓ ' + (FP.auth.gamertag || t('fp_auth_signed')) : t('fp_auth_needed')));
    if (!ok) {
      authOut.appendChild(h('button', {
        class: 'btn sm primary',
        onclick: () => { FP.authHook = paintAuth; openEngineAuthModal(); BotAPI.op({ op: 'auth_start' }); },
      }, icon('shield'), t('fp_auth_btn')));
    } else {
      authOut.appendChild(h('button', {
        class: 'btn sm',
        onclick: () => { const r = BotAPI.op({ op: 'auth_logout' }); if (r && r.ok === false) toast(r.error, 'err'); paintAuth(); },
      }, icon('x'), t('fp_auth_logout')));
    }
  }
  paintAuth();
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('shield'), t('fp_auth_title')),
      h('span', { class: 'pill bare' })),
    h('div', { class: 'hint mt' }, t('pk_auth_hint')),
    authOut));
  BotAPI.op({ op: 'auth_state' });

  /* previously fetched packs */
  const listCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('archive'), t('pk_prev')));
  root.appendChild(listCard);

  let phaseText = '';
  let totalCount = 0;
  let doneCount = 0;

  function setBusy(v) {
    FP.packsBusy = v;
    startBtn.disabled = v;
    stopBtn.style.display = v ? 'block' : 'none';
    bar.style.display = v ? 'block' : 'none';
    statusLine.style.display = v ? 'block' : 'none';
  }

  function setBar() {
    const pct = totalCount > 0 ? Math.min(100, Math.round(doneCount * 100 / totalCount)) : 0;
    bar.firstChild.style.width = Math.max(6, pct) + '%';
  }

  function start() {
    const addr = addrInput.value.trim();
    if (!/^[a-z0-9._\-]+(:\d{1,5})?$/i.test(addr)) { toast(t('pk_bad_addr'), 'err'); return; }
    resultBox.innerHTML = '';
    setBusy(true);
    totalCount = 0;
    doneCount = 0;
    phaseText = t('pk_connecting');
    statusLine.textContent = phaseText;
    bar.firstChild.style.width = '6%';
    const useAuth = !!(FP.auth && FP.auth.state === 'ok');
    const r = API.call('packs.fetch', { addr, useAuth });
    if (r.ok === false) { setBusy(false); toast(r.error || t('error'), 'err'); }
  }

  function cancel() {
    API.call('packs.stop');
    setBusy(false);
  }

  function packErrText(ev) {
    if (ev.code === 'cancelled') return t('pk_cancelled');
    if (ev.code && t('fp_err_' + ev.code) !== 'fp_err_' + ev.code) return t('fp_err_' + ev.code);
    return (ev && ev.error) || t('error');
  }

  /* live engine events (FP.packHook, driven by BotAPI.handleEvent) */
  function onPackEvent(ev) {
    switch (ev.phase) {
      case 'started':
        setBusy(true);
        phaseText = t('pk_connecting') + ' · ' + (ev.addr || '');
        totalCount = 0;
        doneCount = 0;
        setBar();
        break;
      case 'downloading':
        phaseText = t('pk_downloading').replace('{i}', ev.i).replace('{n}', ev.total);
        totalCount = ev.total || 0;
        setBar();
        break;
      case 'cached':
        doneCount++;
        setBar();
        phaseText = t('pk_cached') + ' · ' + (ev.file || '');
        break;
      case 'packdone':
        doneCount++;
        setBar();
        break;
      case 'error':
        setBusy(false);
        resultBox.innerHTML = '';
        const errCard = h('div', { class: 'card', style: 'border-color:rgba(243,18,96,.4)' },
          h('div', { class: 'hint', style: 'color:var(--red)' }, packErrText(ev)));
        if (ev.code === 'xbox') {
          errCard.appendChild(h('div', { class: 'row mt' },
            h('button', {
              class: 'btn primary sm',
              onclick: () => { FP.authHook = paintAuth; openEngineAuthModal(() => { toast(t('pk_retry_auth'), 'ok'); start(); }); BotAPI.op({ op: 'auth_start' }); },
            }, icon('shield'), t('pk_signin_retry'))));
        }
        resultBox.appendChild(errCard);
        return;
      case 'done':
        setBusy(false);
        renderDone(ev.packs || []);
        renderList();
        return;
    }
    if (ev.phase === 'progress') {
      statusLine.textContent = phaseText + ' · ' + fmtBytes(ev.bytes || 0);
    } else {
      statusLine.textContent = phaseText;
    }
  }

  function renderDone(packs) {
    resultBox.innerHTML = '';
    if (!packs.length) {
      resultBox.appendChild(h('div', { class: 'card' },
        h('div', { class: 'hint center', style: 'color:var(--yellow)' }, t('pk_none'))));
      return;
    }
    const card = h('div', { class: 'card', style: 'border-color:rgba(23,201,100,.4)' },
      h('div', { class: 'spread' },
        h('div', { class: 'card-title', style: 'margin:0;color:#34e07c' }, icon('check'), t('pk_done')),
        h('span', { class: 'badge green' }, packs.length + 'x .mcpack')));
    for (const p of packs) {
      card.appendChild(h('div', { class: 'fm-row' },
        h('span', { class: 'fm-ic', style: 'color:var(--green)' }, icon('download')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, p.name || p.file),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm mono-ltr', dir: 'ltr' }, (p.file || '') + ' · ' + fmtBytes(p.size || 0)))),
        h('div', { class: 'fm-actions' },
          h('button', {
            class: 'icon-btn', onclick: () => saveToDevice(p.file),
          }, icon('download')))));
    }
    card.appendChild(h('div', { class: 'row wrap mt' },
      h('button', {
        class: 'btn sm',
        onclick: () => { App.filesPath = 'downloads'; App.navigate('files'); },
      }, icon('openfolder'), t('dl_open'))));
    resultBox.appendChild(card);
  }

  function saveToDevice(file) {
    API.callAsync('download.save', { path: 'downloads/' + file, suggested: file })
      .then(() => toast(t('saved'), 'ok'))
      .catch((e) => toast((e && e.error) || t('error'), 'err'));
  }

  function renderList() {
    listCard.innerHTML = '';
    listCard.appendChild(h('div', { class: 'card-title' }, icon('archive'), t('pk_prev')));
    const res = API.call('files.ls', { path: 'downloads' });
    const entries = (res.ok && res.entries || []).filter((e) => !e.dir && /\.mcpack$/i.test(e.name)).slice(0, 50);
    if (!entries.length) {
      listCard.appendChild(h('div', { class: 'empty-note' }, t('pk_prev_none')));
      return;
    }
    for (const e of entries) {
      listCard.appendChild(h('div', { class: 'fm-row' },
        h('span', { class: 'fm-ic', style: 'color:var(--green)' }, icon('download')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, e.name),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm' }, fmtBytes(e.size) + ' · ' + fmtDate(e.mtime)))),
        h('div', { class: 'fm-actions' },
          h('button', { class: 'icon-btn', onclick: () => saveToDevice(e.name) }, icon('save')),
          h('button', {
            class: 'icon-btn', onclick: () => {
              confirmModal(t('delete'), e.name, t('delete'), () => {
                API.call('files.delete', { path: 'downloads/' + e.name });
                renderList();
              }, true);
            },
          }, icon('trash')))));
    }
  }

  /* restore the live state when the view is (re)opened mid-fetch */
  FP.packHook = onPackEvent;
  if (FP.packsBusy) {
    setBusy(true);
    phaseText = t('pk_connecting');
    statusLine.textContent = phaseText;
    setBar();
  } else if (FP.packs && FP.packs.phase === 'done') {
    renderDone(FP.packs.packs || []);
  }
  renderList();
  App.cleanup.push(() => { FP.packHook = null; });
};

/* ================= Import Server Package (config zip) ================= */
/* Give the app ONE zip with anything server-related inside (plugins, worlds,
 * packs, server.properties, ...) - the panel analyzes it, shows what it found
 * and puts every piece in the right place of the active server. */

Views.importpkg = (root) => {
  const listBox = h('div', {});
  const resultBox = h('div', {});

  function zipsIn(dir) {
    const r = API.call('files.ls', { path: dir });
    return (r.ok && r.entries || []).filter((e) => !e.dir && /\.zip$/i.test(e.name));
  }

  function renderList() {
    listBox.innerHTML = '';
    const seen = {};
    const zips = [];
    for (const dir of ['uploads', 'downloads', 'backups', '']) {
      for (const e of zipsIn(dir)) {
        const p = (dir ? dir + '/' : '') + e.name;
        if (seen[p]) continue;
        seen[p] = 1;
        zips.push({ path: p, name: e.name, size: e.size, mtime: e.mtime });
      }
    }
    if (!zips.length) {
      listBox.appendChild(h('div', { class: 'empty-note' }, t('import_none')));
      return;
    }
    for (const z of zips) {
      listBox.appendChild(h('div', { class: 'fm-row', onclick: () => analyze(z.path) },
        h('span', { class: 'fm-ic', style: 'color:var(--yellow)' }, icon('archive')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, z.name),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm mono-ltr', dir: 'ltr' }, (z.path || '') + ' · ' + fmtBytes(z.size))))));
    }
  }

  function analyze(path) {
    if (['running', 'starting'].includes(App.status.state)) { toast(t('stopped_first'), 'err'); return; }
    resultBox.innerHTML = '';
    resultBox.appendChild(h('div', { class: 'hint center' }, '⏳ ' + t('import_analyzing')));
    API.callAsync('zipimport.analyze', { src: path })
      .then((ev) => {
        resultBox.innerHTML = '';
        const total = (ev.plugins_c || 0) + (ev.worlds_c || 0) + (ev.packs_c || 0)
          + (ev.configs_c || 0) + ((ev.data || []).length);
        if (!total) {
          resultBox.appendChild(h('div', { class: 'hint', style: 'color:var(--yellow)' }, '⚠ ' + t('import_nothing')));
          return;
        }
        showConfirm(ev, total);
      })
      .catch((e) => {
        resultBox.innerHTML = '';
        resultBox.appendChild(h('div', { class: 'hint', style: 'color:var(--red)' }, (e && e.error) || t('error')));
      });
  }

  function row(label, names, color) {
    if (!names || !names.length) return null;
    const shown = names.slice(0, 6).join('، ');
    const more = names.length > 6 ? ' +' + (names.length - 6) : '';
    return h('div', { class: 'kv' },
      h('span', { class: 'k' }, label + ' (' + names.length + ')'),
      h('span', { class: 'v', style: 'color:' + color }, shown + more));
  }

  function showConfirm(ev, total) {
    const applyBtn = h('button', { class: 'btn primary block' }, icon('import'), t('import_apply'));
    applyBtn.addEventListener('click', () => {
      applyBtn.disabled = true;
      API.callAsync('zipimport.apply', { stageId: ev.stageId })
        .then((r) => {
          toast(t('import_applied') +
            ' · ' + (r.plugins || 0) + ' ' + t('plugin_s') +
            ' · ' + (r.worlds || 0) + ' ' + t('world_s'), 'ok');
          resultBox.innerHTML = '';
          renderList();
        })
        .catch((e) => {
          applyBtn.disabled = false;
          toast((e && e.error) || t('error'), 'err');
        });
    });
    const body = h('div', {},
      row(t('plugins_label'), ev.plugins, 'var(--purple)'),
      row(t('worlds'), ev.worlds, 'var(--green)'),
      row(t('packs_label'), ev.packs, 'var(--yellow)'),
      row(t('import_configs'), ev.configs, 'var(--cyan)'),
      row(t('import_data'), ev.data, 'var(--muted)'),
      h('div', { class: 'hint mt' }, t('import_confirm_hint')),
      applyBtn);
    modal({
      title: t('import_found') + ' (' + total + ')',
      body,
      actions: [{ label: t('cancel'), class: 'btn ghost' }],
    });
  }

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('import'), t('import_title')),
    h('div', { class: 'hint mb' }, t('import_hint')),
    h('button', {
      class: 'btn block mb',
      onclick: () => {
        API.call('files.mkdir', { path: 'uploads' });
        API.callAsync('upload.pick', { dir: 'uploads', multiple: false })
          .then((e2) => {
            const f = (e2.files || []).find((x) => !x.error && /\.zip$/i.test(x.name));
            if (!f) { toast(t('import_zip_bad'), 'err'); return; }
            analyze('uploads/' + f.name);
            renderList();
          })
          .catch((e) => toast((e && e.error && e.error !== 'cancelled' ? e.error : '') || '', 'err'));
      },
    }, icon('upload'), t('import_upload')),
    h('div', { class: 'cc-section' }, t('import_pick')),
    listBox,
    resultBox));

  renderList();
};

/* ================= Public IP ================= */

Views.publicip = (root) => {
  const info = { publicIp: '', localIp: '', port: 19132, running: false };
  const pubVal = h('div', { class: 'pip-ip mono-ltr' }, '···');
  const joinVal = h('div', { class: 'pip-ip mono-ltr', style: 'color:var(--primary-hi)' }, '···');
  const chip = h('span', { class: 'badge yellow' }, '—');
  const resultBox = h('div', { class: 'mt' });
  const localRow = h('span', { class: 'v mono-ltr' }, '—');
  const portRow = h('span', { class: 'v mono-ltr' }, '—');
  const guideBox = h('div', {});

  function copyBtn(getVal) {
    return h('button', {
      class: 'icon-btn', title: t('copied'),
      onclick: () => { const v = getVal(); if (v && copyText(v)) toast(t('copied'), 'ok'); },
    }, icon('copy'));
  }

  const testBtn = h('button', {
    class: 'btn primary',
    onclick: () => {
      if (!info.publicIp) { toast(t('pip_unknown'), 'err'); return; }
      testBtn.disabled = true;
      chip.className = 'badge yellow';
      chip.textContent = t('pip_testing');
      resultBox.innerHTML = '';
      API.callAsync('pubip.ping', { host: info.publicIp, port: info.port })
        .then((ev) => {
          chip.className = 'badge green';
          chip.textContent = '✓ ' + t('pip_ok');
          resultBox.innerHTML = '';
          resultBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'MOTD'), h('span', { class: 'v' }, ev.motd || '—')));
          resultBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, t('players')), h('span', { class: 'v' }, (ev.players >= 0 ? ev.players : '?') + ' / ' + (ev.maxPlayers >= 0 ? ev.maxPlayers : '?'))));
          resultBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_latency')), h('span', { class: 'v' }, ev.latencyMs + 'ms')));
          testBtn.disabled = false;
        })
        .catch((e) => {
          chip.className = 'badge red';
          chip.textContent = t('pip_fail');
          resultBox.innerHTML = '';
          resultBox.appendChild(h('div', { class: 'hint', style: 'color:var(--red)' }, (e && e.error) || t('error')));
          resultBox.appendChild(h('div', { class: 'hint mt' }, t('pip_selfping_note')));
          testBtn.disabled = false;
        });
      /* local server liveness check in parallel */
      if (info.running) {
        API.callAsync('pubip.ping', { host: '127.0.0.1', port: info.port })
          .then((ev) => {
            resultBox.appendChild(h('div', { class: 'kv' },
              h('span', { class: 'k' }, t('pip_local_alive')),
              h('span', { class: 'v' }, '✓ ' + (ev.motd || '') + ' · ' + ev.latencyMs + 'ms')));
          })
          .catch(() => { /* local server not responding yet - ignore */ });
      }
    },
  }, icon('check'), t('pip_test'));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('globe'), t('pip_title')),
    h('div', { class: 'spread', style: 'align-items:flex-start' },
      h('div', {},
        h('div', { class: 'k', style: 'font-size:12px;color:var(--muted)' }, t('pip_public')),
        pubVal,
        h('div', { class: 'k', style: 'font-size:12px;color:var(--muted);margin-top:10px' }, t('pip_join')),
        joinVal),
      h('div', { class: 'row', style: 'flex-direction:column;gap:8px' },
        copyBtn(() => info.publicIp),
        copyBtn(() => info.publicIp ? info.publicIp + ':' + info.port : ''))),
    h('div', { class: 'row mt', style: 'gap:10px' }, chip, testBtn),
    resultBox));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('home'), t('pip_local')),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_lan_ip')), localRow),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_port')), portRow),
    h('div', { class: 'hint mt' }, t('pip_lan_hint'))));

  /* ---- one-tap UPnP port mapping ---- */
  const upnpBox = h('div', {});
  const upnpBtn = h('button', {
    class: 'btn success block mt',
    onclick: () => {
      if (!info.localIp) { toast(t('pip_unknown'), 'err'); return; }
      upnpBtn.disabled = true;
      upnpBox.innerHTML = '';
      upnpBox.appendChild(h('div', { class: 'hint center' }, '⏳ ' + t('pip_upnp_working')));
      API.callAsync('pubip.upnp', { port: info.port })
        .then((ev) => {
          upnpBtn.disabled = false;
          upnpBox.innerHTML = '';
          if (ev.mapped) {
            const joinAddr = (ev.externalIp || info.publicIp) + ':' + info.port;
            upnpBox.appendChild(h('div', { class: 'hint', style: 'color:var(--green)' }, '✓ ' + t('pip_upnp_ok')));
            upnpBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_join')), h('span', { class: 'v mono-ltr' }, joinAddr)));
            if (ev.gateway) upnpBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_upnp_gateway')), h('span', { class: 'v mono-ltr' }, ev.gateway)));
            if (ev.externalIp) upnpBox.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, t('pip_upnp_external')), h('span', { class: 'v mono-ltr' }, ev.externalIp)));
            /* refresh the join line at the top with the router's real IP */
            if (ev.externalIp && info.publicIp !== ev.externalIp) {
              info.publicIp = ev.externalIp;
              pubVal.textContent = info.publicIp;
              joinVal.textContent = info.publicIp + ':' + info.port;
            }
          } else {
            upnpBox.appendChild(h('div', { class: 'hint', style: 'color:var(--yellow)' }, '⚠ ' + (ev.error ? t('pip_upnp_fail') + ' - ' + ev.error : t('pip_upnp_none'))));
          }
        })
        .catch((e) => {
          upnpBtn.disabled = false;
          upnpBox.innerHTML = '';
          upnpBox.appendChild(h('div', { class: 'hint', style: 'color:var(--red)' }, (e && e.error) || t('error')));
        });
    },
  }, icon('globe'), t('pip_upnp_btn'));
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('globe'), t('publicip_title')),
    upnpBtn,
    upnpBox));

  const guide = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('info'), t('pip_guide_title')),
    guideBox,
    h('button', {
      class: 'btn block mt',
      onclick: () => API.call('openUrl', { url: 'https://playit.gg' }),
    }, icon('globe'), t('pip_tunnel_btn')));
  root.appendChild(guide);

  function renderGuide() {
    guideBox.innerHTML = '';
    const step = (n, text) => h('div', { class: 'row', style: 'align-items:flex-start;gap:10px;margin:8px 0' },
      h('span', { class: 'badge accent', style: 'flex:none' }, n),
      h('div', { class: 'hint', style: 'line-height:1.9' }, text));
    guideBox.appendChild(step('1', t('pip_step_lan').replace('{ip}', info.localIp || '—').replace('{port}', String(info.port))));
    guideBox.appendChild(step('2', t('pip_step_fwd').replace('{port}', String(info.port)).replace('{ip}', info.localIp || '—')));
    guideBox.appendChild(step('3', t('pip_step_mobile')));
    guideBox.appendChild(h('div', { class: 'hint mt' }, t('pip_join_addr') + ' ' + (info.publicIp || '—') + ':' + info.port));
  }

  pubVal.textContent = '···';
  API.callAsync('pubip.info')
    .then((ev) => {
      info.publicIp = ev.publicIp || '';
      info.localIp = ev.localIp || '';
      info.port = ev.port || 19132;
      info.running = !!ev.running;
      pubVal.textContent = info.publicIp || '—';
      joinVal.textContent = info.publicIp ? info.publicIp + ':' + info.port : '—';
      localRow.textContent = info.localIp || '—';
      portRow.textContent = String(info.port);
      chip.className = info.running ? 'badge green' : 'badge yellow';
      chip.textContent = info.running ? t('running') : t('stopped');
      renderGuide();
    })
    .catch((e) => {
      pubVal.textContent = '—';
      joinVal.textContent = '—';
      chip.className = 'badge red';
      chip.textContent = (e && e.error) || t('error');
      renderGuide();
    });
  renderGuide();
};
