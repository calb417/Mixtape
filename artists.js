'use strict';
/* My Artists: the bands you follow, in one list. The game (and later the Setlist Study Guide and
   Concerts Near Me) read from it. Needs app.js and info.js loaded first. */

const MyArtists = {
  list() { return Store.get('myArtists', []); },
  save(list) {
    const sortKey = (n) => norm(n);          // norm() already drops a leading "The"
    list.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
    Store.set('myArtists', list);
  },
  has(name) { const k = norm(name); return this.list().some((a) => norm(a.name) === k); },
  add(name, mbid) {
    name = String(name || '').trim();
    if (!name || this.has(name)) return false;
    const list = this.list();
    list.push({ name, mbid: mbid || '', added: new Date().toISOString().slice(0, 10), edited: Date.now() });
    if (typeof Sync !== 'undefined') Sync.untomb('myArtists', norm(name));
    this.save(list);
    return true;
  },
  addMany(items) {
    const list = this.list();
    const have = new Set(list.map((a) => norm(a.name)));
    let n = 0;
    items.forEach((it) => {
      const name = String(it.name || '').trim();
      if (!name || have.has(norm(name))) return;
      have.add(norm(name));
      list.push({ name, mbid: it.mbid || '', added: new Date().toISOString().slice(0, 10), edited: Date.now() });
      if (typeof Sync !== 'undefined') Sync.untomb('myArtists', norm(name));
      n++;
    });
    this.save(list);
    return n;
  },
  remove(name) { const k = norm(name); if (typeof Sync !== 'undefined') Sync.tombstone('myArtists', k); this.save(this.list().filter((a) => norm(a.name) !== k)); },
  toggle(name, mbid) {
    if (this.has(name)) { this.remove(name); return false; }
    this.add(name, mbid);
    return true;
  },
  // "Artist - Topic", "ArtistVEVO", "Artist Official" → "Artist"; "A feat. B" → "A"
  cleanName(n) {
    return String(n || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official$/i, '')
      .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  },
  // Every artist in a playlist, with how many of its songs they have
  artistsIn(items) {
    const map = new Map();
    items.forEach((it) => {
      const name = this.cleanName(it.a);
      if (!name) return;
      const k = norm(name);
      const e = map.get(k) || { name, count: 0 };
      e.count++;
      map.set(k, e);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || norm(a.name).localeCompare(norm(b.name)));
  },
};

/* ---------------- The My Artists screen ---------------- */
Views.artists = {
  editing: false,
  html() {
    return `<div class="screen" id="artists-root">
      <header class="topbar">
        <button class="icon-btn" data-m="home" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>My Artists</h1></div>
        <button class="icon-btn" data-m="help" aria-label="Help">?</button>
      </header>
      <div class="pad" style="display:flex; flex-direction:column; gap:10px; margin-top:6px">
        <input class="search" data-m="q" placeholder="Search for a band to add" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="ares" data-m="res"></div>
        <div class="row">
          <button class="btn small" style="flex:1" data-m="batch">${ICON.list.replace('<svg', '<svg stroke="currentColor" width="18" height="18"')} From a playlist</button>
          <button class="btn small primary" style="flex:1" data-m="play">${ICON.play} Play in the game</button>
        </div>
      </div>
      <div class="pad my-head"><span class="muted small" data-m="count"></span>
        <span class="row" style="gap:14px"><input class="field slim" data-m="filter" placeholder="Find in list" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="link-btn" data-m="edit">Edit</button></span></div>
      <div class="my-list" data-m="list"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const $m = (k) => el.querySelector(`[data-m=${k}]`);
    this.editing = false;
    const render = () => {
      const all = MyArtists.list();
      const f = $m('filter').value.trim();
      const list = f ? all.filter((a) => fuzzyScore(f, a.name) > 0) : all;
      $m('count').textContent = `${all.length} artist${all.length === 1 ? '' : 's'}`;
      $m('edit').textContent = this.editing ? 'Done' : 'Edit';
      $m('list').innerHTML = all.length
        ? list.map((a) => `<div class="my-row">
            <button class="my-main" ${Cards.attrs('artist', { name: a.name, mbid: a.mbid })}><span class="ph"><i>${Cards.initials(a.name)}</i></span><span class="n">${esc(a.name)}</span>${this.editing ? '' : ICON.chev}</button>
            ${this.editing ? `<button class="icon-btn" data-m="del" data-name="${esc(a.name)}" aria-label="Remove ${esc(a.name)}">${ICON.close}</button>` : ''}
          </div>`).join('') || '<p class="muted pad">No matches.</p>'
        : `<div class="pad"><p class="muted">No artists yet. Search above, tap <b>From a playlist</b> to pull in every band from one of your playlists, or tap <b>+ My Artists</b> on any artist card.</p></div>`;
      if (this.editing) el.querySelectorAll('.my-main').forEach((b) => { b.removeAttribute('data-card'); b.disabled = true; });
    };
    this.render = render;
    render();

    // Search Last.fm as you type
    let timer = null, seq = 0, results = [];
    const showResults = () => {
      $m('res').innerHTML = results.map((a, i) => {
        const have = MyArtists.has(a.name);
        return `<div class="rowbtn"><button class="tap" style="text-align:left; flex:1" ${Cards.attrs('artist', { name: a.name, mbid: a.mbid })}>${esc(a.name)}
          <span class="muted small">${a.listeners ? ' · ' + Math.round(a.listeners / 1000).toLocaleString() + 'k listeners' : ''}</span></button>
          <button class="btn small ${have ? '' : 'primary'}" data-m="add" data-i="${i}" ${have ? 'disabled' : ''}>${have ? 'Added' : 'Add'}</button></div>`;
      }).join('');
    };
    $m('q').addEventListener('input', () => {
      clearTimeout(timer);
      const q = $m('q').value.trim();
      if (!q) { results = []; $m('res').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const list = await LastFM.searchArtists(q);
          if (my !== seq) return;
          results = list.slice(0, 6);
          if (!results.length) { $m('res').innerHTML = '<p class="muted small">No artists found.</p>'; return; }
          showResults();
        } catch (e) { $m('res').innerHTML = ''; Errors.show(e.message || String(e)); }
      }, 280);
    });
    $m('filter').addEventListener('input', render);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      const m = b.dataset.m;
      if (m === 'home') go('#home');
      if (m === 'help') showHelp('artists');
      if (m === 'add') {
        const a = results[parseInt(b.dataset.i, 10)];
        if (a && MyArtists.add(a.name, a.mbid)) toast(`Added ${a.name}`);
        showResults(); render();
      }
      if (m === 'edit') { this.editing = !this.editing; render(); }
      if (m === 'del') { MyArtists.remove(b.dataset.name); render(); }
      if (m === 'batch') openBatchAdd(() => render());
      if (m === 'play') {
        if (!MyArtists.list().length) { toast('Add some artists first'); return; }
        const f = Pool.get();
        Pool.set({ playlists: [], artists: [], useMy: true, genres: [], decades: [], hits: f.hits });
        if (typeof Game !== 'undefined') { Game.round = null; Game.mode = 'guess'; }
        toast('Game pool: My Artists');
        go('#game');
      }
    });
    firstVisit('artists');
  },
};
// The list changes when artist cards add or remove someone
document.addEventListener('myartists', () => { if (currentView === Views.artists && Views.artists.render) Views.artists.render(); });

/* ---------------- Add a batch of artists from a playlist ---------------- */
function openBatchAdd(onDone) {
  let rows = [];       // { name, count, on, have }
  Sheets.open({
    title: 'Add from a playlist',
    html: `<p class="muted small" style="margin-top:0">Pick a playlist and Mixtape lists every artist in it, with how many songs each has there.</p>
      <div data-b="src"></div>
      <details class="add-pl"><summary>Use another YouTube Music playlist</summary>
        <input class="field" data-b="link" placeholder="Paste the playlist link" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="row" style="margin-top:8px"><button class="btn small primary" data-b="read">Read playlist</button></div>
      </details>
      <div data-b="pick"></div>`,
    onMount(body, close) {
      const $b = (k) => body.querySelector(`[data-b=${k}]`);
      const pools = Store.get('pools', []);
      $b('src').innerHTML = pools.length
        ? '<div class="rows">' + pools.map((p) => `<button class="rowbtn" data-b="pool" data-id="${esc(p.id)}"><span>${esc(p.name)}</span><span class="muted small">${p.count} songs ${ICON.chev}</span></button>`).join('') + '</div>'
        : '<p class="muted small">No saved playlists yet. Paste a link below.</p>';
      const showPick = (title, items) => {
        rows = MyArtists.artistsIn(items).map((a) => ({ name: a.name, count: a.count, have: MyArtists.has(a.name), on: false }));
        rows.forEach((r) => { r.on = !r.have; });
        drawPick(title);
      };
      const drawPick = (title) => {
        const fresh = rows.filter((r) => !r.have);
        const chosen = fresh.filter((r) => r.on).length;
        $b('pick').innerHTML = `<h3>${esc(title)}</h3>
          <p class="muted small">${rows.length} artists · ${rows.length - fresh.length} already in My Artists. Tap a name to fix it before adding.</p>
          <div class="row" style="gap:16px"><button class="link-btn" data-b="all">Select all</button><button class="link-btn" data-b="none">Select none</button></div>
          <div class="batch-list">${rows.map((r, i) => `<div class="check ${r.on ? 'on' : ''} ${r.have ? 'have' : ''}">
              <button class="box-btn" data-b="tick" data-i="${i}" ${r.have ? 'disabled' : ''} aria-label="Select ${esc(r.name)}"><span class="box">${ICON.check}</span></button>
              <span class="main"><input class="name-edit" data-b="name" data-i="${i}" value="${esc(r.name)}" ${r.have ? 'disabled' : ''} autocomplete="off" spellcheck="false" aria-label="Artist name">
              <span class="c">${r.count} song${r.count === 1 ? '' : 's'}${r.have ? ' · already added' : ''}</span></span></div>`).join('')}</div>
          <div class="row sheet-actions"><button class="btn primary wide" data-b="go" ${chosen ? '' : 'disabled'}>Add ${chosen} artist${chosen === 1 ? '' : 's'}</button></div>`;
        $b('pick').dataset.title = title;
        $b('pick').scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      body.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.b === 'name') { const r = rows[parseInt(t.dataset.i, 10)]; if (r) r.name = t.value; }
      });
      body.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]');
        if (!b || b.tagName === 'INPUT') return;
        const k = b.dataset.b;
        try {
          if (k === 'pool') {
            const p = pools.find((x) => x.id === b.dataset.id);
            showPick(p ? p.name : 'Playlist', Store.get('pool.' + b.dataset.id, []));
          }
          if (k === 'read') {
            const id = YTData.parsePlaylistId($b('link').value);
            if (!id) { toast("That doesn't look like a playlist link"); return; }
            b.disabled = true;
            b.textContent = 'Reading…';
            const [name, items] = await Promise.all([YTData.playlistName(id), YTData.playlistItems(id)]);
            b.disabled = false;
            b.textContent = 'Read playlist';
            showPick(name, items);
          }
          if (k === 'tick') { const r = rows[parseInt(b.dataset.i, 10)]; if (r && !r.have) r.on = !r.on; drawPick($b('pick').dataset.title); }
          if (k === 'all') { rows.forEach((r) => { if (!r.have) r.on = true; }); drawPick($b('pick').dataset.title); }
          if (k === 'none') { rows.forEach((r) => { r.on = false; }); drawPick($b('pick').dataset.title); }
          if (k === 'go') {
            const n = MyArtists.addMany(rows.filter((r) => r.on && !r.have).map((r) => ({ name: r.name })));
            toast(`Added ${n} artist${n === 1 ? '' : 's'}`);
            close();
            if (onDone) onDone();
          }
        } catch (err) {
          b.disabled = false;
          if (k === 'read') b.textContent = 'Read playlist';
          Errors.show(err.message || String(err), err instanceof ApiError ? '' : err);
        }
      });
    },
  });
}

/* ---------------- Pick some of My Artists (for the game's song pool) ---------------- */
function openMyArtistsPicker(already, onPick) {
  const list = MyArtists.list();
  const have = new Set(already.map((a) => norm(a.name)));
  const on = new Set();
  Sheets.open({
    title: 'Pick from My Artists',
    html: `<div class="row" style="gap:16px"><button class="link-btn" data-p="all">Select all</button><button class="link-btn" data-p="none">Select none</button></div>
      <input class="field slim" data-p="filter" placeholder="Find in list" autocomplete="off" autocapitalize="off" spellcheck="false" style="margin:6px 0">
      <div data-p="list"></div>
      <div class="row sheet-actions"><button class="btn primary wide" data-p="go">Add</button></div>`,
    onMount(body, close) {
      const $p = (k) => body.querySelector(`[data-p=${k}]`);
      const draw = () => {
        const f = $p('filter').value.trim();
        $p('list').innerHTML = list.filter((a) => !f || fuzzyScore(f, a.name) > 0).map((a) => {
          const k = norm(a.name), isOn = on.has(k) || have.has(k);
          return `<button class="check ${isOn ? 'on' : ''}" data-p="t" data-k="${esc(k)}" ${have.has(k) ? 'disabled' : ''}><span class="box">${ICON.check}</span><span class="main"><span class="n">${esc(a.name)}</span></span></button>`;
        }).join('');
        $p('go').textContent = on.size ? `Add ${on.size}` : 'Add';
        $p('go').disabled = !on.size;
      };
      draw();
      $p('filter').addEventListener('input', draw);
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-p]');
        if (!b) return;
        const k = b.dataset.p;
        if (k === 't') { const key = b.dataset.k; if (on.has(key)) on.delete(key); else on.add(key); draw(); }
        if (k === 'all') { list.forEach((a) => { if (!have.has(norm(a.name))) on.add(norm(a.name)); }); draw(); }
        if (k === 'none') { on.clear(); draw(); }
        if (k === 'go') { onPick(list.filter((a) => on.has(norm(a.name)))); close(); }
      });
    },
  });
}
