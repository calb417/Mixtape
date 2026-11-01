'use strict';
/* Playlist Builder: make a playlist in Mixtape, then save it to YouTube Music, or add songs to one of your
   YouTube Music playlists. Big saves stop at YouTube's free daily limit and carry on the next day.
   Needs app.js, sync.js, info.js and game.js loaded first. */

const MAX_PLAYLIST = 5000;

const Builder = {
  /* ---------- the lists you're building ("mixes"; they sync) ---------- */
  list() { return Store.get('mixes', []); },
  get(id) { return this.list().find((m) => m.id === id) || null; },
  put(mix) {
    mix.edited = Date.now();
    const l = this.list().filter((m) => m.id !== mix.id);
    l.unshift(mix);
    Store.set('mixes', l);
    Store.set('currentMix', mix.id, true);
    return mix;
  },
  create(name, target) {
    return this.put({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || '').trim() || 'New playlist',
      songs: [], next: 0, clean: false, privacy: 'private', target: target || null, saved: null, created: new Date().toISOString() });
  },
  remove(id) { Store.set('mixes', this.list().filter((m) => m.id !== id)); },
  // Adds songs that aren't in the list yet; returns how many were added
  addTo(mix, songs) {
    const have = new Set(mix.songs.map((s) => songKey(s.a, s.t)));
    let n = 0;
    songs.forEach((s) => {
      if (!s || !s.a || !s.t || mix.songs.length >= MAX_PLAYLIST) return;
      const k = songKey(s.a, s.t);
      if (have.has(k)) return;
      have.add(k);
      mix.next = (mix.next || mix.songs.length) + 1;
      mix.songs.push({ a: String(s.a).trim(), t: String(s.t).trim(), v: s.v || '', n: mix.next });
      n++;
    });
    this.put(mix);
    document.dispatchEvent(new Event('mixes'));
    return n;
  },
  has(mix, a, t) { const k = songKey(a, t); return mix.songs.some((s) => songKey(s.a, s.t) === k); },
  ytmUrl(id) { return 'https://music.youtube.com/playlist?list=' + encodeURIComponent(id); },
  tileText() {
    const j = Job.get();
    if (j && j.state !== 'done') return j.state === 'running' ? `Saving ${j.i} of ${j.songs.length}…` : `Saving paused at ${j.i} of ${j.songs.length}`;
    const n = this.list().length;
    return n ? `${n} playlist${n === 1 ? '' : 's'} in Mixtape` : 'Make playlists for YouTube Music';
  },

  // What a save will cost: song lookups (100 a day) and YouTube units (10,000 a day)
  estimate(mix) {
    const lookups = mix.songs.filter((s) => (mix.clean ? !SongFinder.known(s.a, s.t, true) : !s.v && !SongFinder.known(s.a, s.t))).length;
    const units = lookups * 100 + mix.songs.length * 50 + (mix.target ? 0 : 50);
    const days = Math.max(1, Math.ceil(lookups / DAILY_LOOKUPS), Math.ceil(units / (YT_DAILY_UNITS * 0.95)));
    return { lookups, units, days };
  },

  /* ---------- "+ Playlist" on the info cards ---------- */
  fromCard(d) {
    this.chooseMix(async (mix) => {
      try {
        if (d.mix === 'song') {
          const n = this.addTo(mix, [{ a: d.artist, t: d.title, v: d.v }]);
          toast(n ? `Added to ${mix.name}` : `Already in ${mix.name}`);
        }
        if (d.mix === 'album') {
          toast('Reading the album…');
          const at = await MB.albumTracks(d.rg);
          const n = this.addTo(mix, at.tracks.map((t) => ({ a: d.artist, t: cleanTitle(t.t) })));
          toast(`Added ${n} song${n === 1 ? '' : 's'} to ${mix.name}`);
        }
        if (d.mix === 'artist') this.artistSongs(d.name, mix);
      } catch (e) { Errors.show(e.message || String(e), e instanceof ApiError ? '' : e); }
    });
  },
  // Pick which list to add to (or start a new one)
  chooseMix(onPick) {
    const list = this.list();
    const cur = Store.get('currentMix', '');
    list.sort((a, b) => (b.id === cur) - (a.id === cur));
    Sheets.open({
      title: 'Add to which playlist?',
      html: `${list.length ? '<div class="rows">' + list.map((m) => `<button class="rowbtn" data-c="pick" data-id="${esc(m.id)}"><span>${esc(m.name)}</span><span class="muted small">${m.songs.length} song${m.songs.length === 1 ? '' : 's'} ${ICON.chev}</span></button>`).join('') + '</div>' : ''}
        <h3>${list.length ? 'Or start a new one' : 'Start a new playlist'}</h3>
        <div class="row"><input class="field" data-c="name" placeholder="Name it" autocomplete="off" spellcheck="false"><button class="btn small primary" data-c="new">Make it</button></div>
        ${Google.on() ? '<button class="btn small" style="margin-top:12px" data-c="mine">Add to one of your YouTube Music playlists</button>' : ''}`,
      onMount: (body, close) => {
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-c]');
          if (!b || b.tagName === 'INPUT') return;
          const c = b.dataset.c;
          if (c === 'pick') { const m = this.get(b.dataset.id); close(); if (m) onPick(m); }
          if (c === 'new') { const m = this.create(body.querySelector('[data-c=name]').value); close(); onPick(m); }
          if (c === 'mine') { close(); Google.pickPlaylist('Add to which playlist?', (p) => onPick(this.forPlaylist(p))); }
        });
      },
    });
  },
  // A list that adds to one of your YouTube Music playlists (reused if there is one already)
  forPlaylist(p) {
    const old = this.list().find((m) => m.target && m.target.id === p.id);
    if (old) return old;
    return this.create(p.name, { id: p.id, name: p.name });
  },

  /* ---------- pick songs from a list (checkboxes, Select all / none) ---------- */
  pickSongs({ title, note, load, pre, mix, onDone }) {
    let rows = [];
    Sheets.open({
      title,
      html: `${note ? `<p class="muted small" style="margin-top:0">${note}</p>` : ''}
        <div class="row" style="gap:16px; flex-wrap:wrap"><button class="link-btn" data-p="all">Select all</button><button class="link-btn" data-p="none">Select none</button><button class="link-btn" data-p="top" hidden>Top 10</button></div>
        <input class="field slim" data-p="f" placeholder="Find in list" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%; margin:6px 0">
        <div class="batch-list" data-p="list"><p class="muted">Loading…</p></div>
        <div class="row sheet-actions"><button class="btn primary wide" data-p="go" disabled>Add</button></div>`,
      onMount: async (body, close) => {
        const $p = (k) => body.querySelector(`[data-p=${k}]`);
        const draw = () => {
          const f = $p('f').value.trim();
          const shown = rows.map((r, i) => [r, i]).filter(([r]) => !f || fuzzyScore(f, r.t + ' ' + r.a) > 0);
          $p('list').innerHTML = shown.slice(0, 600).map(([r, i]) => `<div class="check ${r.on ? 'on' : ''} ${r.have ? 'have' : ''}">
              <button class="box-btn" data-p="tick" data-i="${i}" ${r.have ? 'disabled' : ''} aria-label="Select ${esc(r.t)}"><span class="box">${ICON.check}</span></button>
              <button class="main tapcard" ${Cards.attrs('song', { artist: r.a, title: r.t, v: r.v })}><span class="n">${esc(r.t)}</span><span class="c">${esc(r.a)}${r.sub ? ' · ' + esc(r.sub) : ''}${r.have ? ' · already in' : ''}</span></button></div>`).join('')
            + (shown.length > 600 ? `<p class="muted small">Showing 600 of ${shown.length}. Type above to find the rest.</p>` : '')
            || '<p class="muted">Nothing found.</p>';
          const n = rows.filter((r) => r.on && !r.have).length;
          $p('go').disabled = !n;
          $p('go').textContent = `Add ${n} song${n === 1 ? '' : 's'}`;
        };
        $p('f').addEventListener('input', draw);
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-p]');
          if (!b || b.tagName === 'INPUT') return;
          const k = b.dataset.p;
          if (k === 'tick') { const r = rows[parseInt(b.dataset.i, 10)]; if (r && !r.have) r.on = !r.on; draw(); }
          if (k === 'all') { rows.forEach((r) => { if (!r.have) r.on = true; }); draw(); }
          if (k === 'none') { rows.forEach((r) => { r.on = false; }); draw(); }
          if (k === 'top') { rows.forEach((r, i) => { r.on = !r.have && i < 10; }); draw(); }
          if (k === 'go') {
            const n = this.addTo(mix, rows.filter((r) => r.on && !r.have));
            toast(`Added ${n} song${n === 1 ? '' : 's'} to ${mix.name}`);
            close();
            if (onDone) onDone();
          }
        });
        try {
          const list = await load();
          rows = list.map((s, i) => ({ a: s.a, t: s.t, v: s.v || '', sub: s.sub || '', have: this.has(mix, s.a, s.t), on: false }));
          rows.forEach((r, i) => { r.on = !r.have && (pre === 'all' || (typeof pre === 'number' && i < pre)); });
          $p('top').hidden = rows.length <= 10;
          draw();
        } catch (e) {
          $p('list').innerHTML = `<p class="muted">${esc(e.message || e)}</p>`;
          if (!(e instanceof ApiError)) Errors.show(e.message, e);
        }
      },
    });
  },
  artistSongs(name, mix, onDone) {
    this.pickSongs({ title: name, mix, onDone, pre: 10,
      note: 'Most played first (Last.fm). The top 10 are ticked; change it any way you like.',
      load: async () => (await LastFM.topTracks(name)).slice(0, 150).map((s) => ({ a: s.a, t: s.t, sub: s.n ? Math.round(s.n / 1000).toLocaleString() + 'k listeners' : '' })) });
  },

  /* ---------- the "Add songs" panels ---------- */
  openSearch(mix, onDone) {
    Sheets.open({
      title: 'Search',
      html: `<input class="search" data-s="q" placeholder="Song or artist" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div data-s="res"><p class="muted small">Type a song, an artist, or both ("tom petty runnin").</p></div>`,
      onMount: (body) => {
        const $s = (k) => body.querySelector(`[data-s=${k}]`);
        let timer = null, seq = 0, songs = [], arts = [], yt = [];
        const draw = () => {
          const q = $s('q').value.trim();
          $s('res').innerHTML = (arts.length ? '<h3>Artists</h3><div class="rows">' + arts.map((a, i) => `<button class="rowbtn" data-s="art" data-i="${i}"><span>${esc(a.name)}</span><span class="muted small">Top songs ${ICON.chev}</span></button>`).join('') + '</div>' : '')
            + (songs.length ? '<h3>Songs</h3>' + songRows(songs, 'song') : '')
            + (yt.length ? '<h3>From YouTube</h3>' + songRows(yt, 'yt') : '')
            + (q ? `<div class="card-actions"><button class="btn small" data-s="ytq">Search YouTube instead</button></div><p class="muted small">Use YouTube when you want one exact version (a live take, a remix). It uses one of today's ${DAILY_LOOKUPS} song lookups.</p>` : '');
        };
        const songRows = (list, kind) => '<div class="rows">' + list.map((s, i) => {
          const have = this.has(mix, s.a, s.t);
          return `<div class="rowbtn"><button class="tap" style="text-align:left; flex:1; min-width:0; background:none; border:none; padding:0" ${Cards.attrs('song', { artist: s.a, title: s.t, v: s.v })}>${esc(s.t)}<span class="muted small" style="display:block">${esc(s.a)}</span></button>
            <button class="btn small ${have ? '' : 'primary'}" data-s="add" data-k="${kind}" data-i="${i}" ${have ? 'disabled' : ''}>${have ? 'Added' : '+ Add'}</button></div>`;
        }).join('') + '</div>';
        $s('q').addEventListener('input', () => {
          clearTimeout(timer);
          yt = [];
          const q = $s('q').value.trim();
          if (!q) { songs = []; arts = []; draw(); return; }
          timer = setTimeout(async () => {
            const my = ++seq;
            try {
              const [s, a] = await Promise.all([LastFM.searchTracks(q), LastFM.searchArtists(q)]);
              if (my !== seq) return;
              songs = s.slice(0, 15);
              arts = a.filter((x) => fuzzyScore(q, x.name) > 0).slice(0, 3);
              draw();
            } catch (e) { Errors.show(e.message || String(e)); }
          }, 300);
        });
        body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-s]');
          if (!b || b.tagName === 'INPUT') return;
          const k = b.dataset.s;
          try {
            if (k === 'add') {
              const s = (b.dataset.k === 'yt' ? yt : songs)[parseInt(b.dataset.i, 10)];
              if (s) { this.addTo(mix, [s]); toast(`Added ${s.t}`); draw(); if (onDone) onDone(); }
            }
            if (k === 'art') { const a = arts[parseInt(b.dataset.i, 10)]; if (a) this.artistSongs(a.name, mix, () => { draw(); if (onDone) onDone(); }); }
            if (k === 'ytq') {
              if (SongFinder.used() >= DAILY_LOOKUPS) { toast(`Today's ${DAILY_LOOKUPS} lookups are used up`); return; }
              b.disabled = true;
              SongFinder.count();
              yt = (await YTData.searchSongs($s('q').value.trim())).slice(0, 10);
              draw();
            }
          } catch (err) { b.disabled = false; Errors.show(err.message || String(err), err instanceof ApiError ? '' : err); }
        });
        setTimeout(() => $s('q').focus(), 350);
      },
    });
  },
  openGenres(mix, onDone) {
    const decades = Object.keys(DEC);
    Sheets.open({
      title: 'Genre or decade',
      html: `<p class="muted small" style="margin-top:0">The most-played songs for a genre or decade on Last.fm. You pick which to add.</p>
        <h3>Genres</h3><div class="chips">${GENRES.map((g) => `<button class="chip" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>
        <div class="row" style="margin-top:8px"><input class="field" data-g-other placeholder="Another genre (any Last.fm tag)" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn small" data-g-go>Go</button></div>
        <h3>Decades</h3><div class="chips">${decades.map((d) => `<button class="chip" data-g="${esc(DEC[d].tag)}" data-label="${esc(d)}">${esc(d)}</button>`).join('')}</div>`,
      onMount: (body, close) => {
        const open = (tag, label) => {
          close();
          this.pickSongs({ title: label || tag, mix, onDone, pre: 0, note: 'Tick the songs you want.',
            load: async () => (await LastFM.tagTopTracks(tag, 2)).slice(0, 300) });
        };
        body.addEventListener('click', (e) => {
          const c = e.target.closest('[data-g]');
          if (c) open(c.dataset.g, c.dataset.label);
          if (e.target.closest('[data-g-go]')) { const v = body.querySelector('[data-g-other]').value.trim().toLowerCase(); if (v) open(v); }
        });
      },
    });
  },
  openPlaylists(mix, onDone) {
    const pools = Store.get('pools', []);
    Sheets.open({
      title: 'From a playlist',
      html: `${pools.length ? '<h3 style="margin-top:0">Saved in Mixtape</h3><div class="rows">' + pools.map((p) => `<button class="rowbtn" data-l="pool" data-id="${esc(p.id)}"><span>${esc(p.name)}</span><span class="muted small">${p.count} songs ${ICON.chev}</span></button>`).join('') + '</div>' : ''}
        ${Google.on() ? '<button class="btn small" style="margin-top:12px" data-l="mine">Pick one of yours from YouTube Music</button>' : ''}
        <details class="add-pl" ${pools.length || Google.on() ? '' : 'open'}><summary>Paste a playlist link</summary>
          <input class="field" data-l="link" placeholder="Paste the playlist link" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="row" style="margin-top:8px"><button class="btn small primary" data-l="read">Read playlist</button></div>
        </details>`,
      onMount: (body, close) => {
        const pick = (name, load) => { close(); this.pickSongs({ title: name, mix, onDone, pre: 0, note: 'Tick the songs you want, or Select all.', load }); };
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-l]');
          if (!b || b.tagName === 'INPUT') return;
          const k = b.dataset.l;
          if (k === 'pool') { const p = pools.find((x) => x.id === b.dataset.id); pick(p ? p.name : 'Playlist', async () => Store.get('pool.' + b.dataset.id, [])); }
          if (k === 'mine') { close(); Google.pickPlaylist('From which playlist?', (p) => this.pickSongs({ title: p.name, mix, onDone, pre: 0, note: 'Tick the songs you want, or Select all.', load: () => YTData.playlistItems(p.id) })); }
          if (k === 'read') {
            const id = YTData.parsePlaylistId(body.querySelector('[data-l=link]').value);
            if (!id) { toast("That doesn't look like a playlist link"); return; }
            pick('Playlist', () => YTData.playlistItems(id));
          }
        });
      },
    });
  },
  openSort(mix, onDone) {
    const opts = [['artist', 'Artist A–Z (ignoring "The"), then title'], ['title', 'Title A–Z'], ['added', 'The order they were added'], ['reverse', 'Reverse the order'], ['shuffle', 'Shuffle']];
    Sheets.open({
      title: 'Sort',
      html: '<div class="rows">' + opts.map(([k, t]) => `<button class="rowbtn" data-o="${k}"><span>${t}</span>${ICON.chev}</button>`).join('') + '</div><p class="muted small">This sorts the list in Mixtape. Saving adds songs in this order.</p>',
      onMount: (body, close) => {
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-o]');
          if (!b) return;
          const k = b.dataset.o, s = mix.songs;
          const by = (f) => (x, y) => f(x).localeCompare(f(y));
          if (k === 'artist') s.sort((x, y) => norm(x.a).localeCompare(norm(y.a)) || norm(x.t).localeCompare(norm(y.t)));
          if (k === 'title') s.sort(by((x) => norm(x.t)));
          if (k === 'added') s.sort((x, y) => (x.n || 0) - (y.n || 0));
          if (k === 'reverse') s.reverse();
          if (k === 'shuffle') shuffle(s);
          this.put(mix);
          close();
          if (onDone) onDone();
        });
      },
    });
  },

  async useInGame(mix) {
    const id = mix.saved && mix.saved.id;
    if (!id) return;
    toast('Reading the playlist…');
    const items = await YTData.playlistItems(id);
    if (!items.length) throw new ApiError('That playlist has no playable songs yet.');
    Store.set('pool.' + id, items);
    const pools = Store.get('pools', []).filter((p) => p.id !== id);
    pools.push({ id, name: mix.name, count: items.length, updated: new Date().toISOString() });
    Store.set('pools', pools);
    SongFinder.forget();
    Pool.set(Object.assign(Pool.defaults(), { playlists: [id], hits: Pool.get().hits }));
    if (typeof Game !== 'undefined') { Game.round = null; Game.mode = 'guess'; }
    toast(`Game pool: ${mix.name}`);
    go('#game');
  },
  markSaved(mixId, playlistId, name, made) {
    const mix = this.get(mixId);
    if (!mix) return;
    mix.saved = { id: playlistId, at: new Date().toISOString(), made: !!(made || (mix.saved && mix.saved.made)) };
    if (!mix.target) mix.target = { id: playlistId, name };
    this.put(mix);
  },
};

/* ---------------- Saving to YouTube Music (one job at a time, carries on across days) ---------------- */
const Job = {
  busy: false,
  get() { return Store.get('saveJob', null); },
  set(j) { Store.set('saveJob', j, true); document.dispatchEvent(new Event('mixjob')); },
  current(j) { const c = this.get(); return c && c.started === j.started && c.state === 'running'; },
  start(mix) {
    const cur = this.get();
    if (cur && cur.state !== 'done' && !confirm(`"${cur.name}" hasn't finished saving. Stop it and save this one instead?`)) return false;
    this.set({ mixId: mix.id, name: mix.name, playlistId: mix.target ? mix.target.id : '', privacy: mix.privacy || 'private', clean: !!mix.clean,
      songs: mix.songs.map((s) => ({ a: s.a, t: s.t, v: s.v || '' })), i: 0, added: 0, already: 0, missing: [], state: 'running', started: new Date().toISOString(), why: '' });
    this.run(true);
    return true;
  },
  stop() { const j = this.get(); if (j) { j.state = 'done'; j.stopped = true; this.set(j); } },
  clear() { try { localStorage.removeItem('mixtape.saveJob'); } catch (e) { /* ignore */ } document.dispatchEvent(new Event('mixjob')); },
  async run(force) {
    if (this.busy) return;
    const j = this.get();
    if (!j || j.state === 'done') return;
    if (!force && j.state === 'paused' && (j.limitDay === YTData.day() || !j.limitDay)) return;   // waits for tomorrow, or for a tap
    if (!Google.on()) { j.state = 'paused'; j.limitDay = ''; j.why = 'Sign in with Google to carry on (Settings → YouTube Music).'; this.set(j); return; }
    this.busy = true;
    j.state = 'running'; j.why = ''; j.limitDay = '';
    this.set(j);
    try {
      if (!j.playlistId) {
        const r = await YTData.auth('POST', 'playlists', { part: 'snippet,status' }, { snippet: { title: j.name.slice(0, 150), description: 'Made with Mixtape' }, status: { privacyStatus: j.privacy } });
        j.playlistId = r.id;
        j.made = true;
        this.set(j);
        Builder.markSaved(j.mixId, r.id, j.name, true);
      }
      // What's in the playlist already, so nothing goes in twice (also after an interrupted save)
      const have = new Set((await YTData.playlistItems(j.playlistId)).map((it) => it.v));
      while (j.i < j.songs.length) {
        if (!this.current(j)) return;                 // stopped, or replaced by another save
        const s = j.songs[j.i];
        let v = j.clean ? '' : s.v;
        if (!v) v = await SongFinder.find(s.a, s.t, { clean: j.clean });
        if (!v && j.clean) v = s.v || await SongFinder.find(s.a, s.t);   // no clean version found: the regular one
        if (!v) j.missing.push(`${s.a} — ${s.t}`);
        else if (have.has(v)) j.already++;
        else {
          try {
            await YTData.auth('POST', 'playlistItems', { part: 'snippet' }, { snippet: { playlistId: j.playlistId, resourceId: { kind: 'youtube#video', videoId: v } } });
            have.add(v);
            j.added++;
          } catch (e) {
            if (/videoNotFound|videoNotAvailable/i.test(e.reason || '')) j.missing.push(`${s.a} — ${s.t}`);
            else throw e;
          }
          await sleep(150);
        }
        j.i++;
        if (!this.current(j)) return;
        this.set(j);
      }
      j.state = 'done';
      j.finished = new Date().toISOString();
      this.set(j);
      Builder.markSaved(j.mixId, j.playlistId, j.name);
      toast(`Saved "${j.name}" to YouTube Music`);
    } catch (e) {
      if (!this.current(j)) return;
      j.state = 'paused';
      if (e instanceof LimitError) { j.limitDay = YTData.day(); j.why = e.message + ' Saving carries on by itself after that, whenever Mixtape is open.'; }
      else { j.why = e.message || String(e); Errors.show('Saving the playlist stopped: ' + j.why, e instanceof ApiError ? '' : e); }
      this.set(j);
    } finally { this.busy = false; }
  },
};
// Carry on with an unfinished save when Mixtape opens or comes back on screen
const resumeJob = () => { if (Sync.url() && Job.get()) setTimeout(() => Job.run(false).catch(() => {}), 2500); };
document.addEventListener('DOMContentLoaded', resumeJob);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeJob(); });

