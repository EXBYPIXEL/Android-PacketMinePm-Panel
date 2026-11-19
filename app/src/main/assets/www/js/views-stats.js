/* views-stats.js - detailed live server statistics (Tools > Server stats)
 * Data sources, all real:
 *  - stats.get  : process (pid/rss/cpu/uptime), console-derived TPS/network,
 *                 server.properties values, GameSpy query (players, plugins,
 *                 map, version, whitelist) against 127.0.0.1:<port>
 *  - stats.storage : directory sizes + content counts (polled slower)
 *  - the TPS numbers are fed by the panel sending `status` while this page
 *    is open (the toggle below), the same way an operator would type it. */

'use strict';

Views.stats = (root) => {
  const live = { last: null, storage: null };
  const info = App.info || {};

  /* ---------- header ---------- */
  const profObj = App.activeProfileObj();
  root.appendChild(h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('chart'), t('stats_title')),
      h('span', { class: 'badge accent' }, (profObj && profObj.name) || App.activeProfile)),
    h('div', { class: 'hint mt' }, t('stats_hint'))));

  /* ---------- performance tiles ---------- */
  const tileEls = {};
  function perfTile(key, labelKey, mono) {
    const v = h('div', { class: 'sv-val mono-ltr' }, '—');
    tileEls[key] = v;
    return h('div', { class: 'sv-tile' }, v, h('div', { class: 'sv-lab' }, t(labelKey)));
  }
  const perfGrid = h('div', { class: 'sv-grid' },
    perfTile('state', 'state_label'),
    perfTile('uptime', 'uptime'),
    perfTile('tps', 'stat_tps'),
    perfTile('load', 'stat_load'),
    perfTile('cpu', 'stat_cpu'),
    perfTile('ram', 'ram_usage'),
    perfTile('netUp', 'stat_net_up'),
    perfTile('netDown', 'stat_net_down'),
    perfTile('pid', 'pid'),
    perfTile('players', 'players'));
  const perfCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('refresh'), t('stat_perf_title')),
    perfGrid,
    h('div', { class: 'hint mt', id: 'statPerfNote' }, ''));

  /* ---------- players ---------- */
  const playerList = h('div', { class: 'sv-players' },
    h('div', { class: 'empty-note' }, t('stat_no_players')));
  const playersCard = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('users'), t('players')),
      h('span', { class: 'badge', id: 'statPlayerBadge' }, '0/20')),
    playerList);

  /* ---------- query (live server info) ---------- */
  const qKv = h('div', { class: 'kv2col' });
  const queryCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('info'), t('stat_query_title')),
    qKv,
    h('div', { class: 'hint mt', id: 'statQueryNote' }, ''));

  /* ---------- raw status block ---------- */
  const statusBlock = h('div', { class: 'console', style: 'height:190px' });
  const statusCard = h('div', { class: 'card' },
    h('div', { class: 'spread' },
      h('div', { class: 'card-title', style: 'margin:0' }, icon('terminal'), t('stat_raw_title')),
      h('button', {
        class: 'btn sm',
        onclick: () => { sendConsole('status'); sendConsole('list'); toast(t('stat_cmd_sent'), 'ok'); },
      }, icon('play'), t('stat_send_cmds'))),
    h('div', { class: 'mt' },
      h('div', { class: 'console-shell', style: 'flex:none' }, statusBlock,
        h('div', { class: 'hidden' }))));

  /* ---------- storage ---------- */
  const bar = h('div', { class: 'progress' }, h('div', { style: 'width:6%' }));
  const sizeRows = h('div', { class: 'kv2col' });
  const topWorlds = h('div', { class: 'kv2col' });
  const storageCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, icon('archive'), t('stat_storage_title')),
    bar,
    sizeRows,
    h('div', { class: 'card-title', style: 'margin:12px 0 2px;font-size:13px' }, t('stat_top_worlds')),
    topWorlds);

  root.appendChild(perfCard);
  root.appendChild(playersCard);
  root.appendChild(queryCard);
  root.appendChild(statusCard);
  root.appendChild(storageCard);

  /* helpers */
  function kv(parent, k, v, mono) {
    if (!parent) return;
    parent.appendChild(h('div', { class: 'kv' },
      h('span', { class: 'k' }, k),
      h('span', { class: 'v' + (mono ? ' mono-ltr' : '') }, v)));
  }
  function setTile(key, text) {
    if (tileEls[key]) tileEls[key].textContent = text;
  }
  function sendConsole(cmd) {
    const r = API.call('command', { text: cmd });
    if (r && r.ok === false) toast(r.error || t('error'), 'err');
  }
  function pushConsoleLine(text) {
    const first = statusBlock.firstElementChild;
    if (first && first.classList.contains('empty')) first.remove();
    const div = h('div', { class: 'ln' });
    div.innerHTML = ansiToHtml(text);
    statusBlock.appendChild(div);
    while (statusBlock.childElementCount > 160 && statusBlock.firstElementChild) {
      statusBlock.firstElementChild.remove();
    }
    statusBlock.scrollTop = statusBlock.scrollHeight;
  }

  /* live TPS feed: while the page is open, type `status` into the console
   * every 8s so the engine reports TPS/network (toggleable, default on). */
  const feedBtn = h('button', {
    class: 'btn sm',
    onclick: () => {
      live.feed = !live.feed;
      paintFeed();
      toast(live.feed ? t('stat_feed_on') : t('stat_feed_off'), 'ok');
    },
  });
  live.feed = localStorage.getItem('pm_stat_feed') !== '0';
  function paintFeed() {
    feedBtn.className = 'btn sm' + (live.feed ? ' primary' : '');
    feedBtn.innerHTML = '';
    feedBtn.appendChild(icon(live.feed ? 'check' : 'x'));
    feedBtn.appendChild(h('span', {}, t('stat_tps_feed')));
  }
  paintFeed();
  perfCard.appendChild(h('div', { class: 'row mt', style: 'gap:8px' }, feedBtn));

  /* ---------- polling ---------- */
  let ticks = 0;
  function paintLive(st) {
    live.last = st;
    const running = ['running', 'starting'].includes(st.state);
    setTile('state', t(st.state));
    tileEls.state.className = 'sv-val mono-ltr st-' + st.state;
    setTile('uptime', running ? fmtUptime(st.uptimeSec || 0) : '—');
    setTile('tps', st.tpsCurrent !== undefined && (st.tpsAgeSec || 0) < 30
      ? (st.tpsCurrent.toFixed ? st.tpsCurrent.toFixed(1) : st.tpsCurrent) : '—');
    setTile('load', st.tickLoad !== undefined ? st.tickLoad + '%' : '—');
    setTile('cpu', st.cpuPercent !== undefined && st.cpuPercent >= 0 ? st.cpuPercent + '%' : '—');
    setTile('ram', st.rssKb > 0 ? fmtBytes(st.rssKb * 1024) : '—');
    setTile('netUp', st.netUpKbps >= 0 ? st.netUpKbps.toFixed(1) + ' kB/s' : '—');
    setTile('netDown', st.netDownKbps >= 0 ? st.netDownKbps.toFixed(1) + ' kB/s' : '—');
    setTile('pid', st.pid > 0 ? String(st.pid) : '—');
    setTile('players', (st.playersCount || 0) + '/' + (st.playersMax || 20));

    /* players list (query result wins - it is the live truth) */
    const q = st.query || {};
    const names = (q.players && q.players.length ? q.players : st.playersOnline) || [];
    const badge = qs('#statPlayerBadge');
    if (badge) badge.textContent = (st.playersCount || 0) + '/' + (st.playersMax || 20);
    playerList.innerHTML = '';
    if (!names.length) {
      playerList.appendChild(h('div', { class: 'empty-note' },
        running ? t('stat_no_players') : t('stat_stopped')));
    } else {
      for (const n of names) {
        playerList.appendChild(h('div', { class: 'fm-row' },
          h('span', { class: 'fm-ic', style: 'color:var(--green)' }, icon('users')),
          h('div', { class: 'fm-main' }, h('div', { class: 'fm-name' }, n))));
      }
    }

    /* query card */
    qKv.innerHTML = '';
    if (running && q.hostname !== undefined) {
      kv(qKv, 'MOTD', q.hostname || '—', true);
      kv(qKv, t('version'), q.version || '—', true);
      kv(qKv, t('stat_engine'), q.server_engine || '—', true);
      kv(qKv, t('stat_gametype'), q.gametype || '—', true);
      kv(qKv, t('stat_map'), q.map || '—', true);
      kv(qKv, t('whitelist'), q.whitelist === 'on' ? t('yes') : t('no'));
      kv(qKv, t('port'), String(q.hostport || st.port || '—'), true);
      const pl = String(q.plugins || '');
      kv(qKv, t('stat_plugins'), pl ? pl.split(';').length - 1 + '' : '0');
    } else if (running && st.queryError) {
      qKv.appendChild(h('div', { class: 'hint' }, '⚠ ' + t('stat_query_fail')));
    }
    const qn = qs('#statQueryNote');
    if (qn) qn.textContent = running && st.queryError ? String(st.queryError) : '';

    /* perf note: exit code / last error */
    const note = qs('#statPerfNote');
    if (note) {
      if (st.state === 'crashed' && st.lastError) {
        note.textContent = '⚠ ' + t('last_crash') + ': ' + st.lastError;
        note.style.color = 'var(--red)';
      } else if (st.exitCode > 0) {
        note.textContent = t('exit_code') + ': ' + st.exitCode;
        note.style.color = '';
      } else {
        note.textContent = '';
      }
    }
  }

  function paintStorage(s) {
    live.storage = s;
    const total = s.total || 0;
    const free = s.free || 0;
    const used = Math.max(0, total - free);
    const pct = total > 0 ? Math.min(100, Math.round(used * 100 / total)) : 0;
    bar.firstChild.style.width = Math.max(4, pct) + '%';
    sizeRows.innerHTML = '';
    const labels = {
      worlds: 'worlds', plugins: 'stat_plugins', plugins_disabled: 'stat_plugins_disabled',
      plugin_data: 'plugin_data', players: 'stat_player_files', resource_packs: 'stat_packs',
      logs: 'logs_title', backups: 'backup_title', downloads: 'stat_downloads', crashdumps: 'stat_crashdumps', resource_packs: 'stat_packs',
    };
    for (const k of Object.keys(s.sizes || {})) {
      kv(sizeRows, t(labels[k] || k), fmtBytes(s.sizes[k]), true);
    }
    kv(sizeRows, t('stat_total'), fmtBytes(s.total || 0), true);
    kv(sizeRows, t('free_space'), fmtBytes(free || 0), true);
    kv(sizeRows, t('stat_cache'), fmtBytes(s.cache || 0), true);
    kv(sizeRows, t('stat_counts'), (s.pluginCount || 0) + ' ' + t('stat_plugins_lc') + ' · '
      + (s.worldCount || 0) + ' ' + t('stat_worlds_lc') + ' · ' + (s.packCount || 0) + ' ' + t('stat_packs_lc'), true);
    topWorlds.innerHTML = '';
    for (const w of Object.keys(s.topWorlds || {})) {
      kv(topWorlds, w, fmtBytes(s.topWorlds[w]), true);
    }
  }

  function poll() {
    ticks++;
    try {
      const st = API.call('stats.get');
      if (st.ok !== false) paintLive(st);
      if (live.feed && st.state === 'running' && ticks % 4 === 0) sendConsole('status');
      if (st.state === 'running' && ticks % 6 === 0) sendConsole('list');
      if (ticks % 10 === 1) {
        const s = API.call('stats.storage');
        if (s.ok !== false) paintStorage(s);
      }
      /* mirror the newest console lines into the raw block */
      const con = API.call('console', { after: live.conSeq || 0 });
      if (con.ok && con.lines && con.lines.length) {
        live.conSeq = con.last;
        if (con.session !== live.conSession) {
          live.conSession = con.session;
          statusBlock.innerHTML = '';
          pushConsoleLine('—');
        }
        for (const pair of con.lines) pushConsoleLine(pair[1]);
      }
    } catch (e) { /* keep polling */ }
  }
  poll();
  const timer = setInterval(poll, 2200);
  App.cleanup.push(() => clearInterval(timer));
};
