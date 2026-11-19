/* views-files.js - file manager, editor, content manager (plugins/worlds/packs) */

'use strict';

/* ================= Editor ================= */
const Editor = {
  pendingPath: null,
  returnTo: 'files',
  original: '',
  path: '',

  open(path, returnTo) {
    this.pendingPath = path;
    this.returnTo = returnTo || App.prevMain || 'files';
    App.editorReturn = this.returnTo;
    App.navigate('editor');
  },

  render(root) {
    const path = this.pendingPath;
    const res = API.call('files.read', { path });
    if (res.ok === false) {
      root.appendChild(h('div', { class: 'card' }, res.error || t('error')));
      return;
    }
    this.path = path;
    this.original = res.content || '';

    const area = h('textarea', { class: 'editor-area', spellcheck: 'false' });
    area.value = this.original;
    const meta = h('div', { class: 'editor-meta' },
      path + '  ·  ' + fmtBytes(res.size) + (res.truncated ? '  ·  truncated' : ''));

    const reloadBtn = h('button', {
      class: 'btn sm',
      onclick: () => {
        if (area.value !== this.original) {
          confirmModal(t('reload'), t('editor_dirty'), t('yes'), () => { area.value = this.original; }, true);
        } else area.value = this.original;
      },
    }, icon('refresh'), t('reload'));

    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'editor-bar' },
        h('button', { class: 'btn primary', onclick: () => this.save(area) }, icon('save'), t('save_changes')),
        reloadBtn,
        res.binary ? h('span', { class: 'badge red' }, 'binary') : null),
      area,
      meta));

    if (res.truncated) toast(t('file_too_big'), 'err');
    if (res.binary) toast(t('binary_warn'), 'err');
  },

  save(area) {
    const res = API.call('files.write', { path: this.path, content: area.value });
    if (res.ok === false) toast(res.error || t('error'), 'err');
    else {
      this.original = area.value;
      toast(t('saved'), 'ok');
    }
  },
};

Views.editor = (root) => Editor.render(root);

/* ================= File manager ================= */
const QUICK_DIRS = [
  { path: '', ic: 'home', key: 'root_dir' },
  { path: 'worlds', ic: 'world', key: 'worlds' },
  { path: 'plugins', ic: 'puzzle', key: 'tab_plugins' },
  { path: 'plugin_data', ic: 'folder', key: 'plugin_data' },
  { path: 'players', ic: 'users', key: 'players' },
  { path: 'resource_packs', ic: 'globe', key: 'tab_packs' },
  { path: 'logs', ic: 'scroll', key: 'logs_title' },
];

let fmSort = localStorage.getItem('fm_sort') || 'name';