/* ---------------- The Playlist Builder screens ---------------- */
Views.builder = {
  mixId() { const m = (location.hash || '').match(/[?&]mix=([^&]+)/); return m ? decodeURIComponent(m[1]) : ''; },
  html() {
    const id = this.mixId();
    const mix = id && Builder.get(id);
    return `<div class="screen" id="builder-root">
      <header class="topbar">
        <button class="icon-btn" data-b="back" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>${mix ? 'Playlist' : 'Playlist Builder'}</h1></div>
        <button class="icon-btn" data-b="help" aria-label="Help">?</button>
      </header>
      <div data-b="body"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const id = this.mixId();
    if (id && !Builder.get(id)) { go('#builder'); return; }
    this.el = el;
    if (id) this.editor(el, id); else this.home(el);
    el.querySelector('[data-b=back]').onclick = () => go(id ? '#builder' : '#home');
    el.querySelector('[data-b=help]').onclick = () => showHelp('builder');
    firstVisit('builder');
    if (Job.get() && !Job.busy) Job.run(false);
  },

  /* ---- the list of playlists ---- */
  home(el) {
    const body = el.querySelector('[data-b=body]');
    const draw = () => {
      const list = Builder.list();
      body.innerHTML = `${accountCard()}${jobCard()}
        <div class="pad row" style="margin-top:12px">
          <button class="btn small primary" style="flex:1" data-h="new">+ New playlist</button>
          ${Google.on() ? '<button class="btn small" style="flex:1" data-h="mine">Add to one of yours</button>' : ''}
        </div>
        <div class="list-h">In Mixtape</div>
        ${list.length ? '<div class="my-list">' + list.map((m) => `<button class="diary-row" data-h="open" data-id="${esc(m.id)}"><span class="main"><span class="n">${esc(m.name)}</span>
            <span class="c">${m.songs.length} song${m.songs.length === 1 ? '' : 's'} · ${m.saved ? 'saved ' + esc(new Date(m.saved.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) : m.target ? 'adds to your playlist' : 'not saved yet'}</span></span>${ICON.chev}</button>`).join('') + '</div>'
          : '<p class="muted pad">Nothing here yet. Tap <b>+ New playlist</b>, or tap <b>+ Playlist</b> on any song, album or artist card.</p>'}`;
    };
    draw();
    this.redraw = draw;
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-h]');
      if (!b) return;
      const h = b.dataset.h;
      if (h === 'new') { const m = Builder.create(''); go('#builder?mix=' + m.id); }
      if (h === 'mine') Google.pickPlaylist('Add songs to which playlist?', (p) => { const m = Builder.forPlaylist(p); go('#builder?mix=' + m.id); });
      if (h === 'open') go('#builder?mix=' + b.dataset.id);
    });
  },

  /* ---- one playlist ---- */
  editor(el, id) {
    const body = el.querySelector('[data-b=body]');
    let showAll = false;
    const mixNow = () => Builder.get(id);
    const draw = () => {
      const mix = mixNow();
      if (!mix) { go('#builder'); return; }
      Store.set('currentMix', mix.id, true);
      const est = Builder.estimate(mix);
      const n = mix.songs.length;
      const shown = showAll ? mix.songs : mix.songs.slice(0, 300);
      const j = Job.get();
      const mine = j && j.mixId === mix.id && j.state !== 'done';
      body.innerHTML = `${accountCard()}${mine ? jobCard() : ''}
        <div class="pad" style="margin-top:12px">
          <input class="field mx-name" data-e="name" value="${esc(mix.name)}" placeholder="Playlist name" autocomplete="off" spellcheck="false" aria-label="Playlist name">
          ${mix.target ? `<p class="muted small" style="margin:6px 2px 0">${mix.saved && mix.saved.id === mix.target.id && mix.saved.made ? 'Saved as' : 'Adds to your playlist'} <b>${esc(mix.target.name)}</b> in YouTube Music. Songs already in it are skipped.</p>` : ''}
        </div>
        <div class="pad row mx-add" style="margin-top:12px">
          <button class="btn small" data-e="search">Search</button>
          <button class="btn small" data-e="genre">Genre or decade</button>
          <button class="btn small" data-e="pl">From a playlist</button>
        </div>
        <div class="pad my-head"><span class="muted small">${n} song${n === 1 ? '' : 's'}${n ? ' · drag ≡ to move' : ''}</span>
          <span class="row" style="gap:14px">${n > 1 ? '<button class="link-btn" data-e="sort">Sort</button>' : ''}${n ? '<button class="link-btn" data-e="clear">Clear</button>' : ''}</span></div>
        ${n ? `<div class="my-list mx-list" data-e="list">${shown.map((s, i) => `<div class="mx-row" data-i="${i}">
              <span class="grip" aria-label="Drag to move">≡</span>
              <button class="mx-main" ${Cards.attrs('song', { artist: s.a, title: s.t, v: s.v })}><span class="num">${i + 1}</span><span class="tx"><span class="n">${esc(s.t)}</span><span class="c">${esc(s.a)}</span></span></button>
              <button class="icon-btn sm" data-e="del" data-i="${i}" aria-label="Remove ${esc(s.t)}">${ICON.close}</button></div>`).join('')}</div>
            ${shown.length < n ? `<div class="pad"><button class="link-btn" data-e="all">Show all ${n} songs</button></div>` : ''}`
          : '<p class="muted pad">No songs yet. Add some with the buttons above, or tap <b>+ Playlist</b> on any info card.</p>'}

        <div class="list-h">Saving</div>
        <div class="list">
          <label class="li"><span>Prefer clean versions<div class="sub">Looks for clean or radio-edit versions where YouTube has them.</div></span>
            <span class="switch"><input type="checkbox" data-e="clean" ${mix.clean ? 'checked' : ''}><span></span></span></label>
          ${mix.target ? '' : `<div class="li"><span>Who can see it</span><span class="seg" role="group">${['private', 'unlisted', 'public'].map((p) => `<button class="${mix.privacy === p ? 'on' : ''}" data-e="priv" data-v="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</span></div>`}
        </div>
        ${n ? `<p class="muted small pad" style="margin-top:10px">${est.lookups ? `${est.lookups} song${est.lookups === 1 ? '' : 's'} still need${est.lookups === 1 ? 's' : ''} a YouTube lookup. ` : ''}${est.days > 1 ? `With YouTube's free daily limit this takes about <b>${est.days} days</b>; it stops each day and carries on by itself the next time Mixtape is open.` : 'Fits in one day of YouTube\'s free limit.'} Keep Mixtape open while it saves.</p>` : ''}
        <div class="pad" style="display:flex; flex-direction:column; gap:10px; margin-top:12px">
          <button class="btn primary wide" data-e="save" ${n && !mine ? '' : 'disabled'}>${mix.target ? `Add new songs to “${esc(mix.target.name)}”` : 'Save to YouTube Music'}</button>
          ${mix.saved ? `<div class="row"><button class="btn small" style="flex:1" data-e="open">${ICON.out} Open in YouTube Music</button><button class="btn small" style="flex:1" data-e="game">${ICON.play} Use in the game</button></div>` : ''}
          <button class="link-btn" data-e="delete" style="align-self:center">Delete this list from Mixtape</button>
        </div>`;
    };
    draw();
    this.redraw = draw;

    // name: saved as you type
    let nameTimer = null;
    body.addEventListener('input', (e) => {
      if (e.target.dataset.e !== 'name') return;
      clearTimeout(nameTimer);
      const v = e.target.value;
      nameTimer = setTimeout(() => { const m = mixNow(); if (m) { m.name = v.trim() || 'New playlist'; Builder.put(m); } }, 400);
    });
    body.addEventListener('change', (e) => {
      if (e.target.dataset.e === 'clean') { const m = mixNow(); m.clean = e.target.checked; Builder.put(m); draw(); }
    });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-e]');
      if (!b || b.tagName === 'INPUT') return;
      const k = b.dataset.e, mix = mixNow();
      try {
        if (k === 'search') Builder.openSearch(mix, draw);
        if (k === 'genre') Builder.openGenres(mix, draw);
        if (k === 'pl') Builder.openPlaylists(mix, draw);
        if (k === 'sort') Builder.openSort(mix, draw);
        if (k === 'all') { showAll = true; draw(); }
        if (k === 'del') { mix.songs.splice(parseInt(b.dataset.i, 10), 1); Builder.put(mix); draw(); }
        if (k === 'clear') { if (confirm(`Remove all ${mix.songs.length} songs from this list?`)) { mix.songs = []; Builder.put(mix); draw(); } }
        if (k === 'priv') { mix.privacy = b.dataset.v; Builder.put(mix); draw(); }
        if (k === 'save') {
          if (!Google.on()) { toast('Sign in with Google first'); if (Sync.has('google')) Google.start(() => route()); return; }
          const est = Builder.estimate(mix);
          if (est.days > 1 && !confirm(`This takes about ${est.days} days with YouTube's free daily limit. Mixtape saves what it can today and carries on each day it's open. Start?`)) return;
          if (Job.start(mix)) draw();
        }
        if (k === 'open') window.open(Builder.ytmUrl(mix.saved.id), '_blank');
        if (k === 'game') await Builder.useInGame(mix);
        if (k === 'delete') {
          if (confirm(`Delete "${mix.name}" from Mixtape?${mix.saved ? ' The playlist stays in YouTube Music.' : ''}`)) { Builder.remove(mix.id); go('#builder'); }
        }
      } catch (err) { Errors.show(err.message || String(err), err instanceof ApiError ? '' : err); }
    });

    // Drag ≡ to reorder
    let drag = null;
    body.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('.grip');
      if (!g) return;
      e.preventDefault();
      const row = g.closest('.mx-row');
      drag = { row, list: row.parentElement, id: e.pointerId };
      row.classList.add('dragging');
      try { g.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    body.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      const y = e.clientY;
      if (y < 90) window.scrollBy(0, -14); else if (y > window.innerHeight - 90) window.scrollBy(0, 14);
      const rows = [...drag.list.querySelectorAll('.mx-row')].filter((r) => r !== drag.row);
      const before = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if (before) { if (drag.row.nextElementSibling !== before) drag.list.insertBefore(drag.row, before); }
      else if (drag.list.lastElementChild !== drag.row) drag.list.appendChild(drag.row);
    });
    const endDrag = () => {
      if (!drag) return;
      const mix = mixNow();
      const order = [...drag.list.querySelectorAll('.mx-row')].map((r) => parseInt(r.dataset.i, 10));
      const rest = mix.songs.map((_, i) => i).filter((i) => !order.includes(i));
      const moved = order.some((v, i) => v !== i);
      drag.row.classList.remove('dragging');
      drag = null;
      if (moved) { mix.songs = order.concat(rest).map((i) => mix.songs[i]); Builder.put(mix); }
      draw();
    };
    body.addEventListener('pointerup', endDrag);
    body.addEventListener('pointercancel', endDrag);
  },
};
// Keep the screen up to date while a save runs or other screens add songs
['mixjob', 'mixes'].forEach((ev) => document.addEventListener(ev, () => {
  if (currentView !== Views.builder || !Views.builder.redraw) return;
  if (document.querySelector('.mx-row.dragging')) return;
  const live = document.querySelector('[data-b=body] [data-j=bar]');
  const j = Job.get();
  if (ev === 'mixjob' && live && j && j.state === 'running') { live.outerHTML = jobBar(j); return; }   // just move the bar
  const y = window.scrollY;
  Views.builder.redraw();
  window.scrollTo(0, y);
}));

