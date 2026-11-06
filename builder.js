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
    if (j && j.state !== 'done') return j.state === 'running' ? `${jobVerb(j)} ${j.i} of ${Job.total(j) || '…'}…` : `Paused at ${j.i} of ${Job.total(j) || '…'}`;
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

/* ---------------- Organizing playlists already in YouTube Music ---------------- */
const SORTS = {
  artist: 'Artist (ignoring "The"), then albums by year, then track number',
  title: 'Song title A–Z',
  album: 'Album A–Z, then track number',
  year: 'Year (oldest first), then artist',
  decade: 'Decade, then artist A–Z within each decade',
  newest: 'Date added (newest first)',
  oldest: 'Date added (oldest first)',
};
const WRONG = [
  [/\blive\b|\bin concert\b|\bunplugged\b/i, 'live'],
  [/\bdemo\b/i, 'demo'],
  [/\bremix\b|\bmix\)|\bextended\b/i, 'remix'],
  [/\bcover\b|\bkaraoke\b|\btribute\b/i, 'cover'],
  [/\bacoustic\b/i, 'acoustic'],
  [/\binstrumental\b/i, 'instrumental'],
  [/\bsped up\b|\bslowed\b|\breverb\b|\b8d\b|\bnightcore\b/i, 'sped up or slowed'],
  [/official (music )?video|music video|\bvideo\)|\bmv\b|\bvisuali[sz]er\b/i, 'music video'],
  [/\blyrics?\b( video)?/i, 'lyric video'],
];
const Organize = {
  cache: null,                       // { id, name, items, at } for the playlist on screen
  // Every entry in a playlist, with its entry id (needed to move or remove it) and album details
  async read(id, onProgress) {
    const out = [];
    let pageToken = '', guard = 0;
    do {
      let j;
      try { j = await YTData.get('playlistItems', { part: 'snippet,contentDetails', playlistId: id, maxResults: 50, pageToken }); }
      catch (e) {
        // YouTube answers "not found" for a brand-new or empty playlist of yours; check it really exists before giving up
        if (e.status !== 404 || pageToken || !Google.on()) throw e;
        const p = await YTData.auth('GET', 'playlists', { part: 'id', id }).catch(() => ({}));
        if ((p.items || []).length) return out;
        throw e;
      }
      (j.items || []).forEach((it) => {
        const sn = it.snippet || {}, v = (it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId) || '';
        const rawT = String(sn.title || ''), chan = String(sn.videoOwnerChannelTitle || '');
        const c = cleanItem(sn, v);
        const e = { pid: it.id, v, rawT, chan, topic: / - Topic$/i.test(chan), added: sn.publishedAt || '', gone: !c,
          a: c ? c.a : '', t: c ? c.t : (rawT || 'Unavailable video'), album: '', year: 0 };
        if (c) Object.assign(e, this.fromDescription(sn.description || ''));
        out.push(e);
      });
      pageToken = j.nextPageToken || '';
      if (onProgress) onProgress(out.length, (j.pageInfo && j.pageInfo.totalResults) || 0);
      guard++;
    } while (pageToken && guard < 200);
    return out;
  },
  // YouTube's album versions ("Topic") carry the album and year in their description
  fromDescription(d) {
    if (!/^Provided to YouTube by/i.test(d)) return {};
    const blocks = d.split(/\n\s*\n/).map((b) => b.trim());
    const album = blocks[2] && !/^℗|^Released on|^©/.test(blocks[2]) ? blocks[2] : '';
    const ys = [d.match(/Released on: (\d{4})/), d.match(/℗ (\d{4})/)].filter(Boolean).map((m) => +m[1]).filter((y) => y > 1900);
    return { album, year: ys.length ? Math.min(...ys) : 0 };
  },
  needsAlbum(key) { return ['artist', 'album', 'year', 'decade'].includes(key); },
  // Album, year and track number for every song the sort needs them for (remembered on this phone)
  async enrich(items, key, onProgress) {
    if (!this.needsAlbum(key)) return;
    const live = items.filter((e) => !e.gone);
    let n = 0;
    for (const e of live) {                                          // album + year for songs that aren't album versions (Apple's search)
      if (!e.album || !e.year) {
        const m = await Meta.get({ v: e.v, a: e.a, t: e.t }).catch(() => null);
        if (m) { e.album = e.album || m.album; e.year = e.year || (+m.year || 0); }
      }
      if (onProgress && ++n % 10 === 0) onProgress(`Album details: ${n} of ${live.length}`);
    }
    if (key === 'year' || key === 'decade') return;
    const albums = [...new Set(live.filter((e) => e.album).map((e) => this.albumKey(e)))];
    let k = 0;
    for (const ak of albums) {                                       // track numbers, one album at a time (MusicBrainz)
      const e = live.find((x) => this.albumKey(x) === ak);
      await this.trackList(e.a, e.album).catch(() => null);
      if (onProgress) onProgress(`Track numbers: ${++k} of ${albums.length} albums`);
    }
    live.forEach((e) => { e.track = this.trackNo(e); });
  },
  albumKey(e) { return norm(MyArtists.cleanName(e.a)) + '|' + norm(e.album); },
  async trackList(a, album) {
    const cache = Store.get('trackLists', {});
    const k = norm(MyArtists.cleanName(a)) + '|' + norm(album);
    if (cache[k]) return cache[k];
    const clean = String(album).replace(/\s*[\(\[][^\)\]]*(remaster|edition|deluxe|version|expanded|anniversary)[^\)\]]*[\)\]]/ig, '').trim();
    const j = await MB.get('release-group', { query: `releasegroup:${MB.q(clean)} AND artist:${MB.q(MyArtists.cleanName(a))}`, limit: 5 }, 0);
    const g = ((j && j['release-groups']) || []).map((x) => ({ x, s: (x.score || 0) / 100 + sim(x.title, clean) })).sort((p, q) => q.s - p.s)[0];
    let list = [];
    if (g && g.s > 1.5) { const at = await MB.albumTracks(g.x.id, 0); list = at.tracks.map((t) => norm(cleanTitle(t.t))); }
    cache[k] = list;
    const keys = Object.keys(cache);
    if (keys.length > 3000) keys.slice(0, 500).forEach((x) => delete cache[x]);
    Store.set('trackLists', cache, true);
    return list;
  },
  trackNo(e) {
    const list = Store.get('trackLists', {})[this.albumKey(e)] || [];
    const t = norm(cleanTitle(e.t));
    let best = 0, at = 0;
    list.forEach((x, i) => { const s = x === t ? 1 : sim(x, t); if (s > best) { best = s; at = i + 1; } });
    return best >= 0.8 ? at : 0;
  },
  sortKey(e, key) {
    const a = norm(MyArtists.cleanName(e.a)), t = norm(e.t), al = norm(e.album), y = e.year || 9999, tr = e.track || 999;
    if (e.gone) return [1, ''];
    if (key === 'artist') return [0, a, y, al, tr, t];
    if (key === 'title') return [0, t, a];
    if (key === 'album') return [0, al || '~', a, tr, t];
    if (key === 'year') return [0, y, a, al, tr, t];
    if (key === 'decade') return [0, Math.floor(y / 10), a, y, al, tr, t];
    if (key === 'newest') return [0, -Date.parse(e.added || 0) || 0];
    if (key === 'oldest') return [0, Date.parse(e.added || 0) || 0];
    return [0];
  },
  cmp(x, y) {
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const a = x[i], b = y[i];
      if (a === b) continue;
      if (a === undefined) return -1;
      if (b === undefined) return 1;
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
      if (c) return c;
    }
    return 0;
  },
  sorted(items, key) {
    return items.map((e, i) => ({ e, i, k: this.sortKey(e, key) })).sort((p, q) => this.cmp(p.k, q.k) || p.i - q.i).map((x) => x.e);
  },
  // The fewest moves that turn the current order into the new one: songs already in the right order
  // relative to each other stay put (longest increasing run), the rest are slotted in after their new neighbor.
  moves(current, desired) {
    const ids = desired.map((e) => e.pid);
    const rank = new Map(ids.map((p, i) => [p, i]));
    const seq = current.map((e) => rank.get(e.pid));
    const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
    seq.forEach((r, i) => {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < r) lo = m + 1; else hi = m; }
      tails[lo] = r; tailIdx[lo] = i;
      prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    });
    const keep = new Set();
    for (let i = tailIdx[tails.length - 1]; i !== undefined && i >= 0; i = prev[i]) keep.add(current[i].pid);
    const arr = current.map((e) => e.pid), out = [];
    ids.forEach((pid, k) => {
      if (keep.has(pid)) return;
      arr.splice(arr.indexOf(pid), 1);
      const pos = k === 0 ? 0 : arr.indexOf(ids[k - 1]) + 1;
      arr.splice(pos, 0, pid);
      out.push({ pid, position: pos });
    });
    return out;
  },
  // Where a new song belongs in a sorted playlist
  slot(items, e, key) {
    const k = this.sortKey(e, key);
    let pos = items.length;
    for (let i = 0; i < items.length; i++) if (this.cmp(this.sortKey(items[i], key), k) > 0) { pos = i; break; }
    return pos;
  },
  flags(e) {
    if (e.gone) return [];
    // Only the extras count: "(Live)", "- Live at the Fillmore", "[Official Video]" — not a song called "Live Forever"
    const segs = e.rawT.split(/\s[-–—|]\s/);
    const rest = segs.length > 1 && sim(segs[0], e.a) > 0.6 ? segs.slice(2) : segs.slice(1);
    const extra = (e.rawT.match(/[\(\[][^\)\]]*[\)\]]/g) || []).join(' ') + ' ' + rest.join(' ');
    const out = [];
    WRONG.forEach(([re, why]) => { if (re.test(extra)) out.push(why); });
    if (!e.topic && e.chan && !/vevo$/i.test(e.chan) && sim(MyArtists.cleanName(e.chan), MyArtists.cleanName(e.a)) < 0.6) out.push('uploaded by ' + e.chan);
    return [...new Set(out)];
  },
  duplicates(items) {
    const groups = new Map();
    items.forEach((e) => { if (e.gone) return; const k = songKey(MyArtists.cleanName(e.a), cleanTitle(e.t)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
    return [...groups.values()].filter((g) => g.length > 1).map((g) => { const keep = g.find((e) => e.topic) || g[0]; return { keep, extra: g.filter((e) => e !== keep) }; });
  },
  sortedPlaylists() { return Store.get('sortedPlaylists', {}); },
  keepSorted(id, key) { const s = this.sortedPlaylists(); if (key) s[id] = key; else delete s[id]; Store.set('sortedPlaylists', s); },
};

/* ---------------- Jobs that change YouTube Music (one at a time, carry on across days) ---------------- */
const Job = {
  busy: false,
  get() { return Store.get('saveJob', null); },
  set(j) { Store.set('saveJob', j, true); document.dispatchEvent(new Event('mixjob')); },
  current(j) { const c = this.get(); return c && c.started === j.started && c.state === 'running'; },
  total(j) { return j.total != null ? j.total : (j.songs || j.pids || j.swaps || []).length; },
  begin(spec) {
    const cur = this.get();
    if (cur && cur.state !== 'done' && !confirm(`"${cur.name}" hasn't finished in YouTube Music. Stop it and do this instead?`)) return false;
    this.set(Object.assign({ i: 0, state: 'running', started: new Date().toISOString(), why: '' }, spec));
    this.run(true);
    return true;
  },
  start(mix) {
    return this.begin({ kind: 'save', mixId: mix.id, name: mix.name, playlistId: mix.target ? mix.target.id : '', privacy: mix.privacy || 'private', clean: !!mix.clean,
      songs: mix.songs.map((s) => ({ a: s.a, t: s.t, v: s.v || '' })), added: 0, already: 0, missing: [] });
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
      const kind = j.kind || 'save';
      if (kind === 'save') await this.runSave(j);
      if (kind === 'remove') await this.runRemove(j);
      if (kind === 'swap') await this.runSwap(j);
      if (kind === 'sort') await this.runSort(j);
      if (kind === 'match') await this.runMatch(j);
      if (!this.current(j)) return;
      j.state = 'done';
      j.finished = new Date().toISOString();
      this.set(j);
      if (kind === 'save') Builder.markSaved(j.mixId, j.playlistId, j.name);
      if (Organize.cache && Organize.cache.id === j.playlistId) Organize.cache.stale = true;
      toast(kind === 'save' ? `Saved "${j.name}" to YouTube Music` : `Done: "${j.name}"`);
    } catch (e) {
      if (!this.current(j)) return;
      j.state = 'paused';
      if (e instanceof LimitError) { j.limitDay = YTData.day(); j.why = e.message + ' It carries on by itself after that, whenever Mixtape is open.'; }
      else { j.why = e.message || String(e); Errors.show('YouTube Music work stopped: ' + j.why, e instanceof ApiError ? '' : e); }
      this.set(j);
    } finally { this.busy = false; }
  },
  // step(): saves progress and says whether to keep going
  step(j) { j.i++; if (!this.current(j)) return false; this.set(j); return true; },

  async runSave(j) {
    if (!j.playlistId) {
      const r = await YTData.auth('POST', 'playlists', { part: 'snippet,status' }, { snippet: { title: j.name.slice(0, 150), description: 'Made with Mixtape' }, status: { privacyStatus: j.privacy } });
      j.playlistId = r.id;
      j.made = true;
      this.set(j);
      Builder.markSaved(j.mixId, r.id, j.name, true);
    }
    // What's in the playlist already, so nothing goes in twice (also after an interrupted save)
    const sortKey = Organize.sortedPlaylists()[j.playlistId] || '';
    const items = await Organize.read(j.playlistId);
    if (sortKey) await Organize.enrich(items, sortKey);
    const have = new Set(items.map((it) => it.v));
    while (j.i < j.songs.length) {
      if (!this.current(j)) return;
      const s = j.songs[j.i];
      const v = await this.video(j, s);
      if (!v) j.missing.push(`${s.a} — ${s.t}`);
      else if (have.has(v)) j.already++;
      else {
        // A playlist set to stay sorted gets the song in its spot, not at the bottom
        const e = { pid: '', v, a: s.a, t: s.t, album: '', year: 0, added: new Date().toISOString() };
        let position;
        if (sortKey) { await Organize.enrich([e], sortKey); position = Organize.slot(items, e, sortKey); }
        try {
          const r = await this.insert(j.playlistId, v, position);
          e.pid = r.id || '';
          if (position != null) items.splice(position, 0, e); else items.push(e);
          have.add(v);
          j.added++;
        } catch (err) {
          if (/videoNotFound|videoNotAvailable/i.test(err.reason || '')) j.missing.push(`${s.a} — ${s.t}`);
          else throw err;
        }
        await sleep(150);
      }
      if (!this.step(j)) return;
    }
  },
  // Which video to add for a song. With "Prefer clean versions": songs Apple says aren't explicit keep their
  // regular version; explicit (or unknown) ones get a labeled clean version if YouTube has one, otherwise the
  // regular version, and they're listed at the end so you can swap them by hand.
  async video(j, s) {
    if (!j.clean) return this.lookup(j, s);
    const ex = await Explicit.check(s.a, s.t);
    if (ex === 'n') return this.lookup(j, s);
    const c = await SongFinder.findClean(s.a, s.t);
    if (c) return c;
    const v = await this.lookup(j, s);
    if (v && ex === 'e') { j.unclean = j.unclean || []; if (!j.unclean.includes(`${s.t} — ${s.a}`)) j.unclean.push(`${s.t} — ${s.a}`); }
    return v;
  },
  // A song's regular version. When a save has 3 or more unknown songs by one artist, their YouTube "Topic"
  // channel is read once (one lookup) instead of looking each song up.
  async lookup(j, s) {
    if (s.v) return s.v;
    if (SongFinder.known(s.a, s.t)) return SongFinder.find(s.a, s.t);
    if (!j.artistCounts) {
      j.artistCounts = {};
      (j.songs || []).forEach((x) => { if (!x.v && !SongFinder.known(x.a, x.t)) { const k = norm(MyArtists.cleanName(x.a)); j.artistCounts[k] = (j.artistCounts[k] || 0) + 1; } });
    }
    if ((j.artistCounts[norm(MyArtists.cleanName(s.a))] || 0) >= 3) {
      const cat = await SongFinder.topicCatalog(MyArtists.cleanName(s.a));
      const v = cat.get(norm(cleanTitle(s.t)));
      if (v) { SongFinder.remember(s.a, s.t, v); return v; }
    }
    return SongFinder.find(s.a, s.t);
  },
  // Adding a song; a playlist made moments ago can say "not found" for a few seconds, so wait and try again
  async insert(playlistId, v, position) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await YTData.auth('POST', 'playlistItems', { part: 'snippet' }, { snippet: Object.assign({ playlistId, resourceId: { kind: 'youtube#video', videoId: v } }, position != null ? { position } : {}) });
      } catch (e) {
        if (attempt >= 5 || !/playlistNotFound/i.test(e.reason || '')) throw e;
        await sleep(3000);
      }
    }
  },
  async runRemove(j) {
    while (j.i < j.pids.length) {
      if (!this.current(j)) return;
      try { await YTData.auth('DELETE', 'playlistItems', { id: j.pids[j.i] }); j.done = (j.done || 0) + 1; }
      catch (e) { if (e.status !== 404) throw e; }                   // already gone
      await sleep(120);
      if (!this.step(j)) return;
    }
  },
  async runSwap(j) {
    const items = await Organize.read(j.playlistId);
    while (j.i < j.swaps.length) {
      if (!this.current(j)) return;
      const s = j.swaps[j.i];
      const at = items.findIndex((e) => e.pid === s.pid);
      if (at >= 0) {
        const v = await SongFinder.find(s.a, s.t, { album: true });
        if (!v || v === s.v) j.missing.push(`${s.a} — ${s.t}`);
        else {
          const r = await YTData.auth('POST', 'playlistItems', { part: 'snippet' }, { snippet: { playlistId: j.playlistId, resourceId: { kind: 'youtube#video', videoId: v }, position: at } });
          items.splice(at, 0, { pid: r.id, v });
          await YTData.auth('DELETE', 'playlistItems', { id: s.pid }).catch((e) => { if (e.status !== 404) throw e; });
          items.splice(at + 1, 1);
          j.done = (j.done || 0) + 1;
        }
        await sleep(120);
      }
      if (!this.step(j)) return;
    }
  },
  // Make a saved playlist match a list exactly: find each song, take out what's not wanted, add what's missing, then order it
  async runMatch(j) {
    j.vids = j.vids || [];
    while (j.vids.length < j.songs.length) {
      if (!this.current(j)) return;
      const s = j.songs[j.vids.length];
      const v = await this.video(j, s);
      if (!v) j.missing.push(`${s.a} — ${s.t}`);
      j.vids.push(v || '');
      j.phase = `Finding songs: ${j.vids.length} of ${j.songs.length}`;
      if (!this.current(j)) return;
      this.set(j);
    }
    const want = [...new Set(j.vids.filter(Boolean))];
    const wantSet = new Set(want);
    let items = await Organize.read(j.playlistId);
    const seen = new Set();
    const extra = items.filter((e) => { const keep = !e.gone && wantSet.has(e.v) && !seen.has(e.v); if (keep) seen.add(e.v); return !keep; });
    for (const e of extra) {
      if (!this.current(j)) return;
      j.phase = `Taking out songs no longer in the guide (${extra.indexOf(e) + 1} of ${extra.length})`; this.set(j);
      await YTData.auth('DELETE', 'playlistItems', { id: e.pid }).catch((err) => { if (err.status !== 404) throw err; });
      await sleep(120);
    }
    const missing = want.filter((v) => !seen.has(v));
    for (const v of missing) {
      if (!this.current(j)) return;
      j.phase = `Adding new songs (${missing.indexOf(v) + 1} of ${missing.length})`; this.set(j);
      await this.insert(j.playlistId, v);
      await sleep(150);
    }
    items = await Organize.read(j.playlistId);
    const rank = new Map(want.map((v, i) => [v, i]));
    const desired = items.slice().sort((a, b) => (rank.has(a.v) ? rank.get(a.v) : 1e9) - (rank.has(b.v) ? rank.get(b.v) : 1e9));
    const moves = Organize.moves(items, desired);
    const byPid = new Map(items.map((e) => [e.pid, e]));
    for (const m of moves) {
      if (!this.current(j)) return;
      j.phase = `Putting songs in show order (${moves.indexOf(m) + 1} of ${moves.length})`; this.set(j);
      await YTData.auth('PUT', 'playlistItems', { part: 'snippet' }, { id: m.pid, snippet: { playlistId: j.playlistId, resourceId: { kind: 'youtube#video', videoId: byPid.get(m.pid).v }, position: m.position } });
      await sleep(120);
    }
    j.done = true;
  },
  async runSort(j) {
    j.why = 'Reading the playlist…'; this.set(j);
    const items = await Organize.read(j.playlistId);
    await Organize.enrich(items, j.key, (msg) => { j.why = msg + '…'; if (this.current(j)) this.set(j); });
    const moves = Organize.moves(items, Organize.sorted(items, j.key));
    j.total = j.i + moves.length;
    j.why = '';
    this.set(j);
    const byPid = new Map(items.map((e) => [e.pid, e]));
    for (const m of moves) {
      if (!this.current(j)) return;
      const e = byPid.get(m.pid);
      await YTData.auth('PUT', 'playlistItems', { part: 'snippet' }, { id: m.pid, snippet: { playlistId: j.playlistId, resourceId: { kind: 'youtube#video', videoId: e.v }, position: m.position } });
      await sleep(120);
      if (!this.step(j)) return;
    }
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
        ${Google.on() ? '<div class="pad row" style="margin-top:10px"><button class="btn small wide" data-h="org">Organize one of your playlists</button></div>' : ''}
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
      if (h === 'org') Google.pickPlaylist('Organize which playlist?', (p) => go(organizeHash(p.id, p.name)));
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
      body.innerHTML = `${accountCard()}${j && j.mixId === mix.id ? jobCard() : ''}
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
          <span class="row" style="gap:14px">${n ? '<button class="link-btn" data-e="play">Play</button>' : ''}${n > 1 ? '<button class="link-btn" data-e="sort">Sort</button>' : ''}${n ? '<button class="link-btn" data-e="clear">Clear</button>' : ''}</span></div>
        ${n ? `<div class="my-list mx-list" data-e="list">${shown.map((s, i) => `<div class="mx-row" data-i="${i}">
              <span class="grip" aria-label="Drag to move">≡</span>
              <button class="mx-main" ${Cards.attrs('song', { artist: s.a, title: s.t, v: s.v })}><span class="num">${i + 1}</span><span class="tx"><span class="n">${esc(s.t)}${mix.clean ? explicitTag(s) : ''}</span><span class="c">${esc(s.a)}</span></span></button>
              <button class="icon-btn sm" data-e="del" data-i="${i}" aria-label="Remove ${esc(s.t)}">${ICON.close}</button></div>`).join('')}</div>
            ${shown.length < n ? `<div class="pad"><button class="link-btn" data-e="all">Show all ${n} songs</button></div>` : ''}`
          : '<p class="muted pad">No songs yet. Add some with the buttons above, or tap <b>+ Playlist</b> on any info card.</p>'}

        <div class="list-h">Saving</div>
        <div class="list">
          <label class="li"><span>Prefer clean versions<div class="sub">Songs marked <b>E</b> are explicit (from Apple's music data). Mixtape looks for a clean or radio-edit version of those; <b>E!</b> means YouTube has no labeled clean version, so the regular one goes in.</div></span>
            <span class="switch"><input type="checkbox" data-e="clean" ${mix.clean ? 'checked' : ''}><span></span></span></label>
          ${mix.target ? '' : `<div class="li"><span>Who can see it</span><span class="seg" role="group">${['private', 'unlisted', 'public'].map((p) => `<button class="${mix.privacy === p ? 'on' : ''}" data-e="priv" data-v="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</span></div>`}
        </div>
        ${n ? `<p class="muted small pad" style="margin-top:10px">${est.lookups ? `${est.lookups} song${est.lookups === 1 ? '' : 's'} still need${est.lookups === 1 ? 's' : ''} a YouTube lookup. ` : ''}${est.days > 1 ? `With YouTube's free daily limit this takes about <b>${est.days} days</b>; it stops each day and carries on by itself the next time Mixtape is open.` : 'Fits in one day of YouTube\'s free limit.'} Keep Mixtape open while it saves.</p>` : ''}
        <div class="pad" style="display:flex; flex-direction:column; gap:10px; margin-top:12px">
          <button class="btn primary wide" data-e="save" ${n && !mine ? '' : 'disabled'}>${mix.target ? `Add new songs to “${esc(mix.target.name)}”` : 'Save to YouTube Music'}</button>
          ${mix.saved ? `<div class="row"><button class="btn small" style="flex:1" data-e="open">${ICON.out} Open in YouTube Music</button><button class="btn small" style="flex:1" data-e="game">${ICON.play} Use in the game</button></div>
            <button class="btn small" data-e="org">Organize it in YouTube Music</button>` : ''}
          <button class="link-btn" data-e="delete" style="align-self:center">Delete this list from Mixtape</button>
        </div>`;
    };
    draw();
    this.redraw = draw;
    // With "Prefer clean versions" on, check which songs are explicit (Apple, a few a minute) and tag them
    const checkExplicit = async () => {
      const mix = mixNow();
      if (!mix || !mix.clean || this.checking) return;
      this.checking = true;
      try {
        for (const s of mix.songs) {
          if (currentView !== Views.builder || this.mixId() !== id || !(mixNow() || {}).clean) break;
          if (Explicit.known(s.a, s.t) !== undefined) continue;
          await Explicit.check(s.a, s.t);
          if (!document.querySelector('.mx-row.dragging')) { const y = window.scrollY; draw(); window.scrollTo(0, y); }
        }
      } finally { this.checking = false; }
    };
    this.checkExplicit = checkExplicit;
    checkExplicit();

    // name: saved as you type
    let nameTimer = null;
    body.addEventListener('input', (e) => {
      if (e.target.dataset.e !== 'name') return;
      clearTimeout(nameTimer);
      const v = e.target.value;
      nameTimer = setTimeout(() => { const m = mixNow(); if (m) { m.name = v.trim() || 'New playlist'; Builder.put(m); } }, 400);
    });
    body.addEventListener('change', (e) => {
      if (e.target.dataset.e === 'clean') { const m = mixNow(); m.clean = e.target.checked; Builder.put(m); draw(); if (m.clean) checkExplicit(); }
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
        if (k === 'play') Music.play(mix.songs, 0, { name: mix.name, playlist: mix.saved && mix.saved.id });
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
        if (k === 'org') go(organizeHash(mix.saved.id, mix.target ? mix.target.name : mix.name));
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

// E = explicit (Apple), E! = explicit and YouTube has no labeled clean version
function explicitTag(s) {
  const ex = Explicit.known(s.a, s.t);
  if (ex !== 'e') return '';
  const none = SongFinder.load()[songKey(s.a, s.t) + '|clean2'] === '';
  return `<span class="etag${none ? ' none' : ''}" title="${none ? 'Explicit; no clean version found' : 'Explicit'}">${none ? 'E!' : 'E'}</span>`;
}
function accountCard() {
  if (Google.on()) return '';
  const ready = Sync.has('google');
  return `<div class="note-card"><b>Saving to YouTube Music needs Google sign-in.</b>
    <span>${ready ? 'You can build playlists now and save them once you sign in.' : 'The relay isn\'t set up for Google sign-in yet, so for now playlists stay in Mixtape.'}</span>
    ${ready ? '<button class="btn small primary" data-j="signin">Sign in with Google</button>' : ''}</div>`;
}
function jobVerb(j) { return { save: 'Saving', remove: 'Removing', swap: 'Swapping', sort: 'Sorting', match: 'Matching' }[j.kind || 'save']; }
function jobBar(j) {
  const total = Job.total(j);
  const pct = total ? Math.round((j.i / total) * 100) : 0;
  const kind = j.kind || 'save';
  const text = kind === 'save' ? `${j.i} of ${total} songs · ${j.added} added${j.already ? ` · ${j.already} already there` : ''}${j.missing.length ? ` · ${j.missing.length} not found` : ''}`
    : kind === 'remove' ? `${j.i} of ${total} removed`
    : kind === 'swap' ? `${j.i} of ${total} checked · ${j.done || 0} swapped${j.missing.length ? ` · ${j.missing.length} with no album version` : ''}`
    : kind === 'match' ? (j.phase || 'Starting…')
    : j.total == null ? 'Working out the moves…' : `${j.i} of ${total} moves`;
  return `<div data-j="bar"><div class="bar" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div><span class="muted small">${text}</span></div>`;
}
function jobCard() {
  const j = Job.get();
  if (!j) return '';
  const kind = j.kind || 'save';
  if (j.state === 'done') {
    if (j.stopped) return '';
    const unclean = (j.unclean || []).length ? `<br><b style="color:var(--text)">Explicit, and YouTube has no labeled clean version of:</b> ${esc(j.unclean.join('; '))}. The regular version went in; swap these by hand in YouTube Music if you need to.` : '';
    const msg = kind === 'save' ? `${j.added} song${j.added === 1 ? '' : 's'} added${j.already ? `, ${j.already} were already there` : ''}.${j.missing.length ? ` Not found on YouTube: ${esc(j.missing.slice(0, 8).join('; '))}${j.missing.length > 8 ? '…' : ''}` : ''}${unclean}`
      : kind === 'remove' ? `${j.done || 0} song${j.done === 1 ? '' : 's'} removed.`
      : kind === 'match' ? `The playlist now matches the study guide.${j.missing.length ? ` Not found on YouTube: ${esc(j.missing.slice(0, 8).join('; '))}` : ''}${unclean}`
      : kind === 'swap' ? `${j.done || 0} swapped for the album version.${j.missing.length ? ` No album version found: ${esc(j.missing.slice(0, 8).join('; '))}${j.missing.length > 8 ? '…' : ''}` : ''}`
      : `The playlist is in its new order (${j.i} move${j.i === 1 ? '' : 's'}).`;
    return `<div class="note-card"><b>${kind === 'save' ? 'Saved' : 'Done'}: “${esc(j.name)}”</b><span>${msg}</span>
      <span class="row"><button class="btn small" data-j="openj">${ICON.out} Open in YouTube Music</button><button class="btn small ghost" data-j="dismiss">OK</button></span></div>`;
  }
  return `<div class="note-card"><b>${j.state === 'running' ? jobVerb(j) : 'Paused'}: “${esc(j.name)}”</b>${jobBar(j)}
    ${j.why ? `<span>${esc(j.why)}</span>` : '<span>Keep Mixtape open. If you leave, it picks up where it stopped.</span>'}
    <span class="row">${j.state === 'running' ? '' : '<button class="btn small primary" data-j="go">Carry on now</button>'}<button class="btn small" data-j="stop">Stop</button></span></div>`;
}
function jobClick(k, b) {
  const j = Job.get();
  if (k === 'signin') Google.start(() => { route(); Job.run(true); });
  if (k === 'go') Job.run(true);
  if (k === 'stop' && confirm('Stop? What\'s already done in YouTube Music stays done.')) Job.stop();
  if (k === 'dismiss') Job.clear();
  if (k === 'openj' && j && j.playlistId) window.open(Builder.ytmUrl(j.playlistId), '_blank');
}
// The note cards' buttons use data-j; send them to jobClick
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-j]');
  if (b && b.tagName === 'BUTTON' && (currentView === Views.builder || currentView === Views.organize)) jobClick(b.dataset.j, b);
});

