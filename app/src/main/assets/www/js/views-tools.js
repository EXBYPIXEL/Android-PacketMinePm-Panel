/* views-tools.js - tools grid, settings, players, logs, backup, update, about */

'use strict';

/* ================= Tools grid ================= */
Views.tools = (root) => {
  const items = [
    ['stats', 'chart', 'stats_title'],
    ['market', 'market', 'market_title'],
    ['fakeplayers', 'users', 'fakeplayers_title'],
    ['compiler', 'pharfile', 'compiler_title'],
    ['downloader', 'download', 'downloader_title'],
    ['importpkg', 'import', 'import_title'],
    ['publicip', 'globe', 'publicip_title'],
    ['players', 'users', 'players_title'],
    ['logs', 'scroll', 'logs_title'],
    ['backup', 'archive', 'backup_title'],
    ['update', 'refresh', 'update_title'],
    ['about', 'info', 'about_title'],
  ];
  /* settings moved to the top bar (next to the server status) but stays
   * reachable here as well */
  items.push(['settings', 'settings', 'settings_title']);
  const grid = h('div', { class: 'grid2' });
  for (const [id, ic, labelKey] of items) {
    grid.appendChild(h('button', {
      class: 'tool-tile',
      onclick: () => App.navigate(id),
    },
    h('span', { class: 'tt-ic' }, icon(ic, 20)),
    h('span', { class: 'tt-lb' }, t(labelKey))));
  }
  root.appendChild(h('div', { class: 'card-title' }, icon('grid'), t('nav_tools')));
  root.appendChild(grid);
};

/* ================= Settings ================= */
const PROP_GROUPS = [
  {
    titleKey: 'group_general',
    fields: [
      { k: 'motd', type: 'text' },
      { k: 'server-port', type: 'number' },
      { k: 'server-portv6', type: 'number' },
      { k: 'enable-ipv6', type: 'bool' },
      { k: 'max-players', type: 'number' },
      { k: 'white-list', type: 'bool' },
    ],
  },
  {
    titleKey: 'group_gameplay',
    fields: [
      { k: 'gamemode', type: 'select', options: ['SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR'] },
      { k: 'difficulty', type: 'select', options: ['0', '1', '2', '3'], labels: ['peaceful', 'easy', 'normal', 'hard'] },
      { k: 'force-gamemode', type: 'bool' },
      { k: 'hardcore', type: 'bool' },
      { k: 'pvp', type: 'bool' },
      { k: 'view-distance', type: 'number' },
      { k: 'auto-save', type: 'bool' },
    ],
  },
  {
    titleKey: 'tab_worlds',
    fields: [
      { k: 'level-name', type: 'text' },
      { k: 'level-seed', type: 'text' },
      { k: 'level-type', type: 'select', options: ['DEFAULT', 'FLAT'] },
      { k: 'generator-settings', type: 'text' },
    ],
  },
  {
    titleKey: 'group_advanced',
    fields: [
      { k: 'enable-query', type: 'bool' },
      { k: 'xbox-auth', type: 'bool' },
      { k: 'language', type: 'text' },
    ],
  },
];

const PROP_LABELS = {
  motd: 'motd', 'server-port': 'server_port', 'server-portv6': 'server_portv6', 'enable-ipv6': 'enable_ipv6',
  'white-list': 'whitelist', 'max-players': 'max_players', gamemode: 'gamemode', difficulty: 'difficulty',
  'force-gamemode': 'force_gamemode', hardcore: 'hardcore', pvp: 'pvp', 'view-distance': 'view_distance',
  'level-name': 'level_name', 'level-seed': 'level_seed', 'level-type': 'level_type', 'auto-save': 'auto_save',
  'enable-query': 'enable_query', 'xbox-auth': 'xbox_auth', language: 'language_prop',
  'generator-settings': 'generator_settings',
};