Views.files = (root) => {
  let path = App.filesPath || '';
  let query = '';

  function render() {
    root.innerHTML = '';
    const res = API.call('files.ls', { path });
    if (res.ok === false) {
      root.appendChild(h('div', { class: 'card' }, (res.error || t('error')) + ' — ' + t('not_installed_hint')));
      return;
    }
    let entries = res.entries || [];

    /* quick access chips */
    const chips = h('div', { class: 'quick-chips' });
    for (const q of QUICK_DIRS) {
      chips.appendChild(h('button', {
        class: 'chip' + (path === q.path ? ' active' : ''),
        onclick: () => go(q.path),
      }, icon(q.ic), h('span', {}, t(q.key))));
    }
    root.appendChild(chips);

    /* header row */
    root.appendChild(h('div', { class: 'page-title' }, icon('folder'), t('files_title'),
      h('span', { class: 'tag-line', style: 'margin-inline-start:auto;font-weight:400' }, t('free_space') + ' ', ltr(fmtBytes(res.freeSpace)))));

    /* breadcrumb */
    const crumbs = h('div', { class: 'crumbs' },
      h('span', { class: 'crumb' + (path ? '' : ' current'), onclick: () => go('') }, icon('home', 15), h('span', {}, 'server')));
    let acc = '';
    if (path) {
      path.split('/').forEach((seg, i, arr) => {
        acc = acc ? acc + '/' + seg : seg;
        const p = acc;
        crumbs.appendChild(h('span', { class: 'crumb-sep' }, '/'));
        crumbs.appendChild(h('span', { class: 'crumb' + (p === path ? ' current' : ''), onclick: () => go(p) }, seg));
      });
    }
    root.appendChild(crumbs);

    /* toolbar: search + sort + actions */
    const searchInput = h('input', {
      class: 'text-input', type: 'search', placeholder: t('search_files'),
      oninput: debounce(() => { query = searchInput.value.trim().toLowerCase(); renderList(); }, 150),
    });
    const searchBox = h('div', { class: 'search-box' }, icon('search'), searchInput);

    const sortBtn = h('button', { class: 'icon-btn', title: t('sort_by'), onclick: cycleSort }, icon('sort'));
    const sortLabel = { name: t('sort_name'), size: t('sort_size'), date: t('sort_date') }[fmSort] || '';
    const sortChip = h('button', { class: 'chip', onclick: cycleSort, title: t('sort_by') }, icon('sort'), h('span', {}, sortLabel));

    const toolbar = h('div', { class: 'row wrap mb', style: 'gap:8px' },
      searchBox,
      sortChip,
      h('button', { class: 'icon-btn', title: t('new_folder'), onclick: () => newFolder() }, icon('plus')),
      h('button', { class: 'icon-btn', title: t('new_file'), onclick: () => newFile() }, icon('edit')),
      h('button', { class: 'icon-btn', title: t('upload_here'), onclick: () => doUpload() }, icon('upload')));
    root.appendChild(toolbar);

    const list = h('div', { class: 'card fm-list' });
    root.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      let items = entries.slice();
      if (query) items = items.filter((e) => e.name.toLowerCase().includes(query));
      items.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (fmSort === 'size') return (b.size || 0) - (a.size || 0);
        if (fmSort === 'date') return (b.mtime || 0) - (a.mtime || 0);
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      if (!items.length) {
        list.appendChild(h('div', { class: 'empty-state' },
          h('span', { class: 'eic' }, icon(query ? 'search' : 'folderopen', 26)),
          h('span', { class: 'etxt' }, query ? t('no_search_result') : t('empty_dir'))));
        return;
      }
      for (const e of items) list.appendChild(row(e));
    }

    function cycleSort() {
      fmSort = fmSort === 'name' ? 'date' : fmSort === 'date' ? 'size' : 'name';
      localStorage.setItem('fm_sort', fmSort);
      App.rerender();
    }

    function row(e) {
      const isDir = e.dir;
      const kind = isDir ? 'dir' : fileKind(e.name);
      const ic = isDir ? 'folder' : FILE_ICON[kind];
      const color = isDir ? 'var(--yellow)' : FILE_COLOR[kind];
      const rel = path ? path + '/' + e.name : e.name;
      return h('div', { class: 'fm-row', onclick: () => (isDir ? go(rel) : openFile(e)) },
        h('span', { class: 'fm-ic', style: 'color:' + color }, icon(ic)),
        h('div', { class: 'fm-main' },
          h('div', { class: 'fm-name' }, e.name),
          h('div', { class: 'fm-meta' },
            isDir ? h('span', { class: 'm' }, t('folder_label')) : h('span', { class: 'm', dir: 'ltr', style: 'unicode-bidi:isolate' }, fmtBytes(e.size)),
            h('span', { class: 'm' }, icon('clock'), fmtRel(e.mtime)))),
        h('button', { class: 'fm-more', onclick: (ev) => { ev.stopPropagation(); openFile(e, true); } }, icon('dots')));
    }

    function openFile(e, fromMenu) {
      const rel = path ? path + '/' + e.name : e.name;
      const kind = fileKind(e.name);
      const actions = [];
      if (e.dir) {
        actions.push({ icon: 'openfolder', label: t('open_folder'), onClick: () => go(rel) });
        actions.push({ icon: 'download', label: t('download_zip'), onClick: () => dl(rel, e.name + '.zip', true) });
      } else {
        if (isEditableFile(e.name) && e.size <= 1500 * 1024) {
          actions.push({ icon: 'edit', label: t('edit'), onClick: () => Editor.open(rel) });
        }
        actions.push({ icon: 'download', label: t('download'), onClick: () => dl(rel, e.name) });
      }
      actions.push({
        icon: 'edit', label: t('rename'),
        onClick: () => {
          promptModal(t('rename'), e.name, t('rename'), (newName) => {
            if (!newName || newName === e.name) return;
            const r = API.call('files.rename', { path: rel, name: newName });
            if (r.ok === false) toast(r.error, 'err');
            else { toast(t('saved'), 'ok'); render(); }
          });
        },
      });
      if (!e.dir && /\.(zip|mcworld|mcpack)$/i.test(e.name)) {
        actions.push({
          icon: 'archive', label: t('unzip_to_folder'),
          onClick: () => {
            const dest = rel.replace(/\.(zip|mcworld|mcpack)$/i, '');
            progressModal(t('extracting'));
            const r = API.call('files.unzip', { path: rel, dest });
            closeModal();
            if (r.ok === false) toast(r.error, 'err');
            else { toast(t('files_restored').replace('{n}', r.files), 'ok'); render(); }
          },
        });
      }
      actions.push({
        icon: 'trash', label: t('delete'), danger: true,
        onClick: () => {
          confirmModal(t('delete'), e.name + ' — ' + t('delete_confirm'), t('delete'), () => {
            const r = API.call('files.delete', { path: rel });
            if (r.ok === false) toast(r.error, 'err');
            else render();
          }, true);
        },
      });
      actionSheet({
        title: e.name,
        subtitle: (e.dir ? t('folder_label') : fmtBytes(e.size)) + ' · ' + fmtDate(e.mtime),
        icon: e.dir ? 'folder' : FILE_ICON[kind],
        iconColor: e.dir ? 'var(--yellow)' : FILE_COLOR[kind],
        actions,
      });
    }

    function dl(rel, suggested) {
      API.callAsync('download.save', { path: rel, suggested })
        .then(() => toast(t('saved'), 'ok'))
        .catch((err) => toast(err.error || t('error'), 'err'));
    }

    function doUpload() {
      API.call('files.mkdir', { path: 'uploads' });
      progressModal(t('receiving'));
      API.callAsync('upload.pick', { dir: 'uploads', multiple: true })
        .then((ev) => {
          closeModal();
          const files = (ev.files || []).filter((f) => !f.error);
          if (!files.length) { toast(t('cancel')); return; }
          let n = 0;
          for (const f of files) {
            const r = API.call('files.move', { path: 'uploads/' + f.name, dest: (path ? path + '/' : '') + f.name });
            if (r.ok !== false) n++;
            else toast(f.name + ': ' + (r.error || ''), 'err');
          }
          toast(n + ' → ' + (path || '/'), 'ok');
          render();
        })
        .catch((e) => { closeModal(); toast(e.error || t('error'), 'err'); });
    }

    function newFolder() {
      promptModal(t('new_folder'), '', t('create'), (name) => {
        if (!name) return;
        const r = API.call('files.mkdir', { path: (path ? path + '/' : '') + name });
        if (r.ok === false) toast(r.error, 'err');
        else render();
      });
    }

    function newFile() {
      promptModal(t('new_file'), '', t('create'), (name) => {
        if (!name) return;
        const r = API.call('files.newfile', { path: (path ? path + '/' : '') + name });
        if (r.ok === false) toast(r.error, 'err');
        else render();
      });
    }

    renderList();
  }

  function go(p) {
    path = p || '';
    App.filesPath = path;
    render();
  }

  render();
};