function accountCard() {
  if (Google.on()) return '';
  const ready = Sync.has('google');
  return `<div class="note-card"><b>Saving to YouTube Music needs Google sign-in.</b>
    <span>${ready ? 'You can build playlists now and save them once you sign in.' : 'The relay isn\'t set up for Google sign-in yet, so for now playlists stay in Mixtape.'}</span>
    ${ready ? '<button class="btn small primary" data-j="signin">Sign in with Google</button>' : ''}</div>`;
}
function jobBar(j) {
  const pct = j.songs.length ? Math.round((j.i / j.songs.length) * 100) : 0;
  return `<div data-j="bar"><div class="bar" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div>
    <span class="muted small">${j.i} of ${j.songs.length} songs · ${j.added} added${j.already ? ` · ${j.already} already there` : ''}${j.missing.length ? ` · ${j.missing.length} not found` : ''}</span></div>`;
}
function jobCard() {
  const j = Job.get();
  if (!j) return '';
  if (j.state === 'done') {
    if (j.stopped) return '';
    return `<div class="note-card"><b>Saved “${esc(j.name)}”</b><span>${j.added} song${j.added === 1 ? '' : 's'} added${j.already ? `, ${j.already} were already there` : ''}.${j.missing.length ? ` Not found on YouTube: ${esc(j.missing.slice(0, 8).join('; '))}${j.missing.length > 8 ? '…' : ''}` : ''}</span>
      <span class="row"><button class="btn small" data-j="openj">${ICON.out} Open in YouTube Music</button><button class="btn small ghost" data-j="dismiss">OK</button></span></div>`;
  }
  return `<div class="note-card"><b>${j.state === 'running' ? 'Saving' : 'Paused'}: “${esc(j.name)}”</b>${jobBar(j)}
    ${j.why ? `<span>${esc(j.why)}</span>` : '<span>Keep Mixtape open. If you leave, it picks up where it stopped.</span>'}
    <span class="row">${j.state === 'running' ? '' : '<button class="btn small primary" data-j="go">Carry on now</button>'}<button class="btn small" data-j="stop">Stop</button></span></div>`;
}
function jobClick(k, b) {
  const j = Job.get();
  if (k === 'signin') Google.start(() => { route(); Job.run(true); });
  if (k === 'go') Job.run(true);
  if (k === 'stop' && confirm('Stop saving? Songs already added stay in the playlist.')) Job.stop();
  if (k === 'dismiss') Job.clear();
  if (k === 'openj' && j && j.playlistId) window.open(Builder.ytmUrl(j.playlistId), '_blank');
}
// The note cards' buttons use data-j; send them to jobClick
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-j]');
  if (b && b.tagName === 'BUTTON' && currentView === Views.builder) jobClick(b.dataset.j, b);
});