/* section divider: "Server" / "App" headers inside Settings */
function settingsSection(iconName, labelKey) {
  return h('div', { class: 'settings-section' },
    h('span', { class: 'ss-ic' }, icon(iconName, 17)),
    h('span', { class: 'ss-lb' }, t(labelKey)));
}

Views.settings = (root) => {
  const props = API.call('props.get');
  const prefs = API.call('prefs.get');
  const running = App.status.state === 'running' || App.status.state === 'starting';
  const values = {};
  const propsMissing = !props.ok || !(props.lines || []).some((l) => l.type === 'k');
  if (props.ok) {
    for (const l of props.lines || []) if (l.type === 'k') values[l.key] = l.value;
  }

  /* --- section: SERVER --- */
  root.appendChild(settingsSection('world', 'settings_section_server'));

  /* --- which server this page edits (v2.5: every server owns its settings) --- */
  const profSel = h('select', { class: 'text-input' });
  const profList = App.profiles.length ? App.profiles
    : [{ id: App.activeProfile, name: (prefs.ok && prefs.profileName) || App.activeProfile }];
  for (const p of profList) {
    profSel.appendChild(h('option', { value: p.id, selected: p.id === App.activeProfile }, p.name));
  }
  profSel.addEventListener('change', () => {
    if (profSel.value && profSel.value !== App.activeProfile) App.setProfile(profSel.value);
  });
  root.appendChild(h('div', { class: 'card' },
    h('label', { class: 'field' }, h('span', { class: 'fl' }, t('settings_for_server')), profSel),
    h('div', { class: 'hint mt' }, t('settings_scope_hint'))));

  /* --- structured server properties --- */
  const propsCard = h('div', { class: 'card' });
  if (propsMissing) {
    propsCard.appendChild(h('div', { class: 'hint' }, t('not_installed_hint')));
  } else {
    for (const g of PROP_GROUPS) {
      propsCard.appendChild(h('div', { class: 'badge', style: 'display:inline-block;margin:10px 0 4px' }, t(g.titleKey)));
      const grid = h('div', { class: 'form-grid' });
      for (const f of g.fields) {
        grid.appendChild(fieldInput(f, values[f.k]));
      }
      propsCard.appendChild(grid);
    }
    const saveBtn = h('button', { class: 'btn primary block mt', onclick: saveProps }, icon('save'), t('save_props'));
    if (running) {
      saveBtn.disabled = true;
      propsCard.appendChild(h('div', { class: 'hint', style: 'color:var(--yellow)' }, '⚠ ' + t('stopped_first')));
    }
    propsCard.appendChild(saveBtn);
  }
  root.appendChild(propsCard);

  function fieldInput(f, val) {
    const id = 'prop_' + f.k;
    let input;
    if (f.type === 'bool') {
      input = h('label', { class: 'switch' },
        h('input', { type: 'checkbox', id: id, checked: val === 'on' }),
        h('span', { class: 'track' }));
    } else if (f.type === 'select') {
      input = h('select', { class: 'text-input', id: id },
        f.options.map((o, i) => h('option', { value: o, selected: String(val) === o },
          (f.labels ? f.labels[i] : o))));
    } else {
      input = h('input', { class: 'text-input', id: id, type: f.type === 'number' ? 'number' : 'text', value: val || '' });
    }
    return h('label', { class: 'field' },
      h('span', { class: 'fl' }, t(PROP_LABELS[f.k] || f.k)),
      input);
  }

  function saveProps() {
    const lines = (props.lines || []).map((l) => {
      if (l.type !== 'k') return l;
      const el = qs('#prop_' + l.key);
      if (!el) return l;
      let v;
      if (el.type === 'checkbox') v = el.checked ? 'on' : 'off';
      else v = el.value;
      return { type: 'k', key: l.key, value: v };
    });
    // append missing standard keys
    for (const g of PROP_GROUPS) {
      for (const f of g.fields) {
        if (!(f.k in values)) {
          const el = qs('#prop_' + f.k);
          if (el) lines.push({ type: 'k', key: f.k, value: el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value });
        }
      }
    }
    const r = API.call('props.set', { lines });
    if (r.ok === false) toast(r.error, 'err');
    else toast(t('props_saved'), 'ok');
  }

  /* --- per-server memory limit (moved out of App settings in v2.5) --- */
  const memCard = h('div', { class: 'card' });
  if (prefs.ok) {
    const memSel = h('select', { class: 'text-input' },
      [256, 512, 768, 1024, 1536, 2048].map((m) =>
        h('option', { value: m, selected: prefs.memoryLimitMb === m }, m + ' MB')));
    memSel.addEventListener('change', () => {
      const r = API.call('prefs.set', { memoryLimitMb: parseInt(memSel.value, 10) });
      if (r.ok === false) toast(r.error, 'err');
      else toast(t('props_saved'), 'ok');
    });
    memCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'fl' }, t('memory_limit')), memSel));
    memCard.appendChild(h('div', { class: 'hint mt' }, t('memory_limit_hint')));
  } else {
    memCard.appendChild(h('div', { class: 'hint' }, t('error')));
  }
  root.appendChild(memCard);

  /* --- raw files --- */
  const rawCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('edit'), t('edit_file')),
    rawBtn('server.properties'),
    rawBtn('pocketmine.yml'),
    rawBtn('php.ini'));
  root.appendChild(rawCard);
  function rawBtn(name) {
    return h('button', {
      class: 'btn block', style: 'margin-bottom:8px',
      onclick: () => Editor.open(name),
    }, icon('filecode'), name);
  }

  /* --- section: APP --- */
  root.appendChild(settingsSection('shield', 'settings_section_app'));

  /* --- app settings (global: language, screen, battery) --- */
  const appCard = h('div', { class: 'card' });

  /* language */
  const langSel = h('select', { class: 'text-input' },
    h('option', { value: 'fa', selected: LANG === 'fa' }, 'فارسی'),
    h('option', { value: 'en', selected: LANG === 'en' }, 'English'));
  langSel.addEventListener('change', () => setLang(langSel.value));
  appCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'fl' }, t('language')), langSel));

  /* toggles */
  function toggleRow(label, checked, onSet) {
    const cb = h('input', { type: 'checkbox', checked: checked });
    cb.addEventListener('change', () => onSet(cb.checked));
    return h('div', { class: 'spread', style: 'padding:8px 0;border-bottom:1px dashed var(--border)' },
      h('span', { style: 'font-size:13.5px' }, label),
      h('label', { class: 'switch' }, cb, h('span', { class: 'track' })));
  }
  if (prefs.ok) {
    appCard.appendChild(toggleRow(t('wakelock'), prefs.wakeLock, (v) => API.call('prefs.set', { wakeLock: v })));
    appCard.appendChild(toggleRow(t('keep_screen'), prefs.keepScreenOn, (v) => API.call('prefs.set', { keepScreenOn: v })));
  }

  /* battery */
  appCard.appendChild(h('button', { class: 'btn block mt', onclick: () => API.call('batteryOpt') }, icon('battery'), t('battery_opt')));
  appCard.appendChild(h('div', { class: 'hint mt' }, t('battery_opt_hint')));

  root.appendChild(appCard);
};