HELP.builder = {
  title: 'Playlist Builder',
  html: `<p>Make a playlist here, then save it to YouTube Music. It shows up in your YouTube Music library like any other playlist.</p>
    <ul><li><b>+ New playlist</b>, then add songs: <b>Search</b> (songs and artists, close matches as you type), <b>Genre or decade</b>, or <b>From a playlist</b>. Any song, album or artist card has <b>+ Playlist</b> too.</li>
    <li>Tick songs with Select all / Select none / Top 10. Songs already in the list are skipped.</li>
    <li>Drag <b>≡</b> to move a song, <b>×</b> to remove it, <b>Sort</b> to sort or shuffle. Tap a song for its card.</li>
    <li><b>Save to YouTube Music</b> makes the playlist (Private unless you pick Unlisted or Public). After that the button adds any new songs to it.</li>
    <li><b>Add to one of yours</b> adds songs to a playlist you already have; songs already in it are skipped.</li>
    <li><b>Prefer clean versions</b>: Apple's music data says which songs are explicit (marked <b>E</b>). Songs that aren't explicit keep their regular version. For explicit ones Mixtape tries three searches for a version YouTube labels Clean or Radio Edit. Many clean versions on YouTube Music aren't labeled at all, so when none turns up the regular version goes in, the song is marked <b>E!</b>, and the save lists it so you can swap it by hand.</li></ul>
    <h3>YouTube's daily limit</h3>
    <p>YouTube gives Mixtape a free allowance each day (it resets at midnight Pacific). Adding a song costs 50 units of 10,000; a song Mixtape hasn't seen before also needs a lookup (100 units, and 100 lookups a day at most). Songs from your playlists are already known, so they're cheaper. A big playlist saves a bit each day: keep Mixtape open while it works, and it carries on by itself the next day.</p>`,
};