/* ================= Content manager (plugins / worlds / packs) ================= */
Views.content = (root) => {
  let tab = App.contentTab || 'plugins';
  /* live references to the two plugin section lists (set by renderPlugins) */
  let listEn = null;
  let listDis = null;

  function render() {
    root.innerHTML = '';
    App.contentTab = tab;

    const seg = h('div', { class: 'segmented' });
    [['plugins', 'puzzle', t('tab_plugins')], ['worlds', 'world', t('tab_worlds')], ['packs', 'globe', t('tab_packs')]].forEach(([id, ic, label]) => {
      seg.appendChild(h('button', {
        class: tab === id ? 'active' : '',
        onclick: () => { tab = id; render(); },
      }, icon(ic, 16), h('span', {}, label)));
    });
    root.appendChild(seg);

    if (tab === 'plugins') renderPlugins(root);
    else if (tab === 'worlds') renderWorlds(root);
    else renderPacks(root);
  }

  /* -------- plugins -------- */
  function renderPlugins(root) {
    const zone = h('div', { class: 'upload-zone', onclick: uploadPlugin },
      h('span', { class: 'uz-ic' }, icon('upload', 22)),
      h('div', {}, h('b', {}, t('upload_plugin')), h('div', { class: 'hint' }, h('span', { dir: 'ltr' }, '.phar / .zip'), ' · ' + t('plugin_folder_hint'))));
    root.appendChild(zone);

    const res = API.call('plugins.list');
    const plugins = (res.ok && res.plugins) || [];
    const enabled = plugins.filter((p) => p.enabled);
    const disabled = plugins.filter((p) => !p.enabled);

    if (!plugins.length) {
      root.appendChild(h('div', { class: 'card empty-state' },
        h('span', { class: 'eic' }, icon('puzzle', 26)),
        h('span', { class: 'etxt' }, t('no_plugins'))));
      return;
    }

    /* Two fixed section lists; the toggle moves the card between them with a
     * FLIP animation. Nothing is re-rendered, so scroll position and every
     * other card stay exactly where they are. */
    const secEnabled = h('div', { class: 'cc-section' }, t('enabled'), h('span', { class: 'count' }, enabled.length));
    const secDisabled = h('div', { class: 'cc-section' }, t('disabled'), h('span', { class: 'count' }, disabled.length));
    const enList = h('div', { class: 'plugin-list' });
    const disList = h('div', { class: 'plugin-list' });
    for (const p of enabled) enList.appendChild(pluginCard(p));
    for (const p of disabled) disList.appendChild(pluginCard(p));
    const wrapEn = h('div', {}, secEnabled, enList);
    const wrapDis = h('div', {}, secDisabled, disList);
    root.appendChild(wrapEn);
    root.appendChild(wrapDis);
    root.appendChild(h('div', { class: 'card hint' }, t('plugins_hint')));
    listEn = enList;
    listDis = disList;
    updateSections();

    function updateSections() {
      qs('.count', secEnabled).textContent = enList.childElementCount;
      qs('.count', secDisabled).textContent = disList.childElementCount;
      wrapEn.style.display = enList.childElementCount ? '' : 'none';
      wrapDis.style.display = disList.childElementCount ? '' : 'none';
    }
  }

  function pluginCard(p) {
    const toggle = h('label', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked: !!p.enabled,
        onchange: (e) => togglePlugin(card, p, e.target),
      }),
      h('span', { class: 'track' }));
    const card = h('div', { class: 'cc-card' + (p.enabled ? '' : ' disabled-card') },
      h('span', { class: 'cc-ic purple' }, icon(p.format === 'dir' ? 'folder' : (p.format === 'source' ? 'filecode' : 'puzzle'), 21)),
      h('div', { class: 'cc-main' },
        h('div', { class: 'cc-title-row' },
          h('span', { class: 'cc-name' }, p.name || p.file),
          p.version ? h('span', { class: 'cc-ver' }, 'v' + p.version) : null,
          p.format === 'source' ? h('span', { class: 'badge accent', title: t('source_hint') }, t('source_badge')) : null,
          p.valid === false ? h('span', { class: 'badge red' }, 'invalid') : null),
        p.author ? h('div', { class: 'cc-sub' }, t('by_author').replace('{a}', p.author)) : null,
        p.description ? h('div', { class: 'cc-desc' }, p.description) : null,
        h('div', { class: 'cc-sub' }, ltr(fmtBytes(p.size)), ' · ' + fmtRel(p.mtime) + (p.api ? ' · API ' + p.api : ''))),
      h('div', { class: 'cc-actions' },
        toggle,
        h('button', { class: 'fm-more', onclick: () => pluginMenu(p) }, icon('dots'))));
    return card;
  }

  function togglePlugin(card, p, swEl) {
    const enabling = !p.enabled;
    /* optimistic + animated: flip visually NOW, move between sections with a
     * FLIP slide, and only touch the bridge afterwards. On error, revert. */
    if (!listEn || !listDis) { App.rerender(); return; }
    if (['running', 'starting', 'stopping'].includes(App.status.state)) {
      if (swEl) swEl.checked = !!p.enabled;
      toast(t('stopped_first'), 'err');
      return;
    }
    p.enabled = enabling;
    const r0 = card.getBoundingClientRect();
    card.classList.toggle('disabled-card', !enabling);
    card.classList.add('is-moving');
    (enabling ? listEn : listDis).appendChild(card);
    const r1 = card.getBoundingClientRect();
    const dy = r0.top - r1.top;
    const dx = r0.left - r1.left;
    card.style.transition = 'none';
    card.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    requestAnimationFrame(() => {
      card.style.transition = 'transform .34s cubic-bezier(.22,.9,.24,1), opacity .3s';
      card.style.transform = '';
      setTimeout(() => { card.classList.remove('is-moving'); card.style.transition = ''; card.style.transform = ''; }, 380);
    });
    updateCounts();
    toast(enabling ? t('plugin_enabled') : t('plugin_disabled'), 'ok');

    const r = API.call(enabling ? 'plugins.enable' : 'plugins.disable', { path: p.file });
    if (r.ok === false) {
      toast(r.error || t('error'), 'err');
      /* revert: move back and restore visuals */
      p.enabled = !enabling;
      (enabling ? listDis : listEn).appendChild(card);
      card.classList.toggle('disabled-card', !enabling);
      card.style.transition = '';
      card.style.transform = '';
      if (swEl) swEl.checked = !!p.enabled;
      updateCounts();
    } else {
      p.file = (enabling ? 'plugins/' : 'plugins_disabled/') + p.file.split('/').pop();
    }
  }

  /* refresh the enabled/disabled section counters + hide empty sections */
  function updateCounts() {
    if (!listEn || !listDis) return;
    const secEn = listEn.parentElement && listEn.parentElement.firstChild;
    const secDis = listDis.parentElement && listDis.parentElement.firstChild;
    if (secEn && qs('.count', secEn)) qs('.count', secEn).textContent = listEn.childElementCount;
    if (secDis && qs('.count', secDis)) qs('.count', secDis).textContent = listDis.childElementCount;
    if (listEn.parentElement) listEn.parentElement.style.display = listEn.childElementCount ? '' : 'none';
    if (listDis.parentElement) listDis.parentElement.style.display = listDis.childElementCount ? '' : 'none';
  }

  function pluginMenu(p) {
    const fileName = p.file.split('/').pop();
    actionSheet({
      title: p.name || fileName,
      subtitle: (p.version ? 'v' + p.version + ' · ' : '') + fmtBytes(p.size),
      icon: p.format === 'source' ? 'filecode' : (p.format === 'dir' ? 'folder' : 'filephar'),
      iconColor: 'var(--purple)',
      actions: [
        p.format === 'source' ? {
          icon: 'pharfile', label: t('compile_to_phar'),
          onClick: () => { App.compilerMode = 'compile'; App.compilerPreset = p.file; App.navigate('compiler'); },
        } : null,
        p.format === 'phar' ? {
          icon: 'filecode', label: t('decompile_phar'),
          onClick: () => { App.compilerMode = 'decompile'; App.compilerPreset = p.file; App.navigate('compiler'); },
        } : null,
        {
          icon: 'openfolder', label: t('open_folder'),
          onClick: () => {
            const dir = p.file.split('/').slice(0, -1).join('/');
            App.filesPath = dir;
            App.navigate('files');
          },
        },
        {
          icon: 'download', label: t('download'),
          onClick: () => {
            API.callAsync('download.save', { path: p.file, suggested: fileName })
              .then(() => toast(t('saved'), 'ok'))
              .catch((e) => toast(e.error || t('error'), 'err'));
          },
        },
        p.enabled ? null : {
          icon: 'play', label: t('enable'),
          onClick: () => {
            if (['running', 'starting', 'stopping'].includes(App.status.state)) { toast(t('stopped_first'), 'err'); return; }
            const r = API.call('plugins.enable', { path: p.file });
            if (r.ok === false) toast(r.error || t('error'), 'err');
            else { toast(t('plugin_enabled'), 'ok'); App.rerender(); }
          },
        },
        {
          icon: 'trash', label: t('delete'), danger: true,
          onClick: () => {
            confirmModal(t('delete'), fileName + ' — ' + t('delete_confirm'), t('delete'), () => {
              API.call('files.delete', { path: p.file });
              App.rerender();
            }, true);
          },
        },
      ],
    });
  }

  function uploadPlugin() {
    progressModal(t('receiving'));
    API.callAsync('upload.pick', { dir: 'plugins', multiple: true })
      .then((ev) => {
        closeModal();
        const files = (ev.files || []).filter((f) => !f.error);
        if (!files.length) { toast(t('cancel')); return; }
        toast(files.map((f) => f.name).join(', '), 'ok');
        App.rerender();
      })
      .catch((e) => { closeModal(); toast(e.error || t('error'), 'err'); });
  }

  /* -------- worlds -------- */
  function renderWorlds(root) {
    const zone = h('div', { class: 'upload-zone', onclick: uploadWorld },
      h('span', { class: 'uz-ic' }, icon('import', 22)),
      h('div', {}, h('b', {}, t('upload_world')), h('div', { class: 'hint' }, h('span', { dir: 'ltr' }, '.mcworld / .zip'))));
    root.appendChild(zone);

    const res = API.call('worlds.list');
    const worlds = (res.ok && res.worlds) || [];
    if (!worlds.length) {
      root.appendChild(h('div', { class: 'card empty-state' },
        h('span', { class: 'eic' }, icon('world', 26)),
        h('span', { class: 'etxt' }, t('no_worlds'))));
      return;
    }

    const serverBusy = ['running', 'starting', 'stopping'].includes(App.status.state);
    for (const w of worlds) {
      root.appendChild(h('div', { class: 'cc-card' },
        h('span', { class: 'cc-ic green' }, icon('world', 21)),
        h('div', { class: 'cc-main' },
          h('div', { class: 'cc-title-row' },
            h('span', { class: 'cc-name' }, w.name),
            w.isDefault ? h('span', { class: 'badge green' }, '✓ ' + t('world_default')) : null),
          w.levelName && w.levelName !== w.name ? h('div', { class: 'cc-sub' }, w.levelName) : null,
          h('div', { class: 'cc-sub' }, ltr(fmtBytes(w.size)), ' · ' + fmtRel(w.mtime))),
        h('div', { class: 'cc-actions' },
          !w.isDefault ? h('button', {
            class: 'btn sm', disabled: serverBusy, title: serverBusy ? t('stopped_first') : '',
            onclick: () => setDefaultWorld(w.name),
          }, t('set_default')) : null,
          h('button', { class: 'fm-more', onclick: () => worldMenu(w) }, icon('dots')))));
    }
    if (serverBusy) root.appendChild(h('div', { class: 'card hint' }, '⚠ ' + t('stopped_first')));
  }

  function worldMenu(w) {
    actionSheet({
      title: w.name,
      subtitle: fmtBytes(w.size),
      icon: 'world',
      iconColor: 'var(--green)',
      actions: [
        {
          icon: 'openfolder', label: t('open_folder'),
          onClick: () => { App.filesPath = w.folder; App.navigate('files'); },
        },
        !w.isDefault ? {
          icon: 'check', label: t('set_default'),
          onClick: () => setDefaultWorld(w.name),
        } : null,
        {
          icon: 'trash', label: t('delete'), danger: true,
          onClick: () => {
            confirmModal(t('delete'), w.name + ' — ' + t('delete_confirm'), t('delete'), () => {
              const r = API.call('files.delete', { path: w.folder });
              if (r.ok === false) toast(r.error, 'err');
              App.rerender();
            }, true);
          },
        },
      ],
    });
  }

  function setDefaultWorld(name) {
    if (['running', 'starting', 'stopping'].includes(App.status.state)) {
      toast(t('stopped_first'), 'err');
      return;
    }
    const props = API.call('props.get');
    if (!props.ok) { toast(props.error, 'err'); return; }
    const lines = props.lines.map((l) => l.key === 'level-name' ? { type: 'k', key: 'level-name', value: name } : l);
    const r = API.call('props.set', { lines });
    if (r.ok === false) toast(r.error, 'err');
    else { toast(t('props_saved'), 'ok'); App.rerender(); }
  }

  function uploadWorld() {
    API.call('files.mkdir', { path: 'uploads' });
    progressModal(t('receiving'));
    API.callAsync('upload.pick', { dir: 'uploads', multiple: true })
      .then((ev) => {
        const files = (ev.files || []).filter((f) => !f.error && /\.(mcworld|zip)$/i.test(f.name));
        if (!files.length) { closeModal(); toast(t('cancel')); return; }
        progressModal(t('importing_world'));
        let ok = 0;
        const names = [];
        for (const f of files) {
          const stem = f.name.replace(/\.(mcworld|zip)$/i, '').replace(/[^\w .\-]/g, '_');
          const dest = 'worlds/' + stem;
          const r = API.call('files.unzip', { path: 'uploads/' + f.name, dest });
          API.call('files.delete', { path: 'uploads/' + f.name });
          if (r.ok === false) toast(f.name + ': ' + r.error, 'err');
          else { ok++; names.push(stem); }
        }
        closeModal();
        if (ok) {
          toast(t('world_imported').replace('{n}', ok), 'ok');
          if (names.length === 1 && !['running', 'starting', 'stopping'].includes(App.status.state)) {
            confirmModal(t('set_default'), names[0], t('set_default'), () => setDefaultWorld(names[0]));
          }
          App.rerender();
        }
      })
      .catch((e) => { closeModal(); toast(e.error || t('error'), 'err'); });
  }

  /* -------- packs -------- */
  function renderPacks(root) {
    const zone = h('div', { class: 'upload-zone', onclick: uploadPack },
      h('span', { class: 'uz-ic' }, icon('upload', 22)),
      h('div', {}, h('b', {}, t('upload_pack')), h('div', { class: 'hint' }, h('span', { dir: 'ltr' }, '.mcpack / .zip'))));
    root.appendChild(zone);

    const res = API.call('packs.list');
    const packs = (res.ok && res.packs) || [];
    if (!packs.length) {
      root.appendChild(h('div', { class: 'card empty-state' },
        h('span', { class: 'eic' }, icon('globe', 26)),
        h('span', { class: 'etxt' }, t('no_packs'))));
      return;
    }
    for (const p of packs) {
      root.appendChild(h('div', { class: 'cc-card' },
        h('span', { class: 'cc-ic yellow' }, icon('globe', 21)),
        h('div', { class: 'cc-main' },
          h('div', { class: 'cc-title-row' },
            h('span', { class: 'cc-name' }, p.name || p.file),
            p.version ? h('span', { class: 'cc-ver' }, 'v' + p.version) : null,
            p.valid === false ? h('span', { class: 'badge red' }, 'invalid') : null),
          p.uuid ? h('div', { class: 'cc-sub' }, p.uuid) : null,
          h('div', { class: 'cc-sub' }, ltr(fmtBytes(p.size)), ' · ' + fmtRel(p.mtime))),
        h('div', { class: 'cc-actions' },
          h('button', { class: 'fm-more', onclick: () => packMenu(p) }, icon('dots')))));
    }
    root.appendChild(h('div', { class: 'card hint' }, t('packs_hint')));
  }

  function packMenu(p) {
    const fileName = p.file.split('/').pop();
    actionSheet({
      title: p.name || fileName,
      subtitle: (p.version ? 'v' + p.version + ' · ' : '') + fmtBytes(p.size),
      icon: 'globe',
      iconColor: 'var(--yellow)',
      actions: [
        {
          icon: 'download', label: t('download'),
          onClick: () => {
            API.callAsync('download.save', { path: p.file, suggested: fileName })
              .then(() => toast(t('saved'), 'ok'))
              .catch((e) => toast(e.error || t('error'), 'err'));
          },
        },
        {
          icon: 'trash', label: t('delete'), danger: true,
          onClick: () => {
            confirmModal(t('delete'), fileName + ' — ' + t('delete_confirm'), t('delete'), () => {
              API.call('files.delete', { path: p.file });
              App.rerender();
            }, true);
          },
        },
      ],
    });
  }

  function uploadPack() {
    progressModal(t('receiving'));
    API.callAsync('upload.pick', { dir: 'resource_packs', multiple: true })
      .then((ev) => {
        closeModal();
        const files = (ev.files || []).filter((f) => !f.error && /\.(mcpack|zip)$/i.test(f.name));
        if (!files.length) { toast(t('cancel')); return; }
        toast(files.length + ' ✓', 'ok');
        App.rerender();
      })
      .catch((e) => { closeModal(); toast(e.error || t('error'), 'err'); });
  }

  render();
};

/* ---------- shared progress modal ---------- */
let _progressClose = null;
function progressModal(label) {
  closeModal();
  const bar = h('div', { class: 'progress', style: 'margin-top:12px' },
    h('div', { style: 'width:35%;animation:pulse 1.2s infinite' }));
  const close = modal({
    title: label || t('loading'),
    body: h('div', { class: 'center', style: 'padding:6px 0' }, bar),
  });
  _progressClose = close;
  return close;
}
function closeModal() {
  if (_progressClose) { _progressClose(); _progressClose = null; }
}

/* ---------- prompt modal helper ---------- */
function promptModal(title, value, okLabel, onOk) {
  const input = h('input', { class: 'text-input mono', value: value || '', autocomplete: 'off' });
  modal({
    title,
    body: input,
    actions: [
      { label: t('cancel'), class: 'btn ghost' },
      {
        label: okLabel || t('ok'), class: 'btn primary',
        onClick: () => { onOk(input.value.trim()); },
      },
    ],
  });
  setTimeout(() => input.focus(), 80);
}