/* ================= Players ================= */
Views.players = (root) => {
  const running = App.status.state === 'running';

  const onlineList = h('div', { class: 'row wrap' });
  function renderOnline() {
    onlineList.innerHTML = '';
    if (!App.playersOnline.length) {
      onlineList.appendChild(h('div', { class: 'hint' }, t('no_online')));
      return;
    }
    for (const name of App.playersOnline) {
      onlineList.appendChild(h('span', {
        class: 'badge green', style: 'cursor:pointer;font-size:12.5px;padding:6px 12px',
        onclick: () => playerMenu(name),
      }, '● ' + name));
    }
  }
  renderOnline();
  App.onPlayers = renderOnline;

  const refreshBtn = h('button', {
    class: 'btn sm', onclick: () => {
      if (!running) { toast(t('no_online'), 'err'); return; }
      Console.send('list');
    },
  }, icon('refresh'), t('refresh_list'));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('users'), t('online_players') + ' (' + App.playersOnline.length + ')'),
      refreshBtn),
    h('div', { class: 'mt' }, onlineList)));

  function playerMenu(name) {
    modal({
      title: name,
      body: h('div', {}),
      actions: [
        { label: 'kick', class: 'btn', onClick: () => Console.send('kick ' + name) },
        { label: 'ban', class: 'btn danger', onClick: () => Console.send('ban ' + name) },
        { label: 'op', class: 'btn', onClick: () => Console.send('op ' + name) },
        { label: 'deop', class: 'btn ghost', onClick: () => Console.send('deop ' + name) },
        { label: t('cancel'), class: 'btn ghost' },
      ],
    });
  }

  /* player data files */
  const filesCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('file'), t('player_files')));
  const res = API.call('files.ls', { path: 'players' });
  if (res.ok && (res.entries || []).length) {
    for (const e of res.entries) {
      filesCard.appendChild(h('div', { class: 'fm-row' },
        h('span', { class: 'fm-ic' }, icon('file')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, e.name),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm' }, fmtBytes(e.size)))),
        h('div', { class: 'fm-actions' },
          h('button', {
            class: 'icon-btn', onclick: () => {
              confirmModal(t('delete'), e.name + ' — ' + t('player_files_hint'), t('delete'), () => {
                API.call('files.delete', { path: 'players/' + e.name });
                App.rerender();
              }, true);
            },
          }, icon('trash')))));
    }
    filesCard.appendChild(h('div', { class: 'hint' }, t('player_files_hint')));
  } else {
    filesCard.appendChild(h('div', { class: 'hint' }, t('empty_dir')));
  }
  root.appendChild(filesCard);

  /* quick files */
  const quickCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('edit'), t('ban_list')));
  ['ops.txt', 'banned-players.txt', 'banned-ips.txt', 'whitelist.txt'].forEach((f) => {
    quickCard.appendChild(h('button', {
      class: 'btn block', style: 'margin-bottom:8px',
      onclick: () => Editor.open(f),
    }, icon('filecode'), f));
  });
  root.appendChild(quickCard);

  App.cleanup.push(() => { App.onPlayers = null; });
};