/* ---------------- Organize one of your YouTube Music playlists ---------------- */
function organizeHash(id, name) { return '#organize?pl=' + encodeURIComponent(id) + '&n=' + encodeURIComponent(name || ''); }
const baseTitle = (t) => String(t || '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s[-–—]\s.*$/, '').trim() || t;

Views.organize = {
  tab: 'sort',
  param(k) { const m = (location.hash || '').match(new RegExp('[?&]' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1]) : ''; },
  html() {
    return `<div class="screen">
      <header class="topbar">
        <button class="icon-btn" data-o="back" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>Organize</h1></div>
        <button class="icon-btn" data-o="help" aria-label="Help">?</button>
      </header>
      <div data-o="job"></div>
      <div data-o="head" class="pad" style="margin-top:6px"></div>
      <div data-o="tabs" class="pad chips" style="margin-top:12px"></div>
      <div data-o="body"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const $o = (k) => el.querySelector(`[data-o=${k}]`);
    const id = this.param('pl');
    let name = this.param('n') || 'Playlist';
    if (!id) { go('#builder'); return; }
    this.el = el;
    this.sel = new Set();
    this.q = ''; this.artist = ''; this.album = ''; this.goneOnly = false;
    this.preview = null;
    const items = () => (Organize.cache && Organize.cache.id === id ? Organize.cache.items : []);
    const drawJob = () => { const j = Job.get(); $o('job').innerHTML = j && j.playlistId === id ? jobCard() : ''; };
    this.drawJob = drawJob;
    const head = () => {
      const all = items(), gone = all.filter((e) => e.gone).length;
      $o('head').innerHTML = `<div style="font-family: var(--display); font-weight: 700; font-size: 22px">${esc(name)}</div>
        <div class="row" style="align-items:center; justify-content:space-between; gap:10px; margin-top:4px">
          <span class="muted small" data-o="count">${all.length ? `${all.length} songs${gone ? ` · ${gone} unavailable` : ''}` : 'Reading…'}</span>
          <span class="row" style="gap:14px"><button class="link-btn" data-o="play">Play</button><button class="link-btn" data-o="refresh">Refresh</button><button class="link-btn" data-o="ytm">Open ↗</button></span></div>
        ${Organize.sortedPlaylists()[id] ? `<p class="muted small" style="margin:4px 0 0">Kept sorted: ${esc(SORTS[Organize.sortedPlaylists()[id]].toLowerCase())}.</p>` : ''}`;
    };
    const tabs = () => {
      const t = [['sort', 'Sort'], ['find', 'Find & remove'], ['wrong', 'Wrong versions'], ['dupes', 'Duplicates']];
      $o('tabs').innerHTML = t.map(([k, l]) => `<button class="chip ${this.tab === k ? 'on' : ''}" data-o="tab" data-t="${k}">${l}</button>`).join('');
    };
    const row = (e, opts = {}) => `<div class="check ${this.sel.has(e.pid) ? 'on' : ''} ${opts.keep ? 'have' : ''}">
        ${opts.keep ? `<span class="box-btn"><span class="box" style="border-style:dashed"></span></span>` : `<button class="box-btn" data-o="tick" data-p="${esc(e.pid)}" aria-label="Select ${esc(e.t)}"><span class="box">${ICON.check}</span></button>`}
        <button class="main tapcard" ${e.gone ? 'disabled' : Cards.attrs('song', { artist: e.a, title: e.t, v: e.v })}><span class="n">${esc(e.t)}</span>
        <span class="c">${esc([e.a, e.album, e.year || ''].filter(Boolean).join(' · '))}${opts.why ? ' · <b style="color:var(--accent)">' + esc(opts.why) + '</b>' : ''}${opts.keep ? ' · keeps this one' : ''}</span></button></div>`;
    const action = (label, k, n, note) => `<div class="org-actions">${note ? `<p class="muted small" style="margin:0 0 8px">${note}</p>` : ''}<button class="btn primary wide" data-o="${k}" ${n ? '' : 'disabled'}>${label}</button></div>`;
    const units = (n, per) => { const u = n * per, d = Math.ceil(u / (YT_DAILY_UNITS * 0.95)); return `About ${u.toLocaleString()} YouTube units${d > 1 ? ` — about <b>${d} days</b> of the free daily limit; it carries on by itself each day` : ', which fits in today\'s limit'}.`; };

    const body = () => {
      const all = items();
      const b = $o('body');
      if (!all.length) { b.innerHTML = '<p class="muted pad" data-o="status">Reading the playlist…</p>'; return; }
      if (this.tab === 'sort') {
        const key = this.sortKey || Organize.sortedPlaylists()[id] || 'artist';
        this.sortKey = key;
        const p = this.preview && this.preview.key === key ? this.preview : null;
        b.innerHTML = `<div class="list-h">Sort by</div>
          <div class="list">${Object.entries(SORTS).map(([k, l]) => `<button class="li" data-o="key" data-k="${k}"><span>${l}</span><span class="box-btn"><span class="radio ${k === key ? 'on' : ''}"></span></span></button>`).join('')}</div>
          <div class="list" style="margin-top:12px"><label class="li"><span>Keep it sorted<div class="sub">Songs Mixtape adds later go straight into their spot, not to the bottom.</div></span>
            <span class="switch"><input type="checkbox" data-o="keep" ${Organize.sortedPlaylists()[id] === key ? 'checked' : ''}><span></span></span></label></div>
          <p class="muted small pad" data-o="status" style="margin-top:10px">${Organize.needsAlbum(key) ? 'Albums, years and track numbers come from YouTube, Apple and MusicBrainz. The first time can take a few minutes for a big playlist; after that they\'re remembered.' : ''}</p>
          ${p ? `<p class="pad" style="margin:6px 0 0">${p.moves.length ? `<b>${p.moves.length}</b> of ${all.length} songs move.` : 'Already in this order.'}</p>
              <div class="my-list" style="margin-top:8px">${p.order.slice(0, 60).map((e, i) => `<div class="mx-row"><span class="grip" style="cursor:default">${i + 1}</span><span class="mx-main"><span class="tx"><span class="n">${esc(e.t)}</span><span class="c">${esc([e.a, e.album, e.year || ''].filter(Boolean).join(' · '))}</span></span></span></div>`).join('')}</div>
              ${p.order.length > 60 ? `<p class="muted small pad">…and ${p.order.length - 60} more.</p>` : ''}
              ${action('Save this order to YouTube Music', 'dosort', p.moves.length, p.moves.length ? units(p.moves.length, 50) + ' Only the songs that need to move are moved.' : '')}`
            : action('Show the new order', 'preview', 1, '')}`;
        return;
      }
      if (this.tab === 'find') {
        const artists = new Map();
        all.forEach((e) => { if (e.gone) return; const a = MyArtists.cleanName(e.a); artists.set(norm(a), { name: a, n: ((artists.get(norm(a)) || {}).n || 0) + 1 }); });
        const albums = this.artist ? [...new Set(all.filter((e) => norm(MyArtists.cleanName(e.a)) === this.artist && e.album).map((e) => e.album))] : [];
        const gone = all.filter((e) => e.gone).length;
        b.innerHTML = `<div class="pad" style="display:flex; flex-direction:column; gap:8px">
            <input class="search" data-o="q" value="${esc(this.q)}" placeholder="Find a song in this playlist" autocomplete="off" autocapitalize="off" spellcheck="false">
            <div class="row" style="gap:8px"><select class="field" data-o="artist" style="flex:1"><option value="">All artists</option>${[...artists.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, a]) => `<option value="${esc(k)}" ${k === this.artist ? 'selected' : ''}>${esc(a.name)} (${a.n})</option>`).join('')}</select>
              ${albums.length ? `<select class="field" data-o="album" style="flex:1"><option value="">All albums</option>${albums.sort().map((x) => `<option ${x === this.album ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}</div>
            ${gone ? `<button class="chip ${this.goneOnly ? 'on' : ''}" data-o="gone" style="align-self:flex-start">Unavailable videos (${gone})</button>` : ''}
            <div class="row" style="gap:16px"><button class="link-btn" data-o="all">Select all shown</button><button class="link-btn" data-o="none">Select none</button></div></div>
          <div data-o="flist"></div>`;
        fillFind();
        return;
      }
      if (this.tab === 'wrong') {
        const list = all.map((e) => ({ e, why: Organize.flags(e) })).filter((x) => x.why.length);
        b.innerHTML = `<p class="muted small pad" style="margin-top:4px">Live, demo, remix, cover and music-video versions, and uploads by someone other than the artist. <b>Swap</b> puts the album version in the same spot and takes this one out. Some may be on purpose; tick only the ones to swap.</p>
          ${list.length ? `<div class="pad row" style="gap:16px"><button class="link-btn" data-o="all">Select all</button><button class="link-btn" data-o="none">Select none</button></div>
            <div class="batch-list pad">${list.slice(0, 400).map((x) => row(x.e, { why: x.why.join(', ') })).join('')}</div>` : '<p class="pad">Nothing looks wrong. Every song is a regular album version.</p>'}
          ${list.length ? action(`Swap ${this.sel.size} for album versions`, 'swap', this.sel.size, this.sel.size ? `Each swap needs a song lookup (${DAILY_LOOKUPS} a day) and two playlist changes. ` + units(this.sel.size, 200) : '') : ''}`;
        this.shown = list.map((x) => x.e);
        return;
      }
      if (this.tab === 'dupes') {
        const groups = Organize.duplicates(all);
        if (this.dupesFresh !== groups.length) { this.dupesFresh = groups.length; this.sel = new Set(groups.flatMap((g) => g.extra.map((e) => e.pid))); }
        const n = groups.reduce((s, g) => s + g.extra.length, 0);
        b.innerHTML = groups.length ? `<p class="muted small pad" style="margin-top:4px">${groups.length} song${groups.length === 1 ? ' is' : 's are'} in here more than once. The album version (or the first copy) stays; the extra copies are ticked.</p>
            <div class="batch-list pad">${groups.slice(0, 200).map((g) => `<div style="border-bottom:1px solid var(--surface2); padding-bottom:4px">${row(g.keep, { keep: true })}${g.extra.map((e) => row(e, { why: e.v === g.keep.v ? 'same video' : (e.topic ? 'album version' : 'another version') })).join('')}</div>`).join('')}</div>
            ${action(`Remove ${this.sel.size} extra cop${this.sel.size === 1 ? 'y' : 'ies'}`, 'remove', this.sel.size, this.sel.size ? units(this.sel.size, 50) : '')}`
          : '<p class="pad">No duplicates. Every song is in here once.</p>';
        this.shown = groups.flatMap((g) => g.extra);
        return;
      }
    };
    // The Find list redraws on its own, so typing in the search box isn't interrupted
    const fillFind = () => {
      const box = el.querySelector('[data-o=flist]');
      if (!box) return;
      const list = items().filter((e) => (this.goneOnly ? e.gone : true)
        && (!this.artist || norm(MyArtists.cleanName(e.a)) === this.artist) && (!this.album || e.album === this.album)
        && (!this.q || fuzzyScore(this.q, e.t + ' ' + e.a + ' ' + e.album) > 0));
      this.shown = list;
      box.innerHTML = `<div class="batch-list pad">${list.slice(0, 400).map((e) => row(e)).join('') || '<p class="muted">No matches.</p>'}${list.length > 400 ? `<p class="muted small">Showing 400 of ${list.length}. Search or pick an artist to narrow it.</p>` : ''}</div>
        ${action(`Remove ${this.sel.size} from the playlist`, 'remove', this.sel.size, this.sel.size ? units(this.sel.size, 50) : '')}`;
    };
    const refresh = () => (this.tab === 'find' ? fillFind() : body());
    const draw = () => { drawJob(); head(); tabs(); body(); };
    this.draw = draw;

    const load = async (force) => {
      if (!force && Organize.cache && Organize.cache.id === id && !Organize.cache.stale) { draw(); return; }
      Organize.cache = { id, name, items: [] };
      this.preview = null; this.sel = new Set(); this.dupesFresh = null;
      draw();
      try {
        const list = await Organize.read(id, (n, total) => { const s = el.querySelector('[data-o=status]'); if (s) s.textContent = `Reading the playlist… ${n}${total ? ' of ' + total : ''} songs`; });
        if (name === 'Playlist') name = await YTData.playlistName(id).catch(() => name);
        Organize.cache = { id, name, items: list, at: Date.now() };
        if (currentView === Views.organize && this.el === el) draw();
      } catch (e) { const s = el.querySelector('[data-o=status]'); if (s) s.textContent = e.message || String(e); Errors.show(e.message || String(e), e instanceof ApiError ? '' : e); }
    };
    this.load = load;

    el.addEventListener('input', (e) => {
      if (e.target.dataset.o !== 'q') return;
      this.q = e.target.value;
      clearTimeout(this.qTimer);
      this.qTimer = setTimeout(fillFind, 250);
    });
    el.addEventListener('change', (e) => {
      const k = e.target.dataset.o;
      if (k === 'artist') { this.artist = e.target.value; this.album = ''; body(); }
      if (k === 'album') { this.album = e.target.value; body(); }
      if (k === 'keep') { Organize.keepSorted(id, e.target.checked ? this.sortKey : ''); head(); toast(e.target.checked ? 'Kept sorted from now on' : 'No longer kept sorted'); }
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-o]');
      if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
      const k = b.dataset.o;
      try {
        if (k === 'back') go('#builder');
        if (k === 'help') showHelp('organize');
        if (k === 'refresh') load(true);
        if (k === 'ytm') window.open(Builder.ytmUrl(id), '_blank');
        if (k === 'play') Music.play(items().filter((x) => !x.gone), 0, { name, playlist: id });
        if (k === 'tab') { this.tab = b.dataset.t; this.sel = new Set(); this.dupesFresh = null; tabs(); body(); }
        if (k === 'tick') { const p = b.dataset.p; if (this.sel.has(p)) this.sel.delete(p); else this.sel.add(p); refresh(); }
        if (k === 'all') { (this.shown || []).forEach((x) => this.sel.add(x.pid)); refresh(); }
        if (k === 'none') { this.sel = new Set(); refresh(); }
        if (k === 'gone') { this.goneOnly = !this.goneOnly; body(); }
        if (k === 'key') {
          this.sortKey = b.dataset.k; this.preview = null;
          if (Organize.sortedPlaylists()[id] && Organize.sortedPlaylists()[id] !== this.sortKey) Organize.keepSorted(id, '');
          body(); head();
        }
        if (k === 'preview') {
          b.disabled = true;
          const st = el.querySelector('[data-o=status]');
          const all = items(), key = this.sortKey;
          await Organize.enrich(all, key, (msg) => { if (st) st.textContent = msg + '…'; });
          const order = Organize.sorted(all, key);
          this.preview = { key, order, moves: Organize.moves(all, order) };
          body();
        }
        if (k === 'dosort') {
          const p = this.preview;
          if (Job.begin({ kind: 'sort', key: p.key, name, playlistId: id, total: null })) { drawJob(); window.scrollTo(0, 0); }
        }
        if (k === 'remove') {
          const pids = items().filter((x) => this.sel.has(x.pid)).map((x) => x.pid);
          if (!pids.length || !confirm(`Remove ${pids.length} song${pids.length === 1 ? '' : 's'} from "${name}" in YouTube Music?`)) return;
          if (Job.begin({ kind: 'remove', name, playlistId: id, pids })) { this.sel = new Set(); drawJob(); window.scrollTo(0, 0); }
        }
        if (k === 'swap') {
          const swaps = items().filter((x) => this.sel.has(x.pid)).map((x) => ({ pid: x.pid, v: x.v, a: MyArtists.cleanName(x.a), t: baseTitle(x.t) }));
          if (!swaps.length) return;
          if (Job.begin({ kind: 'swap', name, playlistId: id, swaps, missing: [] })) { this.sel = new Set(); drawJob(); window.scrollTo(0, 0); }
        }
      } catch (err) { b.disabled = false; Errors.show(err.message || String(err), err instanceof ApiError ? '' : err); }
    });
    load(false);
    firstVisit('organize');
    if (Job.get() && !Job.busy) Job.run(false);
  },
};
// While a job runs on this playlist, move its bar; when it finishes, read the playlist again
document.addEventListener('mixjob', () => {
  if (currentView !== Views.organize || !Views.organize.drawJob) return;
  const j = Job.get();
  const live = Views.organize.el && Views.organize.el.querySelector('[data-o=job] [data-j=bar]');
  if (j && j.state === 'running' && live) { live.outerHTML = jobBar(j); return; }
  Views.organize.drawJob();
  if (j && j.state === 'done' && Organize.cache && Organize.cache.stale && Organize.cache.id === j.playlistId && Views.organize.load) Views.organize.load(true);
});

HELP.organize = {
  title: 'Organize a playlist',
  html: `<p>Tidy up one of your YouTube Music playlists. Changes go straight into YouTube Music.</p>
    <ul><li><b>Sort</b>: pick an order and tap <b>Show the new order</b> to see it first. <b>Save this order</b> moves only the songs that need to move. <b>Keep it sorted</b> puts songs Mixtape adds later straight into their spot.</li>
    <li><b>Find &amp; remove</b>: search the playlist (close matches), or pick an artist and album to jump to them. Tick songs and tap <b>Remove</b>. <b>Unavailable videos</b> lists deleted or private ones.</li>
    <li><b>Wrong versions</b>: live, demo, remix, cover and music-video versions, and uploads by someone other than the artist. <b>Swap</b> puts the album version in the same spot.</li>
    <li><b>Duplicates</b>: songs that are in more than once. The extra copies are ticked for removal.</li></ul>
    <p>Each move, removal or addition costs 50 of YouTube's 10,000 free daily units, so sorting a big playlist runs over several days. Keep Mixtape open while it works; it carries on by itself the next time it's open.</p>`,
};

/* ---------------- Import a playlist file (Settings → More) ---------------- */
const PlaylistImport = {
  // "Beatles, The" → "The Beatles"
  artist(a) { a = String(a || '').replace(/_/g, ' ').trim(); const m = a.match(/^(.*),\s*(the|a|an)$/i); return m ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()} ${m[1]}` : a; },
  // A file name → song title: no extension, track numbers or a repeated artist name
  title(file, artist) {
    let t = String(file || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').trim();
    t = t.replace(/^(\d{1,2}[-.]\s?)?\d{1,3}\s*[-–.)]?\s+/, '');                       // "01 - ", "1-01 ", "03. "
    if (artist) { const parts = t.split(/\s[-–]\s/); if (parts.length > 1 && sim(parts[0], artist) >= 0.8) t = parts.slice(1).join(' - '); }
    return t.trim();
  },
  fromPath(p) {
    let path = String(p || '').trim();
    try { if (/%[0-9a-f]{2}/i.test(path)) path = decodeURIComponent(path); } catch (e) { /* keep as is */ }
    const parts = path.replace(/^file:\/+/i, '/').split(/[\\/]/).filter(Boolean);
    const file = parts.pop() || '', album = parts.pop() || '', art = parts.pop() || '';
    const a = this.artist(art && !/^(music|volume\d*|share|homes?|[a-z]:)$/i.test(art) ? art : '');
    return { a, t: this.title(file, a), album };
  },
  fromLine(line) {
    const m = String(line).match(/^(.+?)\s[-–—]\s(.+)$/);
    return m ? { a: this.artist(m[1]), t: m[2].trim() } : { a: '', t: String(line).trim() };
  },
  csvRow(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',' || c === '\t' || c === ';') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  },
  parse(text, fileName = '') {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    const songs = [];
    if (/^m3u8?$/i.test(ext) || lines[0] === '#EXTM3U' || lines.some((l) => /^#EXTINF/i.test(l))) {
      let info = null;
      lines.forEach((l) => {
        if (/^#EXTINF/i.test(l)) { info = l.replace(/^#EXTINF:[^,]*,/i, ''); return; }
        if (l.startsWith('#')) return;
        const fromPath = this.fromPath(l);
        const fromInfo = info ? this.fromLine(info) : null;
        songs.push(fromInfo && fromInfo.a ? Object.assign(fromInfo, { album: fromPath.album }) : fromPath);
        info = null;
      });
    } else if (/^pls$/i.test(ext) || /^\[playlist\]$/i.test(lines[0])) {
      const files = {}, titles = {};
      lines.forEach((l) => { let m = l.match(/^File(\d+)=(.*)$/i); if (m) files[m[1]] = m[2]; m = l.match(/^Title(\d+)=(.*)$/i); if (m) titles[m[1]] = m[2]; });
      Object.keys(files).sort((a, b) => a - b).forEach((n) => { const t = titles[n] && this.fromLine(titles[n]); songs.push(t && t.a ? t : this.fromPath(files[n])); });
    } else if (/^wpl$/i.test(ext) || /<smil/i.test(text)) {
      const ent = (s) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      (text.match(/<media[^>]+src="([^"]+)"/gi) || []).forEach((m) => songs.push(this.fromPath(ent(m.match(/src="([^"]+)"/i)[1]))));
    } else {
      // text or CSV: "Artist - Title" per line, or columns with an Artist and a Title header
      const head = this.csvRow(lines[0]).map((h) => h.toLowerCase());
      const ai = head.findIndex((h) => /^(artist|artist name|artists?\(s\)|band)$/.test(h)), ti = head.findIndex((h) => /^(title|song|track|track name|name|song name)$/.test(h));
      if (ai >= 0 && ti >= 0) lines.slice(1).forEach((l) => { const r = this.csvRow(l); songs.push({ a: this.artist(r[ai] || ''), t: (r[ti] || '').trim() }); });
      else lines.forEach((l) => {
        const r = /[,\t]/.test(l) && !/\s[-–—]\s/.test(l) ? this.csvRow(l) : null;
        songs.push(r && r.length >= 2 ? { a: this.artist(r[0]), t: r[1] } : this.fromLine(l.replace(/^\d+[.)]\s*/, '')));
      });
    }
    const seen = new Set();
    return songs.filter((s) => s.t).map((s) => {
      s.ok = !!(s.a && s.t && s.t.length < 120 && !/\.(mp3|m4a|flac|wav|aac|ogg)$/i.test(s.t) && !/^(unknown|various)( artists?)?$/i.test(s.a) && !/^track \d+$/i.test(s.t));
      return s;
    }).filter((s) => { const k = songKey(s.a, s.t); if (seen.has(k)) return false; seen.add(k); return true; });
  },
};
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('windows-1252').decode(buf); } catch (e) { /* keep utf-8 */ } }
  return text;
}
function openImport() {
  let songs = [], name = '';
  Sheets.open({
    title: 'Import a playlist file',
    html: `<p class="muted small" style="margin-top:0">M3U / M3U8 (Audio Station and most music apps), PLS, WPL, or a text or CSV file with one “Artist - Title” per line. You can also paste a list.</p>
      <label class="btn wide" style="position:relative; overflow:hidden">Choose a file<input type="file" data-i="file" accept=".m3u,.m3u8,.pls,.wpl,.txt,.csv,.tsv,audio/x-mpegurl,audio/mpegurl,text/plain,text/csv" style="position:absolute; inset:0; opacity:0"></label>
      <details class="add-pl"><summary>Paste a list instead</summary>
        <textarea class="field" data-i="paste" rows="6" placeholder="Tom Petty - Free Fallin'&#10;Oasis - Live Forever" style="width:100%; height:auto; padding:10px"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn small primary" data-i="read">Read the list</button></div></details>
      <div data-i="review"></div>`,
    onMount(body, close) {
      const $i = (k) => body.querySelector(`[data-i=${k}]`);
      const review = () => {
        const bad = songs.map((s, i) => [s, i]).filter(([s]) => !s.ok && !s.skip);
        const keep = songs.filter((s) => !s.skip);
        $i('review').innerHTML = `<h3>Review</h3>
          <label class="flabel">Name<input class="field" data-i="name" value="${esc(name)}" autocomplete="off"></label>
          <p class="small">${keep.length} song${keep.length === 1 ? '' : 's'}${bad.length ? ` · <b style="color:var(--accent)">${bad.length} didn't read cleanly</b>: fix the artist and title, or skip them.` : ' · all read cleanly.'}</p>
          ${bad.length ? `<div class="rows">${bad.slice(0, 100).map(([s, i]) => `<div class="fixrow"><div class="row" style="gap:6px"><input class="field slim" data-i="a" data-n="${i}" value="${esc(s.a)}" placeholder="Artist" autocomplete="off"><input class="field slim" data-i="t" data-n="${i}" value="${esc(s.t)}" placeholder="Title" autocomplete="off"></div>
              <span class="row" style="gap:14px"><button class="link-btn" data-i="ok" data-n="${i}">Looks right</button><button class="link-btn" data-i="skip" data-n="${i}">Skip</button></span></div>`).join('')}</div>
            ${bad.length > 100 ? `<p class="muted small">…and ${bad.length - 100} more. <button class="link-btn" data-i="skipall">Skip all of these</button></p>` : `<button class="link-btn" data-i="skipall">Skip all of these</button>`}` : ''}
          <details class="add-pl"><summary>All ${keep.length} songs</summary><div class="rows">${keep.slice(0, 300).map((s) => `<div class="rowbtn"><span>${esc(s.t)}<span class="muted small" style="display:block">${esc(s.a || '?')}</span></span></div>`).join('')}</div>${keep.length > 300 ? `<p class="muted small">…and ${keep.length - 300} more.</p>` : ''}</details>
          <h3>Use it for</h3>
          <div style="display:flex; flex-direction:column; gap:10px">
            <button class="btn primary" data-i="game">${ICON.play} The game</button>
            <button class="btn" data-i="mix">A Playlist Builder playlist</button>
            <button class="btn" data-i="artists">Adding its artists to My Artists</button>
          </div>
          <p class="muted small">Whichever you pick, it's also saved with your playlists, so the game, Playlist Builder and My Artists can use it later. In the game each song is looked up on YouTube when it comes up, so a big file plays right away.</p>`;
      };
      const load = (text, fname) => {
        songs = PlaylistImport.parse(text, fname);
        if (!songs.length) { $i('review').innerHTML = '<p class="small" style="color:var(--accent)">No songs found in that. Is it a playlist file?</p>'; return; }
        name = (fname || 'Pasted list').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
        review();
        $i('review').scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      // Saved like a YouTube playlist (but with no videos yet) so every section can pick it
      const save = () => {
        const list = songs.filter((s) => !s.skip && s.a && s.t).map((s) => ({ a: s.a, t: s.t }));
        if (!list.length) { toast('No songs left to import'); return null; }
        const id = 'file:' + Date.now().toString(36);
        Store.set('pool.' + id, list);
        const pools = Store.get('pools', []);
        pools.push({ id, name: name || 'Imported playlist', count: list.length, updated: new Date().toISOString(), file: true });
        Store.set('pools', pools);
        SongFinder.forget();
        return { id, list };
      };
      $i('file').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try { load(await readTextFile(f), f.name); } catch (err) { Errors.show('Could not read that file: ' + (err.message || err), err); }
      });
      body.addEventListener('input', (e) => {
        const t = e.target, n = t.dataset.n != null ? +t.dataset.n : -1;
        if (t.dataset.i === 'name') name = t.value;
        if (t.dataset.i === 'a' && songs[n]) songs[n].a = t.value.trim();
        if (t.dataset.i === 't' && songs[n]) songs[n].t = t.value.trim();
      });
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (!b || b.tagName === 'INPUT' || b.tagName === 'TEXTAREA' || b.tagName === 'LABEL') return;
        const k = b.dataset.i, n = b.dataset.n != null ? +b.dataset.n : -1;
        if (k === 'read') load($i('paste').value, '');
        if (k === 'ok' && songs[n]) { if (songs[n].a && songs[n].t) songs[n].ok = true; else { toast('Fill in both the artist and the title'); return; } review(); }
        if (k === 'skip' && songs[n]) { songs[n].skip = true; review(); }
        if (k === 'skipall') { songs.forEach((s) => { if (!s.ok) s.skip = true; }); review(); }
        if (k === 'game') {
          const r = save(); if (!r) return;
          Pool.set(Object.assign(Pool.defaults(), { playlists: [r.id], hits: Pool.get().hits }));
          if (typeof Game !== 'undefined') { Game.round = null; Game.mode = 'guess'; }
          close(); toast(`Game pool: ${name}`); go('#game');
        }
        if (k === 'mix') {
          const r = save(); if (!r) return;
          const m = Builder.create(name);
          Builder.addTo(m, r.list);
          close(); go('#builder?mix=' + m.id);
        }
        if (k === 'artists') {
          const r = save(); if (!r) return;
          close();
          setTimeout(() => openBatchAdd(null, { name, items: r.list }), 330);
        }
      });
    },
  });
}
