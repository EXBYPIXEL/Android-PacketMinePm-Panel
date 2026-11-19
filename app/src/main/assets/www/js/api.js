/* api.js - bridge to native side, with a browser mock for development */

'use strict';

const API = (() => {
  let evSeq = 0;
  const pending = {};

  window.__pmEvent = function (ev) {
    if (!ev || !ev.reqId) return;
    const p = pending[ev.reqId];
    if (!p) return;
    if (typeof ev.progress === 'number' && ev.ok !== false && p.onProgress) {
      p.onProgress(ev.progress, ev); // second arg: raw event (done/total bytes)
      return; // keep waiting for the final event
    }
    delete pending[ev.reqId];
    if (ev.ok === false) p.reject(ev);
    else p.resolve(ev);
  };

  function native() {
    return !!(window.PMPanel && typeof window.PMPanel.api === 'function');
  }

  /* v2.4 multi-server: stamp the active profile on every call unless the
   * caller already chose one (background consoles pass an explicit id).
   * NOTE: App is a top-level `const` in app.js, so it is a global LEXICAL
   * binding — `window.App` is undefined in every browser/WebEngine. The old
   * `window.App &&` guard therefore never fired and EVERY implicit call was
   * routed to the default profile ("start server 2, server 1 runs" /
   * "already running"). Reference the binding directly instead. */
  function withProfile(base, params) {
    const p = Object.assign({}, params || {});
    if (p.profile === undefined) {
      try {
        if (typeof App !== 'undefined' && App && App.activeProfile) {
          p.profile = App.activeProfile;
        }
      } catch (e) { /* App not loaded yet (early boot calls) - use default */ }
    }
    return Object.assign(base, p);
  }

  function errText(e) {
    // "Error: Java exception was raised during method invocation" is Chromium's
    // generic bridge-exception message; the native side no longer lets anything
    // escape, but keep the text short if it ever surfaces.
    if (e && e.message && e.message.indexOf('Java exception was raised') >= 0) {
      return 'bridge error - please reopen the app';
    }
    return String(e && e.message ? e.message : e);
  }

  function call(cmd, params) {
    if (native()) {
      try {
        return JSON.parse(window.PMPanel.api(JSON.stringify(withProfile({ cmd }, params))));
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    }
    return Mock.handle(cmd, params || {});
  }

  /* Async call. The reply arrives later via window.__pmEvent. The caller may
   * pass its own reqId inside params - it MUST be honoured, otherwise the
   * native side echoes a different id than the one we registered and the
   * promise never settles (this silently hung market.install/net.check). */
  function callAsync(cmd, params, onProgress) {
    const reqId = params && params.reqId ? String(params.reqId) : 'e' + (++evSeq);
    return new Promise((resolve, reject) => {
      pending[reqId] = { resolve, reject, onProgress };
      if (native()) {
        let res;
        try {
          res = JSON.parse(window.PMPanel.api(JSON.stringify(withProfile({ cmd, reqId }, params))));
        } catch (e) {
          delete pending[reqId];
          reject({ ok: false, error: errText(e) });
          return;
        }
        if (res && res.ok === false) {
          delete pending[reqId];
          reject(res);
        } else if (res && !res.async) {
          delete pending[reqId];
          resolve(res);
        }
      } else {
        setTimeout(() => Mock.handleAsync(cmd, params || {}, reqId), 350);
      }
    });
  }

  return { call, callAsync, isNative: native };
})();

/* ================= Browser mock (visual dev only) ================= */
const Mock = (() => {
  let state = 'running';
  let bootAt = Date.now() - 137e3;
  let seq = 0;
  let session = 1;
  const lines = [];
  const playersOnline = ['Steve', 'Alex'];

  /* PM5 Android console output uses 256-color SGR + lone-ESC resets */
  const C = (n) => '\x1b[38;5;' + n + 'm';
  const R = '\x1b';
  const G = (s) => C(145) + s + R; // gray prefix

  function push(txt) {
    lines.push([++seq, txt]);
    if (lines.length > 900) lines.shift();
  }

  [
    'Preparing PocketMine-MP.phar decompressed cache...',
    G('[Server thread/INFO]:') + ' Loading server configuration',
    G('[Server thread/INFO]:') + ' Selected ' + C(87) + 'English (eng)' + R + ' as the base language',
    G('[Server thread/INFO]:') + ' Starting Minecraft: Bedrock Edition server version ' + C(83) + 'v1.26.60' + R,
    G('[Server thread/INFO]:') + ' This server is running ' + C(227) + 'NG-PocketMine-MP version 5.51.2' + R,
    G('[Server thread/INFO]:') + ' Loading resource packs...',
    C(214) + '[Server thread/ALERT]:' + R + ' RakNet is deprecated and will be removed in a future release.',
    G('[Server thread/INFO]:') + ' Preparing world ' + C(37) + '"world"' + R,
    G('[Server thread/INFO]:') + ' Spawning terrain for world "world" in the background',
    G('[Server thread/INFO]:') + ' ' + C(83) + 'Minecraft network interface running on 0.0.0.0:19132' + R,
    G('[Server thread/INFO]:') + ' Default game type: Survival Mode',
    C(203) + '[Server thread/EMERGENCY]:' + R + ' Crash test (red)',
    G('[Server thread/INFO]:') + ' ' + C(83) + 'Done (7.412s)!' + R + ' For help, type ' + C(227) + '"help"' + R + ' or ' + C(227) + '"?"' + R,
    C(214) + '[Server thread/ALERT]:' + R + ' A new release is available: 5.52.0',
  ].forEach((l, i) => setTimeout(() => push(l), i * 90));

  const mockBot = { running: false, names: [] };

  /* stateful mock profiles so create/delete/list stay consistent in dev */
  const mockProfiles = [
    { id: 'default', name: 'Server 1', state: 'running', uptimeSec: 137, port: 19132 },
    { id: 's2', name: 'SkyBlock', state: 'idle', uptimeSec: 0, port: 19134 },
  ];

  const tree = {
    'PocketMine-MP.phar': { size: 6964895, mtime: Date.now() - 86400e3 },
    'php.ini': { size: 306, mtime: Date.now() - 86400e3, content: 'memory_limit=1024M\ndate.timezone=UTC\n' },
    'server.properties': {
      size: 398, mtime: Date.now() - 3600e3,
      content: '#Properties Configfile\n#Mon Nov 16 21:23:28 UTC 2026\nmotd=NG-PocketMine-MP Server\nserver-port=19132\nserver-portv6=19133\nenable-ipv6=on\nwhite-list=off\nmax-players=20\ngamemode=SURVIVAL\nforce-gamemode=off\nhardcore=off\npvp=on\ndifficulty=2\ngenerator-settings=\nlevel-name=world\nlevel-seed=\nlevel-type=DEFAULT\nenable-query=on\nauto-save=on\nview-distance=16\nxbox-auth=on\nlanguage=eng\n',
    },
    'pocketmine.yml': { size: 13534, mtime: Date.now() - 3600e3, content: 'settings:\n  enable-dev-builds: true\n' },
    'plugin_list.yml': { size: 278, mtime: Date.now() - 3600e3, content: 'mode: blacklist\nplugins: []\n' },
    'worlds/': { dir: true, mtime: Date.now() - 3500e3 },
    'worlds/world/': { dir: true, mtime: Date.now() - 3500e3 },
    'worlds/world/level.dat': { size: 2418, mtime: Date.now() - 3500e3 },
    'worlds/world/levelname.txt': { size: 8, mtime: Date.now() - 3500e3, content: 'My World\n' },
    'worlds/skyblock/': { dir: true, mtime: Date.now() - 86000e3 },
    'worlds/skyblock/level.dat': { size: 3120, mtime: Date.now() - 86000e3 },
    'plugins/': { dir: true, mtime: Date.now() - 3500e3 },
    'plugins/EconomyAPI.phar': { size: 512341, mtime: Date.now() - 7200e3 },
    'plugins/DevTools.phar': { size: 233301, mtime: Date.now() - 172800e3 },
    'plugins/src/': { dir: true, mtime: Date.now() - 7200e3 },
    'plugins/src/TestPlugin/': { dir: true, mtime: Date.now() - 7200e3 },
    'plugins/src/TestPlugin/plugin.yml': { size: 120, mtime: Date.now() - 7200e3, content: 'name: TestPlugin\nversion: 1.0.0\nmain: Test\\Main\napi: 5.0.0\n' },
    'downloads/': { dir: true, mtime: Date.now() - 3500e3 },
    'downloads/PocketMine-MP.phar': { size: 7163904, mtime: Date.now() - 2600e3 },
    'downloads/Hive Season Pack v2.4.1.mcpack': { size: 12416390, mtime: Date.now() - 1200e3 },
    'downloads/Competitive Texture Pack v1.9.0.mcpack': { size: 3412500, mtime: Date.now() - 1100e3 },
    'uploads/': { dir: true, mtime: Date.now() - 3500e3 },
    'uploads/config-pack.zip': { size: 2345678, mtime: Date.now() - 2600e3 },
    'plugins_disabled/': { dir: true, mtime: Date.now() - 3500e3 },
    'plugins_disabled/OldPlugin.phar': { size: 88123, mtime: Date.now() - 900000e3 },
    'plugin_data/': { dir: true, mtime: Date.now() - 3500e3 },
    'players/': { dir: true, mtime: Date.now() - 3500e3 },
    'resource_packs/': { dir: true, mtime: Date.now() - 3500e3 },
    'resource_packs/Faithful.mcpack': { size: 8912333, mtime: Date.now() - 260000e3 },
    'logs/': { dir: true, mtime: Date.now() - 3500e3 },
    'logs/server-demo.log': { size: 12845, mtime: Date.now() - 600e3, content: '[Server thread/INFO]: demo log line 1\n[Server thread/INFO]: Done (7.4s)!\n' },
    'ops.txt': { size: 0, mtime: Date.now() - 86400e3, content: '' },
    'banned-players.txt': { size: 0, mtime: Date.now() - 86400e3, content: '' },
  };

  const pluginsDb = {
    'plugins/EconomyAPI.phar': { name: 'EconomyAPI', version: '5.7.2', author: 'onebone', description: 'Handles all money-related tasks in your server with many features.', api: '5.0.0' },
    'plugins/DevTools.phar': { name: 'DevTools', version: '1.15.0', author: 'PocketMine Team', description: 'Plugin development tools plugin for PocketMine-MP', api: '5.0.0' },
    'plugins_disabled/OldPlugin.phar': { name: 'OldPlugin', version: '1.2.0', author: 'someone', description: 'An old plugin that is currently disabled.', api: '3.0.0' },
  };

  function listDir(path) {
    const set = {};
    const pfx = path ? path.replace(/\/$/, '') + '/' : '';
    for (const k of Object.keys(tree)) {
      if (pfx && !k.startsWith(pfx)) continue;
      const rest = k.slice(pfx.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        set[rest] = { name: rest, dir: false, size: tree[k].size || 0, mtime: tree[k].mtime || 0 };
      } else {
        const d = rest.slice(0, slash);
        if (!set[d]) set[d] = { name: d, dir: true, size: 0, mtime: Date.now() - 3600e3 };
      }
    }
    return Object.values(set).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  setInterval(() => {
    if (state === 'running' && Math.random() < 0.4) {
      push(G('[Server thread/INFO]:') + ' Auto-save ' + C(83) + 'completed' + R + ' for world "world"');
    }
  }, 5000);

  function handle(cmd, p) {
    switch (cmd) {
      case 'ping': return { ok: true, pong: true };
      case 'status':
        return {
          ok: true, state, uptimeSec: state === 'running' ? Math.floor((Date.now() - bootAt) / 1000) : 0,
          pid: 12345, exitCode: 0, rssKb: 412544, freeSpace: 21e9, consoleLast: seq, session,
        };
      case 'info':
        return {
          ok: true, appVersion: '1.1.0',
          bundle: { ngVersion: '5.51.2', ngCommit: 'eaa2e58', mcSupport: '1.20.0 - 1.26.60', phpVersion: '8.4.16 (ZTS)', builtAt: '2026-11-16' },
          phar: { exists: true, size: 6964895, mtime: Date.now() - 86400e3, backupExists: true },
          device: { model: 'Pixel Mock', manufacturer: 'Google', android: '15', sdk: 35, abi: 'arm64-v8a', totalRam: 8e9 },
          serverDir: '/data/data/com.pmpanel.app/files/server', phpBinaryOk: true,
        };
      case 'console': {
        const after = p.after || 0;
        return { ok: true, lines: lines.filter(([s]) => s > after), last: seq, session };
      }
      case 'command':
        if (state !== 'running') return { ok: false, error: 'server is not running' };
        setTimeout(() => {
          if (p.text === 'list') push(G('[Server thread/INFO]:') + ' There are ' + playersOnline.length + '/20 players online: ' + C(87) + playersOnline.join(', ') + R);
          else if (p.text === 'status') push(G('[Server thread/INFO]:') + ' This server is running ' + C(227) + 'NG-PocketMine-MP version 5.51.2' + R);
          else if (p.text === 'stop') { state = 'stopped'; push(G('[Server thread/INFO]:') + ' Stopping server'); push(G('[Server thread/INFO]:') + ' Stopping other threads'); }
          else push(C(203) + '[Server thread/ERROR]:' + R + ' Unknown command: ' + p.text + '. Type "help" for help.');
        }, 200);
        push('> ' + p.text);
        return { ok: true };
      case 'start':
        if (state === 'running') return { ok: false, error: 'already running' };
        state = 'starting'; bootAt = Date.now();
        session++;
        lines.length = 0; // mirror the native side: console buffer is cleared on start
        setTimeout(() => { state = 'running'; push(G('[Server thread/INFO]:') + ' ' + C(83) + 'Done (6.1s)!' + R + ' For help, type "help" or "?"'); }, 2200);
        return { ok: true };
      case 'stop': case 'restart':
        setTimeout(() => {
          state = 'stopped';
          if (cmd === 'restart') { state = 'starting'; session++; setTimeout(() => { state = 'running'; push(G('[Server thread/INFO]:') + ' ' + C(83) + 'Done (4.2s)!' + R); }, 2000); }
        }, 900);
        return { ok: true };
      case 'stats.get':
        return {
          ok: true, state: 'running', uptimeSec: 137 + seq, pid: 4321, exitCode: 0,
          rssKb: 412544 + (seq % 7) * 1024, cpuPercent: 6.3 + (seq % 5), freeSpace: 21e9,
          consoleLast: seq, session, profile: 'default', name: 'Server 1',
          tpsCurrent: 19.7, tpsAverage: 19.9, tickLoad: 6.2, netUpKbps: 4.1, netDownKbps: 12.8,
          tpsAgeSec: 2, playersCount: 2, playersMax: 20, playersOnline: ['Steve', 'Alex'],
          port: 19132,
          props: { motd: 'NG-PocketMine-MP Server', 'max-players': '20', gamemode: 'SURVIVAL' },
          query: { hostname: 'NG-PocketMine-MP Server', gametype: 'SMP', game_id: 'MINECRAFTPE',
            version: 'v1.26.60', server_engine: 'NG-PocketMine-MP 5.51.2', plugins: 'NG-PocketMine-MP 5.51.2:EconomyAPI 5.7.2;DevTools 1.15.0;',
            map: 'world', numplayers: '2', maxplayers: '20', whitelist: 'off',
            hostip: '0.0.0.0', hostport: '19132', players: ['Steve', 'Alex'] },
        };
      case 'stats.storage':
        return { ok: true, sizes: { worlds: 84e6, plugins: 12e6, plugin_data: 3e6, players: 0.4e6,
            resource_packs: 9e6, logs: 2.2e6, backups: 130e6, downloads: 15e6 },
          total: 256e6, free: 21e9, cache: 11e6, pluginCount: 2, worldCount: 2, packCount: 1,
          playerFiles: 1, topWorlds: { world: 84e6, skyblock: 2e6 } };
      case 'market.meta':
        return { ok: true, meta: { count: 1442, built: Date.now() - 3600e3, source: 'github.com/poggit/release-archive' } };
      case 'market.search': {
        const db = [
          { n: 'EconomyAPI', a: 'poggit-orphanage', v: '5.7.3-PM4', t: 'Handles all money-related tasks in your server.', dl: 132938, s: 5, api: '5.0.0', off: 1, ab: 0, ph: 'poggit-orphanage/EconomyAPI/5.7.3-PM4/EconomyAPI_5.7.3-PM4.phar', vp: [['5.7.3-PM4', 'poggit-orphanage/EconomyAPI/5.7.3-PM4/EconomyAPI_5.7.3-PM4.phar'], ['5.7.2', 'poggit-orphanage/EconomyAPI/5.7.2/EconomyAPI_5.7.2.phar']] },
          { n: 'EssentialsPE', a: ' EssentialsPE team', v: '2.1.0', t: 'Essential commands for your server.', dl: 98211, s: 4, api: '5.0.0', off: 0, ab: 0, ph: 'x/EssentialsPE/2.1.0/EssentialsPE_2.1.0.phar', vp: [['2.1.0', 'x/EssentialsPE/2.1.0/EssentialsPE_2.1.0.phar']] },
          { n: 'PureChat', a: 'DetectiveRD', v: '1.5.1', t: 'Custom chat formats per world/group.', dl: 54312, s: 3, api: '5.0.0', off: 0, ab: 1, ph: 'x/PureChat/1.5.1/PureChat_1.5.1.phar', vp: [['1.5.1', 'x/PureChat/1.5.1/PureChat_1.5.1.phar']] },
          { n: 'WorldGuard', a: 'MMCoder', v: '3.0.2', t: 'Region protection engine.', dl: 41002, s: 4, api: '5.0.0', off: 0, ab: 0, ph: 'x/WorldGuard/3.0.2/WorldGuard_3.0.2.phar', vp: [['3.0.2', 'x/WorldGuard/3.0.2/WorldGuard_3.0.2.phar']] },
        ];
        const q = (p.q || '').toLowerCase();
        return { ok: true, results: db.filter((x) => !q || (x.n + x.a + x.t).toLowerCase().includes(q)) };
      }
      case 'net.check':
        return { ok: true, dns: true, dnsMs: 42, dnsIp: '185.199.108.133', https: true, httpsMs: 190, via: 'cp.cloudflare.com',
          github: { 'raw.githubusercontent.com': true, 'raw.githubusercontent.comMs': 320 } };
      case 'files.ls':
        return { ok: true, path: p.path || '', entries: listDir(p.path || ''), freeSpace: 21e9, totalSpace: 64e9 };
      case 'files.read': {
        const f = tree[p.path];
        if (!f) return { ok: false, error: 'file not found' };
        return { ok: true, content: f.content || '(binary)', size: f.size, truncated: false, binary: !f.content, name: p.path };
      }
      case 'files.write':
        tree[p.path] = { size: (p.content || '').length, mtime: Date.now(), content: p.content || '' };
        return { ok: true };
      case 'files.delete':
        delete tree[p.path];
        Object.keys(tree).forEach((k) => { if (k.startsWith((p.path || '') + '/')) delete tree[k]; });
        return { ok: true };
      case 'files.rename': {
        const dir = (p.path || '').split('/').slice(0, -1).join('/');
        const to = dir ? dir + '/' + p.name : p.name;
        if (tree[p.path]) { tree[to] = tree[p.path]; delete tree[p.path]; }
        return { ok: true };
      }
      case 'files.mkdir': tree[p.path + '/'] = { dir: true, mtime: Date.now() }; return { ok: true };
      case 'files.newfile': tree[p.path] = { size: 0, mtime: Date.now(), content: '' }; return { ok: true };
      case 'files.unzip':
        tree[(p.dest || 'x') + '/manifest.json'] = { size: 10, mtime: Date.now(), content: '{}' };
        tree[(p.dest || 'x') + '/level.dat'] = { size: 2418, mtime: Date.now() };
        return { ok: true, files: 3 };
      case 'props.get': {
        const f = tree['server.properties'];
        const out = [];
        (f.content || '').split('\n').forEach((line) => {
          const m = line.match(/^([^#=!\s][^=]*)=(.*)$/);
          if (m) out.push({ type: 'k', key: m[1].trim(), value: m[2] });
          else out.push({ type: 'c', text: line });
        });
        return { ok: true, lines: out };
      }
      case 'props.set': return { ok: true };
      case 'prefs.get': return { ok: true, wakeLock: true, keepScreenOn: false, memoryLimitMb: 1024 };
      case 'prefs.set': return { ok: true };
      case 'logs.list':
        return { ok: true, entries: listDir('logs').map((e) => ({ name: e.name.replace(/\/$/, ''), size: e.size, mtime: e.mtime })) };
      case 'logs.read': {
        const f = tree['logs/' + p.name];
        return { ok: true, name: p.name, content: f ? f.content : '' };
      }
      case 'logs.delete': case 'logs.clear': return { ok: true };
      case 'plugins.list': {
        const out = [];
        for (const [file, meta] of Object.entries(pluginsDb)) {
          const e = tree[file];
          if (!e) continue;
          out.push(Object.assign({
            valid: true, file, format: 'phar', enabled: !file.startsWith('plugins_disabled/'),
            size: e.size, mtime: e.mtime,
          }, meta));
        }
        return { ok: true, plugins: out };
      }
      case 'worlds.list': {
        const worlds = [];
        for (const e of listDir('worlds')) {
          if (!e.dir) continue;
          const ln = tree['worlds/' + e.name + '/levelname.txt'];
          worlds.push({
            folder: 'worlds/' + e.name, name: e.name,
            levelName: ln ? ln.content.trim() : e.name,
            size: 41e6 + e.name.length * 1e5, mtime: e.mtime,
            isDefault: e.name === 'world',
          });
        }
        return { ok: true, worlds, default: 'world' };
      }
      case 'packs.list': {
        const packs = [];
        for (const e of listDir('resource_packs')) {
          if (e.dir) continue;
          packs.push({
            valid: true, file: 'resource_packs/' + e.name,
            name: e.name.replace(/\.(mcpack|zip)$/i, ''), version: '1.2.0',
            uuid: 'a1b2c3d4-' + e.name.length + 'e5f6-7890-abcd-ef1234567890',
            format: 'zip', size: e.size, mtime: e.mtime,
          });
        }
        return { ok: true, packs };
      }
      case 'storageInfo':
        return {
          ok: true, sizes: { worlds: 41e6, plugins: 2.1e6, players: 12e3, logs: 0.3e6 }, total: 45e6, free: 21e9, cache: 38e6,
        };
      case 'backup.list':
        return { ok: true, entries: [{ name: 'backup-2026-11-15_10-00-00.zip', size: 2.4e7, mtime: Date.now() - 86400e3 }] };
      case 'bot.status':
        return { ok: true, engine: true, running: mockBot.running };
      case 'bot.start':
        mockBot.running = true;
        setTimeout(() => { window.__pmBotEvent({ ev: 'ready', engine: '2.0.1', protocol: 2225, version: '1.26.60' }); }, 150);
        return { ok: true, running: true };
      case 'bot.cmd': {
        let op = {};
        try { op = JSON.parse(p.line); } catch (e) { return { ok: false, error: 'bad json' }; }
        if (op.op === 'spawn') mockBot.names = op.names || [];
        if (op.op === 'ping') {
          setTimeout(() => window.__pmBotEvent({ ev: 'pong', ok: true, addr: op.addr, motd: 'Mock Server', submotd: 'PMPanel', protocol: '2225', version: '1.26.60', players: '2', max: '20' }), 700);
        } else if (op.op === 'spawn') {
          let i = 0;
          for (const n of op.names || []) {
            i++;
            const nm = n;
            setTimeout(() => window.__pmBotEvent({ ev: 'status', name: nm, state: 'joining', msg: 'connecting' }), i * 320);
            setTimeout(() => {
              window.__pmBotEvent({ ev: 'status', name: nm, state: 'online', msg: 'joined the server' });
              window.__pmBotEvent({ ev: 'chat', name: nm, text: '\u25b6 ' + nm + ' joined' });
            }, i * 320 + 900);
          }
        } else if (op.op === 'say') {
          const nm = op.to === 'all' ? (mockBot.names[0] || 'Bot1') : op.to;
          setTimeout(() => window.__pmBotEvent({ ev: 'chat', name: nm, text: '<' + nm + '> ' + op.text }), 500);
        } else if (op.op === 'kick') {
          const targets = op.to === 'all' ? mockBot.names : [op.to];
          for (const nm of targets) {
            setTimeout(() => {
              window.__pmBotEvent({ ev: 'status', name: nm, state: 'left', msg: 'kicked' });
              window.__pmBotEvent({ ev: 'chat', name: nm, text: '\u25c0 ' + nm + ' left' });
            }, 400);
          }
        } else if (op.op === 'list') {
          setTimeout(() => window.__pmBotEvent({ ev: 'bots', list: mockBot.names.map((n) => ({ name: n, state: 'online', msg: '' })) }), 300);
        }
        return { ok: true };
      }
      case 'bot.stop':
        mockBot.running = false;
        return { ok: true, running: false };
      /* pack fetcher: replay a realistic engine event chain */
      case 'packs.fetch': {
        const mkEv = (phase, extra, delay) => setTimeout(() => window.__pmBotEvent(Object.assign({ ev: 'packs', phase }, extra)), delay);
        mkEv('started', { addr: p.addr, dest: '/data/data/com.pmpanel.app/files/server/downloads' }, 120);
        mkEv('downloading', { i: 1, total: 2 }, 700);
        mkEv('progress', { bytes: 512000 }, 1300);
        mkEv('progress', { bytes: 1440000 }, 2100);
        mkEv('packdone', { file: 'Hive Season Pack v2.4.1.mcpack', size: 12416390 }, 2600);
        mkEv('downloading', { i: 2, total: 2 }, 3100);
        mkEv('progress', { bytes: 2200000 }, 3700);
        mkEv('packdone', { file: 'Competitive Texture Pack v1.9.0.mcpack', size: 3412500 }, 4600);
        mkEv('done', {
          addr: p.addr,
          packs: [
            { file: 'Competitive Texture Pack v1.9.0.mcpack', name: 'Competitive Texture Pack v1.9.0', size: 3412500 },
            { file: 'Hive Season Pack v2.4.1.mcpack', name: 'Hive Season Pack v2.4.1', size: 12416390 },
          ],
        }, 5200);
        return { ok: true };
      }
      case 'packs.stop':
        return { ok: true };
      case 'pubip.upnp':
        return { ok: true, mapped: true, externalIp: '198.51.100.7', gateway: '192.168.1.1' };
      case 'profiles.list':
        return { ok: true, active: App.activeProfile, profiles: mockProfiles };
      case 'profiles.create': {
        const id = 's' + Math.floor(Math.random() * 90000 + 10000);
        const port = 19132 + mockProfiles.length * 2;
        mockProfiles.push({ id, name: p.name, state: 'idle', uptimeSec: 0, port });
        return { ok: true, id, name: p.name, port };
      }
      case 'profiles.rename': {
        const pr = mockProfiles.find(function(x){return x.id === p.profile;});
        if (pr) pr.name = p.name;
        return { ok: true };
      }
      case 'profiles.delete': {
        const i = mockProfiles.findIndex(function(x){return x.id === p.profile;});
        if (i >= 0) mockProfiles.splice(i, 1);
        return { ok: true };
      }
      default:
        return { ok: true, mock: true };
    }
  }

  function handleAsync(cmd, p, reqId) {
    setTimeout(() => {
      let ev;
      if (cmd === 'backup.create') ev = { ok: true, name: 'backup-demo.zip', size: 2.4e7 };
      else if (cmd === 'update.check') ev = {
        ok: true,
        pmmp: { tag: '5.32.0', date: '2026-10-28', url: 'https://github.com/pmmp/PocketMine-MP/releases/download/5.32.0/PocketMine-MP.phar', size: 7.1e6 },
        ngBuilds: { tag: '1.21.111', date: '2025-10-09', url: 'https://github.com/TheWindows/PocketMine-NG-Builds-phar/releases/download/1.21.111/PocketMine-MP.phar', asset: 'PocketMine-MP.phar', size: 5.4e6 },
        ngSource: { sha: 'aabbccddeeff00112233445566778899aabbccdd', date: '2026-11-14', bundledSha: 'eaa2e58', message: 'Merge upstream' },
      };
      else if (cmd === 'update.download') ev = { ok: true, size: 7.1e6, flavor: p.flavor };
      else if (cmd === 'dl.download') ev = { ok: true, file: 'downloads/' + (p.name || 'PocketMine-MP.phar'), name: p.name || 'PocketMine-MP.phar', size: 7163904 };
      else if (cmd === 'net.check') ev = { ok: true, dns: true, dnsMs: 42, dnsIp: '185.199.108.133', https: true, httpsMs: 190, via: 'cp.cloudflare.com', github: { 'raw.githubusercontent.com': true, 'raw.githubusercontent.comMs': 320 } };
      else if (cmd === 'market.install') { let n = 0; const iv = setInterval(() => { n += 25; window.__pmEvent({ reqId, progress: Math.min(100, n) }); if (n >= 100) { clearInterval(iv); window.__pmEvent({ reqId, ok: true, file: 'plugins/' + p.name + '_' + (p.version || '') + '.phar', name: p.name + '_' + (p.version || '') + '.phar', size: 234567 }); } }, 250); return; }
      else if (cmd === 'tool.compile') ev = { ok: true, file: 'compiled/TestPlugin_v1.0.0.phar', files: 5, size: 23456 };
      else if (cmd === 'tool.decompile') ev = { ok: true, file: 'src/EconomyAPI', files: 12, size: 821000 };
      else if (cmd === 'upload.pick') ev = { ok: true, files: [{ name: 'DemoPlugin.phar', size: 123456 }] };
      else if (cmd === 'download.save' || cmd === 'backup.restore') ev = { ok: true, files: [{ name: 'file.zip', size: 123 }] };
      else if (cmd === 'zipimport.analyze') {
        ev = {
          ok: true, stageId: 'z123',
          plugins: ['EconomyAPI.phar', 'SkyBlockUI'], worlds: ['skyblock'], packs: ['Faithful.mcpack'],
          configs: ['server.properties', 'pocketmine.yml'], data: ['plugin_data'], skipped: 1,
          plugins_c: 2, worlds_c: 1, packs_c: 1, configs_c: 2,
        };
      } else if (cmd === 'zipimport.apply') ev = { ok: true, plugins: 2, worlds: 1, packs: 1, configs: 2, data: 1, skipped: 1 };
      else if (cmd === 'pubip.info') ev = { ok: true, publicIp: '198.51.100.7', localIp: '192.168.1.42', port: 19132, running: true };
      else if (cmd === 'pubip.upnp') ev = { ok: true, mapped: true, externalIp: '198.51.100.7', gateway: '192.168.1.1' };
      else ev = { ok: true };
      window.__pmEvent(Object.assign({ reqId }, ev));
    }, 600);
  }

  return { handle, handleAsync };
})();