/* ================= Logs ================= */
Views.logs = (root) => {
  const listCard = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('scroll'), t('logs_title')),
      h('div', { class: 'row' },
        h('button', {
          class: 'icon-btn', onclick: () => {
            confirmModal(t('clear_logs'), t('clear_logs_confirm'), t('delete'), () => {
              API.call('logs.clear');
              App.rerender();
            }, true);
          },
        }, icon('trash')))));

  const res = API.call('logs.list');
  if (res.ok && (res.entries || []).length) {
    for (const e of res.entries) {
      listCard.appendChild(h('div', { class: 'fm-row', onclick: () => openLog(e) },
        h('span', { class: 'fm-ic', style: 'color:var(--cyan)' }, icon('scroll')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, e.name),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm' }, fmtBytes(e.size) + ' · ' + fmtDate(e.mtime))))));
    }
  } else {
    listCard.appendChild(h('div', { class: 'empty-note' }, t('console_empty')));
  }
  root.appendChild(listCard);

  function openLog(e) {
    const r = API.call('logs.read', { name: e.name });
    const content = r.ok ? (r.content || '') : (r.error || '');
    const pre = h('div', {
      class: 'console', style: 'height:52vh',
      html: content.split('\n').map((l) => '<div class="ln">' + ansiToHtml(l) + '</div>').join(''),
    });
    modal({
      title: e.name,
      body: pre,
      actions: [
        {
          label: t('save_to_device'), class: 'btn primary',
          onClick: () => {
            API.callAsync('download.save', { path: 'logs/' + e.name, suggested: e.name })
              .then(() => toast(t('saved'), 'ok'))
              .catch((err) => toast(err.error || t('error'), 'err'));
          },
        },
        {
          label: t('delete'), class: 'btn danger',
          onClick: () => {
            API.call('logs.delete', { name: e.name });
            App.rerender();
          },
        },
        { label: t('close'), class: 'btn ghost' },
      ],
    });
  }
};

/* ================= Backup ================= */
Views.backup = (root) => {
  const createBtn = h('button', {
    class: 'btn success block', onclick: create,
  }, icon('archive'), t('create_backup'));
  const restoreBtn = h('button', {
    class: 'btn block mt', onclick: restore,
  }, icon('upload'), t('restore_backup'));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('archive'), t('backup_title')),
    h('div', { class: 'hint mb' }, t('backup_hint')),
    createBtn, restoreBtn));

  const listCard = h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('save'), t('saved_backups')));
  const res = API.call('backup.list');
  if (res.ok && (res.entries || []).length) {
    for (const e of res.entries) {
      listCard.appendChild(h('div', { class: 'fm-row' },
        h('span', { class: 'fm-ic', style: 'color:var(--yellow)' }, icon('archive')),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, e.name),
          h('div', { class: 'fm-meta' }, h('span', { class: 'm' }, fmtBytes(e.size)))),
        h('div', { class: 'fm-actions' },
          h('button', {
            class: 'icon-btn', onclick: () => {
              API.callAsync('download.save', { path: 'backups/' + e.name, suggested: e.name })
                .then(() => toast(t('saved'), 'ok'))
                .catch((err) => toast(err.error || t('error'), 'err'));
            },
          }, icon('download')),
          h('button', {
            class: 'icon-btn', onclick: () => {
              confirmModal(t('delete'), e.name, t('delete'), () => {
                API.call('files.delete', { path: 'backups/' + e.name });
                App.rerender();
              }, true);
            },
          }, icon('trash')))));
    }
  } else {
    listCard.appendChild(h('div', { class: 'empty-note' }, t('no_backups')));
  }
  root.appendChild(listCard);

  function create() {
    createBtn.disabled = true;
    createBtn.appendChild(document.createTextNode('...'));
    API.callAsync('backup.create')
      .then((ev) => {
        toast(t('saved') + ': ' + ev.name + ' (' + fmtBytes(ev.size) + ')', 'ok');
        App.rerender();
      })
      .catch((e) => { toast(e.error || t('error'), 'err'); App.rerender(); });
  }

  function restore() {
    if (App.status.state === 'running') { toast(t('stopped_first'), 'err'); return; }
    confirmModal(t('restore_backup'), t('restore_confirm'), t('confirm'), () => {
      API.callAsync('backup.restore')
        .then((ev) => {
          toast(t('files_restored').replace('{n}', ev.files || 0), 'ok');
          App.rerender();
        })
        .catch((e) => toast(e.error || t('error'), 'err'));
    }, true);
  }
};