HELP.builder = {
  title: 'Playlist Builder',
  html: `<p>Make a playlist here, then save it to YouTube Music. It shows up in your YouTube Music library like any other playlist.</p>
    <ul><li><b>+ New playlist</b>, then add songs: <b>Search</b> (songs and artists, close matches as you type), <b>Genre or decade</b>, or <b>From a playlist</b>. Any song, album or artist card has <b>+ Playlist</b> too.</li>
    <li>Tick songs with Select all / Select none / Top 10. Songs already in the list are skipped.</li>
    <li>Drag <b>≡</b> to move a song, <b>×</b> to remove it, <b>Sort</b> to sort or shuffle. Tap a song for its card.</li>
    <li><b>Save to YouTube Music</b> makes the playlist (Private unless you pick Unlisted or Public). After that the button adds any new songs to it.</li>
    <li><b>Add to one of yours</b> adds songs to a playlist you already have; songs already in it are skipped.</li>
    <li><b>Prefer clean versions</b> looks for clean or radio-edit versions. YouTube doesn't label them reliably, so check a song or two.</li></ul>
    <h3>YouTube's daily limit</h3>
    <p>YouTube gives Mixtape a free allowance each day (it resets at midnight Pacific). Adding a song costs 50 units of 10,000; a song Mixtape hasn't seen before also needs a lookup (100 units, and 100 lookups a day at most). Songs from your playlists are already known, so they're cheaper. A big playlist saves a bit each day: keep Mixtape open while it works, and it carries on by itself the next day.</p>`,
};