/* ================= Update / swap phar ================= */
Views.update = (root) => {
  const info = App.info || {};
  const phar = info.phar || {};

  /* current phar */
  const cur = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('info'), t('current_phar')),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'PocketMine-MP.phar'), h('span', { class: 'v' }, phar.exists ? fmtBytes(phar.size) : '—')),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, t('version')), h('span', { class: 'v' }, (info.bundle || {}).ngVersion || '—')),
    h('div', { class: 'hint mt' }, t('update_note')));
  if (phar.backupExists) {
    cur.appendChild(h('button', {
      class: 'btn block mt', onclick: () => {
        if (App.status.state === 'running') { toast(t('stopped_first'), 'err'); return; }
        confirmModal(t('restore_prev'), '', t('apply'), () => {
          const r = API.call('phar.apply', { path: 'PocketMine-MP.phar.bak' });
          if (r.ok === false) toast(r.error, 'err');
          else { toast(t('phar_applied'), 'ok'); App.refreshInfo(); }
        });
      },
    }, icon('restart'), t('restore_prev')));
  }
  root.appendChild(cur);

  /* check updates */
  const resultBox = h('div', {});
  const checkBtn = h('button', {
    class: 'btn primary block', onclick: () => {
      checkBtn.disabled = true;
      resultBox.innerHTML = '';
      resultBox.appendChild(h('div', { class: 'hint center' }, t('checking')));
      API.callAsync('update.check')
        .then((ev) => renderResults(ev))
        .catch((e) => { resultBox.innerHTML = ''; resultCardError(e); checkBtn.disabled = false; });
    },
  }, icon('refresh'), t('check_updates'));
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('globe'), t('update_title')),
    checkBtn,
    h('div', { class: 'mt' }, resultBox)));

  function resultCardError(e) {
    resultBox.appendChild(h('div', { class: 'hint', style: 'color:var(--red)' }, (e && e.error) || t('error')));
  }

  function renderResults(ev) {
    resultBox.innerHTML = '';
    checkBtn.disabled = false;

    /* NG source */
    const src = ev.ngSource || {};
    const srcCard = h('div', { class: 'list-item', style: 'flex-direction:column;align-items:stretch' },
      h('div', { class: 'spread' },
        h('span', { style: 'font-weight:700;font-size:13.5px' }, t('ng_source')),
        src.sha === src.bundledSha ? h('span', { class: 'badge green' }, 'up-to-date') : h('span', { class: 'badge yellow' }, 'new commits')),
      h('div', { class: 'li-sub mono-ltr', style: 'margin:6px 0' },
        'bundled: ' + String(src.bundledSha || '').slice(0, 8) + ' → latest: ' + String(src.sha || '').slice(0, 8)),
      h('div', { class: 'hint' }, t('ng_source_note')));
    resultBox.appendChild(srcCard);

    /* NG community builds */
    const ng = ev.ngBuilds || {};
    if (ng.url) {
      const ngCard = h('div', { class: 'list-item' },
        h('span', { style: 'color:var(--purple)' }, icon('puzzle')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, t('ng_builds')),
          h('div', { class: 'li-sub' }, ng.tag + ' · ' + fmtDate(Date.parse(ng.date) || 0) + ' · ' + fmtBytes(ng.size))),
        h('button', { class: 'btn sm primary', onclick: () => download(ng.url, 'ng') }, t('download_install')));
      resultBox.appendChild(ngCard);
    } else {
      resultBox.appendChild(h('div', { class: 'hint' }, t('ng_builds') + ': ' + (ng.error || '—')));
    }

    /* official pmmp */
    const pm = ev.pmmp || {};
    if (pm.url) {
      const pmCard = h('div', { class: 'list-item' },
        h('span', { style: 'color:var(--accent2)' }, icon('globe')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, t('pmmp_latest')),
          h('div', { class: 'li-sub' }, pm.tag + ' · ' + fmtDate(Date.parse(pm.date) || 0) + ' · ' + fmtBytes(pm.size))),
        h('button', { class: 'btn sm primary', onclick: () => download(pm.url, 'pmmp') }, t('download_install')));
      resultBox.appendChild(pmCard);
    } else {
      resultBox.appendChild(h('div', { class: 'hint' }, t('pmmp_latest') + ': ' + (pm.error || '—')));
    }
  }

  function download(url, flavor) {
    if (App.status.state === 'running') { toast(t('stopped_first'), 'err'); return; }
    const bar = h('div', { class: 'progress mt' }, h('div', { style: 'width:0%' }));
    const label = h('div', { class: 'hint center mt' }, t('downloading') + ' 0%');
    resultBox.appendChild(h('div', { class: 'card' }, bar, label));
    API.callAsync('update.download', { url, flavor }, (pct) => {
      bar.firstChild.style.width = pct + '%';
      label.textContent = t('downloading') + ' ' + pct + '%';
    })
      .then(() => { toast(t('phar_applied'), 'ok'); App.refreshInfo(); App.rerender(); })
      .catch((e) => { toast(e.error || t('error'), 'err'); });
  }

  /* custom phar upload */
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('upload'), t('phar_upload')),
    h('div', { class: 'hint mb' }, t('update_note')),
    h('button', {
      class: 'btn block', onclick: () => {
        if (App.status.state === 'running') { toast(t('stopped_first'), 'err'); return; }
        API.call('files.mkdir', { path: 'uploads' });
        API.callAsync('upload.pick', { dir: 'uploads', multiple: false })
          .then((ev) => {
            const f = (ev.files || []).find((x) => !x.error && /\.phar$/i.test(x.name));
            if (!f) { toast('.phar ?'); return; }
            const r = API.call('phar.apply', { path: 'uploads/' + f.name });
            if (r.ok === false) toast(r.error, 'err');
            else { toast(t('phar_applied'), 'ok'); App.refreshInfo(); }
          })
          .catch((e) => toast(e.error || t('error'), 'err'));
      },
    }, icon('upload'), t('upload_phar_btn'))));
};

/* ================= About ================= */
Views.about = (root) => {
  const info = App.info || {};
  const bundle = info.bundle || {};
  const dev = info.device || {};

  function kv(k, v) {
    return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  }

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('info'), t('versions')),
    kv('App', info.appVersion || '—'),
    kv('Server', (bundle.ngVersion || '—') + ' (' + String(bundle.ngCommit || '').slice(0, 7) + ')'),
    kv('PHP', bundle.phpVersion || '—'),
    kv('Minecraft', bundle.mcSupport || '—'),
    kv('Built', bundle.builtAt || '—')));

  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('grid'), t('server_info')),
    kv('Device', (dev.manufacturer || '') + ' ' + (dev.model || '')),
    kv('Android', (dev.android || '—') + ' (SDK ' + dev.sdk + ')'),
    kv('ABI', dev.abi || '—'),
    kv('RAM', fmtBytes(dev.totalRam || 0)),
    kv('Path', info.serverDir || '—')));

  /* storage */
  const st = API.call('storageInfo');
  if (st.ok) {
    const box = h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon('archive'), t('storage_usage')));
    const total = st.total || 1;
    for (const [k, v] of Object.entries(st.sizes || {})) {
      box.appendChild(h('div', { class: 'mb' },
        h('div', { class: 'spread', style: 'font-size:12px;margin-bottom:4px' },
          h('span', {}, k),
          h('span', { style: 'color:var(--muted)' }, fmtBytes(v))),
        h('div', { class: 'progress' }, h('div', { style: 'width:' + Math.min(100, v * 100 / total) + '%' }))));
    }
    box.appendChild(h('div', { class: 'spread', style: 'font-size:12.5px' },
      h('span', { class: 'k' }, 'total'), h('span', {}, fmtBytes(st.total))));
    box.appendChild(h('div', { class: 'spread', style: 'font-size:12.5px' },
      h('span', { class: 'k' }, t('free_space')), h('span', {}, fmtBytes(st.free))));
    root.appendChild(box);
  }

  /* links */
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('globe'), t('links')),
    linkBtn('NetherGamesMC/PocketMine-MP', 'https://github.com/NetherGamesMC/PocketMine-MP'),
    linkBtn('pmmp/PocketMine-MP', 'https://github.com/pmmp/PocketMine-MP'),
    linkBtn('Poggit plugins', 'https://poggit.pmmp.io/plugins')));
  function linkBtn(label, url) {
    return h('button', {
      class: 'btn block', style: 'margin-bottom:8px',
      onclick: () => API.call('openUrl', { url }),
    }, icon('globe'), label);
  }

  /* licenses */
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('shield'), t('licenses')),
    h('div', { class: 'hint' }, t('view_license')),
    h('div', { class: 'hint mt' }, t('credits'))));
};
