'use strict';
/* Guess the Intro + DJ Mode + the song pool (filters). Needs app.js and info.js loaded first. */

/* ================= The YouTube players ================= */
// Two hidden players take turns: one plays the round, the other quietly loads the next song
// (and sits through its ad, muted) so Next song starts right away.
const PlayerLog = {
  list: null,
  add(line) {
    if (!this.list) this.list = Store.get('playerlog', []);
    this.list.push(line);
    if (this.list.length > 250) this.list.splice(0, this.list.length - 250);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => Store.set('playerlog', this.list, true), 800);
  },
  clear() { this.list = []; Store.set('playerlog', []); },
};
const YTQueue = [];
class YTPlayer {
  constructor(n) {
    this.n = n;
    this.wrapId = n === 1 ? 'yt-wrap' : 'yt-wrap' + n;
    this.elId = n === 1 ? 'yt-player' : 'yt-player' + n;
    this.builds = 0;
    this.yt = null; this.loading = null; this.state = -1;
    this.listeners = new Set(); this.errorListeners = new Set();
  }
  wrap() {
    let w = document.getElementById(this.wrapId);
    if (!w) {
      w = document.createElement('div');
      w.id = this.wrapId;
      w.className = 'yt-wrap';
      w.innerHTML = '<div class="yt-unlock-text">Tap the video once to turn on sound.<br>You only need to do this once.</div>';
      document.body.appendChild(w);
    }
    return w;
  }
  load() {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      let waited = 0, retried = false, done = false;
      const finish = (err) => { if (done) return; done = true; clearInterval(watch); if (err) reject(err); else resolve(); };
      // Only count seconds while Mixtape is on screen, and quietly rebuild the player once before giving up.
      const watch = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        waited += 1;
        if (waited === 12 && !retried && window.YT && window.YT.Player) { retried = true; this.teardown(); create(); }
        if (waited >= 30) finish(new Error('The YouTube player took too long to load. Check the connection, then tap Play clip or pick again.'));
      }, 1000);
      const create = () => {
        const w = this.wrap();
        // A fresh element (and id) for every build: reusing a torn-down player's id can leave the new one
        // never reporting ready after the phone comes back from the lock screen.
        w.querySelectorAll('iframe, div:not(.yt-unlock-text)').forEach((x) => x.remove());
        this.elId = 'yt-p' + this.n + '-' + (++this.builds);
        const d = document.createElement('div');
        d.id = this.elId;
        w.appendChild(d);
        this.log('build ' + this.builds);
        this.yt = new YT.Player(this.elId, {
          width: 300,
          height: 170,
          playerVars: { playsinline: 1, controls: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => { this.log('player ready'); finish(); },
            onStateChange: (e) => {
              this.state = e.data;
              this.log('state');
              if (e.data === 1 && this.wrap().classList.contains('unlock') && !this.adPlaying()) this.finishUnlock();
              this.listeners.forEach((fn) => fn(e.data));
            },
            onError: (e) => this.errorListeners.forEach((fn) => fn(e.data)),
          },
        });
      };
      if (window.YT && window.YT.Player) { create(); return; }
      YTQueue.push(create);
      if (!window.__ytScript) {
        window.__ytScript = true;
        window.onYouTubeIframeAPIReady = () => YTQueue.splice(0).forEach((f) => f());
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { window.__ytScript = false; finish(new Error('Could not load the YouTube player. Check the connection.')); };
        document.head.appendChild(s);
      }
    });
    this.loading.catch(() => { this.loading = null; this.teardown(); });
    return this.loading;
  }
  waitFor(states, ms) {
    return new Promise((resolve) => {
      if (states.includes(this.state)) { resolve(true); return; }
      const off = this.on((s) => { if (states.includes(s)) { off(); clearTimeout(t); resolve(true); } });
      const t = setTimeout(() => { off(); resolve(false); }, ms);
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onError(fn) { this.errorListeners.add(fn); return () => this.errorListeners.delete(fn); }
  log(ev) {
    const d = new Date();
    const vd = this.videoData();
    PlayerLog.add([`${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${Math.floor(d.getMilliseconds() / 100)}`,
      'P' + this.n, ev, 'st' + this.state, 't' + this.time().toFixed(2), 'd' + Math.round(this.duration()), vd.id || '-', this.muted() ? 'muted' : 'sound', (vd.title || '').slice(0, 24)].join(' '));
  }
  // Log what the player says for a few seconds after something starts it
  sample(label) {
    clearInterval(this.sampler);
    let n = 0;
    this.log(label);
    this.sampler = setInterval(() => { this.log('·'); if (++n >= 12) clearInterval(this.sampler); }, 400);
  }
  videoData() { try { const v = (this.yt && this.yt.getVideoData && this.yt.getVideoData()) || {}; return { id: v.video_id || '', title: v.title || '' }; } catch (e) { return {}; } }
  muted() { try { return !!(this.yt && this.yt.isMuted && this.yt.isMuted()); } catch (e) { return false; } }
  time() { try { return (this.yt && this.yt.getCurrentTime && this.yt.getCurrentTime()) || 0; } catch (e) { return 0; } }
  duration() { try { return (this.yt && this.yt.getDuration && this.yt.getDuration()) || 0; } catch (e) { return 0; } }
  // On iPhone an ad shows up as "not started" (state -1) while the clock runs. Also: a different length or video.
  adPlaying(v, dur) {
    if (!this.yt) return false;
    const t = this.time();
    if (this.state === -1 && t > 0.05) return true;
    const d = this.duration(), id = this.videoData().id;
    if (dur && d && Math.abs(d - dur) > 3) return true;
    if (v && id && id !== v) return true;
    return false;
  }
  mute() { try { this.yt.mute(); } catch (e) { /* ignore */ } }
  showUnlock() { this.wrap().classList.add('unlock'); }
  hideUnlock() { const w = document.getElementById(this.wrapId); if (w) w.classList.remove('unlock'); }
  finishUnlock() {
    this.hideUnlock();
    try { this.yt.pauseVideo(); } catch (e) { /* ignore */ }
    Game.unlocked = true;
    toast('Sound is on. Tap Play clip.');
  }
  stop() { try { if (this.yt) { this.yt.mute(); this.yt.pauseVideo(); } } catch (e) { /* ignore */ } }
  // Throw the player away, so the lock screen and Now Playing have nothing to show.
  reset() { this.teardown(); this.loading = null; }
  teardown() {
    if (this.yt) this.log('teardown');
    try { if (this.yt) { this.yt.stopVideo(); this.yt.destroy(); } } catch (e) { /* ignore */ }
    const w = document.getElementById(this.wrapId);
    if (w) w.querySelectorAll('iframe, div:not(.yt-unlock-text)').forEach((x) => x.remove());
    this.yt = null;
    this.state = -1;
  }
}
const P1 = new YTPlayer(1), P2 = new YTPlayer(2);
let Player = P1;   // the one playing the current round

/* ================= Song pool: playlists + filters ================= */
const BANDS = ['Big hits', 'Well known', 'Album tracks', 'Deep cuts', 'Rarities'];
// Where a song sits in its artist's catalog (Last.fm listeners, most first). Big hits = the top 3, but only
// songs within a quarter of the top song's listeners, so a one-hit wonder has just the one.
function bandOf(top, i) {
  if (i < 0 || i >= top.length) return 4;
  const lead = (top[0] && top[0].n) || 0;
  if (i < 3 && (!lead || (top[i].n || 0) >= lead * 0.25)) return 0;
  return i < 15 ? 1 : i < 60 ? 2 : i < 200 ? 3 : 4;
}
// For genres, decades or nothing picked: skip artists whose biggest song has fewer Last.fm listeners than this
function popFloor(f) { const hi = f.hits ? f.hits[1] : 1; return hi <= 1 ? 500000 : hi === 2 ? 150000 : 0; }
const GENRES = ['rock', 'pop', 'hip-hop', 'alternative', 'indie', 'classic rock', 'metal', 'punk', 'pop punk', 'emo', 'grunge',
  'new wave', 'r&b', 'soul', 'funk', 'disco', 'dance', 'electronic', 'country', 'folk', 'singer-songwriter', 'blues', 'jazz', 'reggae'];
const DEC = { '50s': { tag: '50s', from: 1950 }, '60s': { tag: '60s', from: 1960 }, '70s': { tag: '70s', from: 1970 }, '80s': { tag: '80s', from: 1980 },
  '90s': { tag: '90s', from: 1990 }, '00s': { tag: '00s', from: 2000 }, '10s': { tag: '2010s', from: 2010 }, '20s': { tag: '2020s', from: 2020 } };

const Pool = {
  gen: 0, list: null, arts: null, building: null, ahead: null, seen: new Set(), restarted: -1,
  defaults: () => ({ playlists: [], artists: [], genres: [], decades: [], hits: null }),
  get() {
    let f = Store.get('filters', null);
    if (!f) {
      f = this.defaults();
      const cur = Store.get('currentPool', '');   // v1 single pool
      if (cur) f.playlists = [cur];
      Store.set('filters', f, true);
    }
    f = Object.assign(this.defaults(), f);
    const ids = new Set(Store.get('pools', []).map((p) => p.id));
    f.playlists = f.playlists.filter((id) => ids.has(id));
    return f;
  },
  set(f) { Store.set('filters', f); this.reset(); },
  reset() { this.gen++; this.list = null; this.arts = null; this.building = null; this.ahead = null; },
  hitsText(h) { return !h ? 'Any' : h[0] === h[1] ? BANDS[h[0]] : `${BANDS[h[0]]} – ${BANDS[h[1]]}`; },
  label(f = this.get()) {
    const parts = [];
    const names = Store.get('pools', []).filter((p) => f.playlists.includes(p.id)).map((p) => p.name);
    if (names.length) parts.push(names.join(' + '));
    if (f.artists.length) parts.push(f.artists.map((a) => a.name).join(' + '));
    if (f.decades.length) parts.push(f.decades.join(' + '));
    if (f.genres.length && !f.artists.length) parts.push(f.genres.join(' + '));
    if (f.hits) parts.push(this.hitsText(f.hits).toLowerCase());
    return parts.join(' · ') || 'Popular songs';
  },
  mode(f) {
    if (f.playlists.length) return 'P';        // saved playlists, filtered
    if (f.artists.length) return 'A';          // picked artists (and albums)
    return 'B';                                // well-known artists of the genres / decades / charts, then their songs
  },
  async build(f, mode, status) {
    if (mode === 'P') {
      const map = new Map();
      f.playlists.forEach((id) => Store.get('pool.' + id, []).forEach((it) => { if (!map.has(it.v)) map.set(it.v, Object.assign({ src: 'playlist' }, it)); }));
      this.list = shuffle([...map.values()]);
      return;
    }
    if (mode === 'A') { this.arts = f.artists.map((a) => ({ a, tracks: null })); return; }
    const hard = (e) => { if (e instanceof ApiError && /key|busy|reach/i.test(e.message)) throw e; return []; };
    status('Gathering artists…');
    // Ranked lists, most popular first; "90s rock" style tags first when both a genre and a decade are picked
    const lists = [];
    const tagged = async (tag, src) => (await LastFM.tagTopArtists(tag).catch(hard)).slice(0, 150).map((n) => ({ n, src }));
    if (f.genres.length && f.decades.length) {
      for (const d of f.decades) for (const g of f.genres) lists.push(await tagged(`${d} ${g}`, 'decade'));
      for (const g of f.genres) lists.push(await tagged(g, 'genre'));
    } else if (f.genres.length) {
      for (const g of f.genres) lists.push(await tagged(g, 'genre'));
    } else if (f.decades.length) {
      for (const d of f.decades) lists.push(await tagged(DEC[d].tag, 'decade'));
    } else {
      lists.push((await LastFM.chartTopArtists()).map((n) => ({ n, src: 'chart' })));
    }
    // Interleave the lists by rank so every tag gets its best artists near the front
    const seen = new Set(), out = [];
    for (let i = 0; i < 200; i++) lists.forEach((l) => { const x = l[i]; if (x && !seen.has(norm(x.n))) { seen.add(norm(x.n)); out.push(x); } });
    this.arts = out.map((x) => ({ a: { name: x.n }, src: x.src, tracks: null }));
  },
  async albumTitles(art) {
    if (art._titles) return art._titles;
    const sets = await Promise.all((art.albums || []).map((al) => MB.albumTracks(al.id, 1).catch(() => ({ tracks: [] }))));
    art._titles = new Set(sets.flatMap((s) => s.tracks.map((t) => norm(cleanTitle(t.t)))));
    return art._titles;
  },
  async artistTracks(e, f, mode) {
    if (e.tracks) return e.tracks;
    const a = e.a;
    const range = f.hits || (mode === 'A' ? [0, 2] : [0, 1]);
    let list;
    if (mode === 'A' && a.albums && a.albums.length) {
      const sets = await Promise.all(a.albums.map((al) => MB.albumTracks(al.id, 1).catch(() => ({ tracks: [] }))));
      const seen = new Set();
      list = sets.flatMap((s) => s.tracks).map((t) => cleanTitle(t.t))
        .filter((t) => { const k = norm(t); if (!k || seen.has(k) || NOT_STUDIO.test(t)) return false; seen.add(k); return true; })
        .map((t) => ({ a: a.name, t, src: 'artist' }));
      if (f.hits) {
        const top = await LastFM.topTracks(a.name).catch(() => []);
        const rank = new Map(top.map((x, i) => [norm(x.t), i]));
        const inBand = list.filter((x) => { const r = rank.has(norm(x.t)) ? bandOf(top, rank.get(norm(x.t))) : 4; return r >= range[0] && r <= range[1]; });
        if (inBand.length) list = inBand;
      }
    } else {
      const top = await LastFM.topTracks(a.name);
      if (mode === 'B' && popFloor(f) && !((top[0] && top[0].n) >= popFloor(f))) { e.tracks = []; return e.tracks; }   // not well known enough
      list = top.filter((x, i) => { const b = bandOf(top, i); return b >= range[0] && b <= range[1]; });
      if (!list.length && top.length && mode === 'A') list = range[0] >= 2 ? top.slice(Math.floor(top.length / 2)) : top.slice(0, 3);
      list = list.map((x) => ({ a: x.a, t: x.t, src: e.src || 'artist' }));
    }
    e.tracks = shuffle(list);
    return e.tracks;
  },
  async candidate(f, mode) {
    if (mode === 'P') return this.list.length ? this.list.pop() : null;
    for (let tries = 0; tries < 25; tries++) {
      const live = this.arts.filter((e) => !e.done);
      if (!live.length) return null;
      // Picked artists: any of them. Otherwise lean toward the most popular artists in the list.
      const e = live[Math.floor((mode === 'A' ? Math.random() : Math.pow(Math.random(), 2)) * live.length)];
      let tracks;
      try { tracks = await this.artistTracks(e, f, mode); }
      catch (err) { if (err instanceof ApiError && /key|busy|reach/i.test(err.message)) throw err; e.done = true; continue; }
      const c = tracks.pop();
      if (!tracks.length) e.done = true;
      if (c) return c;
    }
    return null;
  },
  async check(c, f, mode, status) {
    const blocked = new Set(Store.get('blocked', []));
    if (this.seen.has(songKey(c.a, c.t)) || (c.v && (this.seen.has(c.v) || blocked.has(c.v)))) return null;
    if (mode === 'P') {
      if (f.artists.length) {
        const art = f.artists.find((a) => sim(a.name, c.a) >= 0.8);
        if (!art) return null;
        if (art.albums && art.albums.length && !(await this.albumTitles(art)).has(norm(cleanTitle(c.t)))) return null;
      } else if (f.genres.length) {
        const tags = await LastFM.artistTags(c.a).catch(() => []);
        if (!f.genres.some((g) => tags.some((t) => t === g || t.includes(g)))) return null;
      }
      if (f.hits) {
        const top = await LastFM.topTracks(c.a).catch(() => []);
        const i = top.findIndex((x) => norm(x.t) === norm(cleanTitle(c.t)));
        const b = bandOf(top, i);
        if (b < f.hits[0] || b > f.hits[1]) return null;
      }
    }
    if (f.decades.length) {
      let y = Year.known(c.a, c.t);
      if (y === undefined) {
        status(`Checking which songs are from the ${f.decades.join(' or ')}…`);
        y = await Year.get(c.a, c.t).catch(() => 0);
      }
      if (y) { if (!f.decades.some((d) => y >= DEC[d].from && y < DEC[d].from + 10)) return null; }
      else if (c.src !== 'decade') return null;
    }
    let v = c.v;
    if (!v) {
      v = await SongFinder.find(c.a, c.t);
      if (!v && SongFinder.looked) this.misses = (this.misses || 0) + 1;
      if (!v || blocked.has(v)) return null;
    }
    return { v, a: c.a, t: c.t };
  },
  async next(status = () => {}) {
    const f = this.get(), mode = this.mode(f), gen = this.gen;
    if (mode !== 'P' && !LastFM.ready()) throw new ApiError('No Last.fm key yet. Open app.js on GitHub and paste your Last.fm key in the marked spot at the top. (Playlists work without it.)');
    if (!this.building) { this.building = this.build(f, mode, status); this.building.catch(() => { if (gen === this.gen) this.building = null; }); }
    await this.building;
    let tried = 0;
    this.misses = 0;
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.misses >= 5) throw new ApiError("Couldn't find the last few songs on YouTube, so Mixtape stopped to save your daily lookups. Try Next song, or change the pool.");
      const c = await this.candidate(f, mode);
      if (!c) {
        if (mode === 'P' && this.restarted !== gen && this.seen.size) {
          this.restarted = gen;
          this.seen.clear();
          await this.build(f, mode, status);
          toast("You've heard every song in this pool. Starting over.");
          continue;
        }
        return null;
      }
      tried++;
      if (tried > 200) return null;
      if (tried > 3 && tried % 4 === 0) status(`Finding a song that fits… (${tried} checked)`);
      const item = await this.check(c, f, mode, status);
      if (gen !== this.gen) return null;
      if (item) { this.seen.add(songKey(item.a, item.t)); this.seen.add(item.v); return item; }
    }
  },
  // A handful of songs from the pool to show the DJ (not yet checked against decades or YouTube)
  async sample(n = 30) {
    const f = this.get(), mode = this.mode(f), gen = this.gen;
    if (mode !== 'P' && !LastFM.ready()) throw new ApiError('No Last.fm key yet. Open app.js on GitHub and paste your Last.fm key in the marked spot at the top.');
    if (!this.building) { this.building = this.build(f, mode, () => {}); this.building.catch(() => { if (gen === this.gen) this.building = null; }); }
    await this.building;
    const fresh = (c) => !this.seen.has(songKey(c.a, c.t));
    if (mode === 'P') return shuffle(this.list.filter(fresh)).slice(0, n);
    const live = this.arts.filter((e) => !e.done);
    const arts = mode === 'A' ? shuffle(live).slice(0, 8) : shuffle(live.slice(0, 30)).slice(0, 10);
    const out = [];
    for (const e of arts) {
      const tr = await this.artistTracks(e, f, mode).catch(() => []);
      out.push(...shuffle(tr.filter(fresh)).slice(0, Math.ceil(n / Math.max(1, arts.length))));
    }
    return shuffle(out).slice(0, n);
  },
  take(status) {
    const a = this.ahead;
    this.ahead = null;
    return a && a.gen === this.gen ? a.p : this.next(status);
  },
  prefetch() {
    if (this.ahead && this.ahead.gen === this.gen) return;
    const p = this.next();
    p.catch(() => {});
    this.ahead = { gen: this.gen, p };
  },
  // Every song in the chosen playlists (or all saved playlists), for DJ search
  searchable() {
    const f = this.get();
    const ids = f.playlists.length ? f.playlists : Store.get('pools', []).map((p) => p.id);
    const map = new Map();
    ids.forEach((id) => Store.get('pool.' + id, []).forEach((it) => { if (!map.has(it.v)) map.set(it.v, it); }));
    const blocked = new Set(Store.get('blocked', []));
    return [...map.values()].filter((it) => !blocked.has(it.v));
  },
};

/* ================= Clip length slider (left half 0.1–1 s, right half 1–60 s) ================= */
const ONE = STOPS.indexOf(1);
function stopPos(i) { return i <= ONE ? (i / ONE) * 0.5 : 0.5 + ((i - ONE) / (STOPS.length - 1 - ONE)) * 0.5; }
function nearestStop(p) {
  let best = 0, d = 9;
  STOPS.forEach((_, i) => { const x = Math.abs(stopPos(i) - p); if (x < d) { d = x; best = i; } });
  return best;
}

/* ================= Game ================= */
const Game = {
  mode: 'guess',          // 'guess' | 'dj'
  djPicking: true,
  round: null,
  clipTimer: null,
  token: 0,
  unlocked: false,
  offs: [],
  ticker: null,

  poolLabel() { return Pool.label(); },

  /* ---- screen ---- */
  html() {
    const dj = this.mode === 'dj';
    const scale = [0, 3, ONE, 9, STOPS.length - 1].map((i) => `<span style="left: calc(12px + ${stopPos(i).toFixed(4)} * (100% - 24px))">${i === STOPS.length - 1 ? '60 s' : STOPS[i]}</span>`).join('');
    return `<div class="screen game-screen ${dj ? 'dj-mode' : ''}" id="game-root">
      <header class="topbar">
        <button class="icon-btn" data-g="home" aria-label="Back to home">${ICON.back}</button>
        <div class="title"><h1>Guess the Intro</h1></div>
        <button class="icon-btn" data-g="help" aria-label="Help">?</button>
      </header>
      <div class="game-bar">
        <div class="seg" role="tablist">
          <button data-g="mode-guess" class="${dj ? '' : 'on'}" role="tab" aria-selected="${!dj}">Guess</button>
          <button data-g="mode-dj" class="${dj ? 'on' : ''}" role="tab" aria-selected="${dj}">DJ</button>
        </div>
        <button class="pool-chip" data-g="pools" aria-label="Song pool: ${esc(Pool.label())}">${ICON.filter}<span class="name">${esc(Pool.label())}</span></button>
      </div>

      <div id="dj-pick" class="dj-pick" ${dj && this.djPicking ? '' : 'hidden'}>
        <div class="row">
          <button class="btn primary" style="flex:1" data-g="dj-random">${ICON.dice} Random pick</button>
          <button class="btn" style="flex:1" data-g="dj-yt">Search YouTube</button>
        </div>
        <input class="search" id="dj-q" placeholder="Search your playlists…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="results" id="dj-results"></div>
      </div>

      <div id="play-area" class="play-area" ${dj && this.djPicking ? 'hidden' : ''}>
        <div class="card-wrap">
          <div class="flip">
            <div class="face front">
              <div class="jfront">
                <div class="top"><span>SIDE A</span><span>MIXTAPE</span></div>
                <div class="lines"><i></i><i></i><div class="q">?</div><i></i><i></i></div>
                <div class="cap" id="g-cap">Name that song</div>
              </div>
              <div class="djfront" id="g-djart"></div>
            </div>
            <div class="face back" id="g-back"><span class="noart">ALBUM ART</span></div>
          </div>
        </div>

        <div class="stage">
          <div class="layer info">
            <button class="song-title tap" id="g-title"></button>
            <button class="song-artist tap" id="g-artist"></button>
            <button class="song-album tap" id="g-album"></button>
            <div class="mini">
              <button class="mini-btn" data-g="pp" id="g-pp" aria-label="Pause">${ICON.pause}</button>
              <div class="mini-main">
                <input type="range" id="g-scrub" min="0" max="1000" step="1" value="0" aria-label="Song position">
                <div class="mini-times"><span id="g-cur">0:00</span><span id="g-dur">0:00</span></div>
              </div>
              <button class="mini-btn" data-g="restart" aria-label="Play from the start">${ICON.restart}</button>
            </div>
            <div class="info-actions"><button class="btn small" data-g="ytm">${ICON.out} Open in YouTube Music</button></div>
          </div>
          <div class="layer controls">
            <div class="clip">
              <div class="clip-head"><span class="muted">Clip length</span><span class="v" id="g-len"></span></div>
              <div class="clip-row">
                <button class="icon-btn" data-g="shorter" aria-label="Shorter clip">−</button>
                <div class="slider-box">
                  <input type="range" id="g-slider" min="0" max="1000" step="1" aria-label="Clip length">
                  <div class="clip-scale" aria-hidden="true">${scale}</div>
                </div>
                <button class="icon-btn" data-g="longer" aria-label="Longer clip">+</button>
              </div>
            </div>
            <button class="btn big primary playbtn" data-g="play" id="g-play"><span class="prog" id="g-prog"></span><span class="lbl" id="g-play-lbl">${ICON.play} Play clip</span></button>
            <div class="row two">
              <button class="btn" data-g="more" id="g-more">More time</button>
              <button class="btn" data-g="skip">Skip silence</button>
            </div>
            <div class="start-row">
              <span id="g-start">starts at 0:00</span>
              <span class="start-tools" id="g-tools" hidden>
                <button data-g="undo">Undo</button><button data-g="back">−0.25 s</button><button data-g="zero">0:00</button>
              </span>
            </div>
          </div>
        </div>

        <div class="bottom-bar">
          <div class="layer controls">
            ${dj ? '<button class="btn" style="flex:1; padding:0 12px" data-g="dj-new">' + ICON.dice + ' Random pick</button><button class="btn light" style="flex:1" data-g="reveal" id="g-reveal">Reveal</button>'
              : '<button class="btn light" style="flex:1" data-g="reveal" id="g-reveal">Reveal</button>'}
          </div>
          <div class="layer info">
            ${dj ? '<button class="btn" style="flex:1" data-g="dj-again">Pick again</button><button class="btn primary" style="flex:1.4" data-g="dj-pass">Pass the phone</button>'
              : '<button class="btn primary" style="flex:1" data-g="next">Next song</button>'}
          </div>
        </div>
      </div>
    </div>`;
  },

  mount(root) {
    this.root = root.querySelector('#game-root');
    this.bind();
    this.updateClipUI();
    [P1, P2].forEach((p) => {
      this.offs.push(p.onError((code) => this.onPlayerError(code, p)));
      this.offs.push(p.on((s) => { if (p === Player) this.onState(s); }));
    });
    clearInterval(this.guard);
    this.guard = setInterval(() => this.guardTick(), 250);
    Player.load().catch(() => {});
    firstVisit('game');
    if (this.mode === 'dj') {
      if (this.djPicking || !this.round) this.showDJPick();
      else this.restoreRound();
      return;
    }
    if (!this.round || !this.round.item) this.newRound();
    else this.restoreRound();
  },
  leave() {
    clearInterval(this.guard);
    this.stopTimers();
    this.token++;
    this.roundSeq++;
    Player.stop();
    this.dropStage();
    P1.hideUnlock(); P2.hideUnlock();
    this.offs.forEach((off) => off());
    this.offs = [];
  },
  stopTimers() {
    clearTimeout(this.clipTimer);
    cancelAnimationFrame(this.raf);
    clearInterval(this.ticker);
    this.ticker = null;
  },

  bind() {
    const r = this.root;
    r.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b || b.disabled) return;
      const a = b.dataset.g;
      const map = {
        home: () => go('#home'),
        help: () => showHelp('game'),
        pools: () => this.openPools(() => { this.round = null; this.dropStage(); route(); }),
        'mode-guess': () => { if (this.mode !== 'guess') { this.mode = 'guess'; this.round = null; Player.stop(); route(); } },
        'mode-dj': () => { if (this.mode !== 'dj') { this.mode = 'dj'; this.djPicking = true; this.round = null; Player.stop(); this.dropStage(); route(); } },
        play: () => this.playClip(),
        more: () => this.moreTime(),
        skip: () => this.skipSilence(),
        undo: () => this.setStart(this.round.undo.length ? this.round.undo.pop() : 0),
        back: () => { this.round.undo.push(this.round.start); this.setStart(Math.max(0, this.round.start - 0.25)); },
        zero: () => { this.round.undo.push(this.round.start); this.setStart(0); },
        shorter: () => this.setClipIndex(Settings.get().clipIndex - 1),
        longer: () => this.setClipIndex(Settings.get().clipIndex + 1),
        reveal: () => this.reveal(),
        next: () => this.next(),
        pp: () => this.togglePause(),
        restart: () => { try { Player.yt.seekTo(0, true); Player.yt.unMute(); Player.yt.playVideo(); } catch (err) { /* ignore */ } },
        ytm: () => { if (this.round) { Player.stop(); openYTMusic(this.round.item.v); } },
        'dj-yt': () => this.djSearchYouTube(),
        'dj-random': () => this.djRandom(),
        'dj-new': () => this.djRandomRound(),
        'dj-again': () => { this.unreveal(); setTimeout(() => this.showDJPick(), 300); },
        'dj-pass': () => this.passPhone(),
      };
      if (!map[a]) return;
      if (this.round == null && ['undo', 'back', 'zero', 'skip', 'more', 'play', 'reveal', 'pp', 'restart'].includes(a)) return;
      map[a]();
    });
    const slider = r.querySelector('#g-slider');
    slider.addEventListener('input', () => {
      const i = nearestStop(parseInt(slider.value, 10) / 1000);
      if (i !== Settings.get().clipIndex) this.setClipIndex(i, true);
    });
    slider.addEventListener('change', () => this.updateClipUI());
    const scrub = r.querySelector('#g-scrub');
    scrub.addEventListener('input', () => {
      this.scrubbing = true;
      const d = Player.duration();
      $('#g-cur').textContent = fmtTime((d * parseInt(scrub.value, 10)) / 1000);
    });
    scrub.addEventListener('change', () => {
      const d = Player.duration();
      try { Player.yt.seekTo((d * parseInt(scrub.value, 10)) / 1000, true); Player.yt.playVideo(); } catch (e) { /* ignore */ }
      this.scrubbing = false;
    });
    const q = r.querySelector('#dj-q');
    q.addEventListener('input', () => { clearTimeout(this.djTimer); this.djTimer = setTimeout(() => this.renderDJResults(q.value), 120); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q.blur(); clearTimeout(this.djTimer); this.renderDJResults(q.value); } });
    r.querySelector('#dj-results').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const item = this.djCandidates[parseInt(b.dataset.pick, 10)];
      if (item) this.djPickItem(item);
    });
  },

  setEnabled(on) {
    ['g-play', 'g-reveal', 'g-more'].forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = !on; });
  },
  caption(t) {
    const c = $('#g-cap');
    if (c) c.textContent = t;
    const st = document.querySelector('#g-djart .djst');
    if (st) st.textContent = /^Name that song/.test(t) ? '' : t;
  },

  /* ---- clip length ---- */
  setClipIndex(i, fromSlider) {
    i = Math.max(0, Math.min(STOPS.length - 1, i));
    Settings.set({ clipIndex: i });
    if (this.round) { this.round.base = STOPS[i]; this.round.len = STOPS[i]; }
    this.updateClipUI(fromSlider);
  },
  updateClipUI(fromSlider) {
    const i = Settings.get().clipIndex;
    const slider = $('#g-slider');
    if (slider) {
      const p = stopPos(i);
      if (!fromSlider) slider.value = Math.round(p * 1000);
      slider.style.setProperty('--fill', `calc(12px + ${p.toFixed(4)} * (100% - 24px))`);
    }
    const base = STOPS[i];
    const len = this.round ? this.round.len : base;
    const lenEl = $('#g-len');
    if (lenEl) lenEl.textContent = fmtSec(len);
    const more = $('#g-more');
    if (more) more.textContent = `More time +${fmtSec(this.round ? this.round.base : base)}`;
    const st = $('#g-start');
    const tools = $('#g-tools');
    const start = this.round ? this.round.start : 0;
    if (st) st.textContent = start > 0 ? `starts at ${fmtSec(start)}` : 'starts at 0:00';
    if (tools) tools.hidden = !(this.round && (this.round.start > 0 || this.round.undo.length));
  },

  /* ---- rounds ---- */
  async newRound() {
    const myRound = ++this.roundSeq;
    this.stopTimers();
    this.token++;
    Player.stop();
    this.round = null;
    this.root.classList.remove('revealed');
    this.setEnabled(false);
    this.caption('Finding a song…');
    let item;
    try {
      item = await Pool.take((t) => { if (myRound === this.roundSeq) this.caption(t); });
    } catch (e) {
      if (myRound !== this.roundSeq) return;
      this.caption('Could not get a song');
      Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
      return;
    }
    if (myRound !== this.roundSeq) return;
    if (!item) {
      const f = Pool.get();
      const empty = !f.playlists.length && !f.artists.length && !f.genres.length && !f.decades.length && !LastFM.ready();
      this.caption(empty ? 'Pick a pool to start' : 'No songs fit this pool. Tap the pool bar to change it.');
      if (empty) setTimeout(() => this.openPools(() => { this.round = null; route(); }), 400);
      return;
    }
    this.startRound(item);
  },
  roundSeq: 0,
  async startRound(item) {
    this.stopTimers();
    const myToken = ++this.token;
    const base = STOPS[Settings.get().clipIndex];
    this.round = { item, base, len: base, start: 0, undo: [], tries: 0, phase: 'loading', meta: null, dur: 0 };
    this.root.classList.remove('revealed');
    this.fillInfo();
    this.updateClipUI();
    this.setEnabled(false);
    this.caption('Loading the song…');
    Meta.get(item).then((meta) => { if (this.round && this.round.item === item) { this.round.meta = meta; this.fillInfo(); } });
    const st = this.stage;
    let res;
    try {
      if (st && st.item && st.item.v === item.v) {
        // The next song was already loading in the other player: switch to it.
        this.stage = null;
        st.live = () => myToken === this.token;          // keep its loading going, now for this round
        st.say = (t) => this.caption(t);
        const old = Player;
        Player = st.p;
        old.stop();
        Player.log('switch to staged song');
        res = st.ready ? st.res : await st.promise;
        if (!res) res = await this.prepare(Player, item, (t) => this.caption(t), () => myToken === this.token);
      } else {
        if (this.mode !== 'dj') this.dropStage();   // DJ: keep the random song ready for the next Random pick
        await Player.load();
        if (myToken !== this.token) return;
        res = await this.prepare(Player, item, (t) => this.caption(t), () => myToken === this.token);
      }
    } catch (e) {
      if (myToken === this.token) this.loadFailed(e);
      return;
    }
    if (!res || myToken !== this.token || !this.round || this.round.item !== item) return;
    this.round.dur = res.dur;
    this.round.phase = 'ready';
    this.setEnabled(true);
    this.caption(res.ok ? 'Name that song' : 'Name that song (tap Play clip)');
    this.stageNext();
  },
  // Load a song muted into player p and let it run until the real song starts, so an ad plays out
  // silently and the first clip starts cleanly. Ends paused at 0:00. live() false = give up.
  async prepare(p, item, say, live) {
    const durP = YTData.duration(item.v).catch(() => 0);
    await p.load();
    if (!live()) return null;
    p.mute();
    p.yt.loadVideoById({ videoId: item.v, startSeconds: 0 });
    p.sample('load ' + item.v);
    const dur = await Promise.race([durP, sleep(2500).then(() => 0)]);
    const t0 = Date.now();
    let ok = false, adLogged = false, lastT = -1, stuckSince = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!live()) return null;
      const st = p.state, t = p.time();
      const ad = p.adPlaying(item.v, dur);
      if (t !== lastT) { lastT = t; stuckSince = Date.now(); }
      if (ad) {
        if (!adLogged) { p.log('ad detected'); adLogged = true; }
        say('An ad is playing silently. The song is next…');
        p.mute();
        if (Date.now() - stuckSince > 1500) { try { p.yt.playVideo(); } catch (e) { /* ignore */ } stuckSince = Date.now(); }
      } else if (st === 1 && t >= 0.25) { ok = true; break; }
      else {
        if (Date.now() - t0 > 4000) say('Still loading…');
        if (st !== 1 && st !== 3 && Date.now() - stuckSince > 1500) { try { p.mute(); p.yt.playVideo(); } catch (e) { /* ignore */ } stuckSince = Date.now(); }
        if (st === -1 && t === 0 && Date.now() - t0 > 12000) break;   // never started: Play clip will start it
      }
      await sleep(150);
    }
    try { p.yt.pauseVideo(); p.yt.seekTo(0, true); } catch (e) { /* ignore */ }
    p.log('ready');
    return { dur, ok };
  },
  // Start loading the next song in the other player (Guess mode only).
  stageNext() {
    if (this.stage) return;
    const p = Player === P1 ? P2 : P1;
    Pool.prefetch();
    const ahead = Pool.ahead;
    if (!ahead) return;
    const st = { p, item: null, ready: false, res: null, say: () => {} };
    st.live = () => this.stage === st;
    this.stage = st;
    st.promise = (async () => {
      const item = await ahead.p;
      if (!item || !st.live()) return null;
      st.item = item;
      const res = await this.prepare(p, item, (t) => st.say(t), () => st.live());
      if (!res || !st.live()) return null;
      st.res = res;
      st.ready = true;
      return res;
    })().catch(() => { if (this.stage === st) this.stage = null; return null; });
  },
  dropStage() {
    const st = this.stage;
    this.stage = null;
    if (st) { st.live = () => false; if (st.p !== Player) st.p.stop(); }
  },
  // The player didn't come up: rebuild it and let Play clip try again instead of leaving a stuck screen.
  loadFailed(e) {
    Player.log('load failed: ' + (e && e.message ? e.message.slice(0, 40) : e));
    Player.reset();
    if (this.round) this.round.phase = 'failed';
    this.setEnabled(false);
    const b = $('#g-play');
    if (b) b.disabled = false;
    this.caption("The player didn't load. Tap Play clip to try again.");
  },
  isAd() { const r = this.round; return !!(r && Player.adPlaying(r.item.v, r.dur)); },
  // Keep the player running, muted, until the real song is playing. Returns false if the round moved on.
  async waitOutAd(myToken) {
    const r = this.round, t0 = Date.now();
    Player.log('ad detected');
    let lastT = -1, stuckSince = Date.now();
    while (Date.now() - t0 < 120000) {
      Player.mute();
      const ad = this.isAd(), t = Player.time();
      if (t !== lastT) { lastT = t; stuckSince = Date.now(); }
      if (!ad && Player.state === 1) return true;
      this.caption('An ad is playing silently. The song is next…');
      if (Date.now() - stuckSince > 1500) { try { Player.yt.playVideo(); } catch (e) { /* ignore */ } stuckSince = Date.now(); }
      await sleep(150);
      if (myToken !== this.token || this.round !== r) return false;
    }
    return true;
  },
  restoreRound() {
    this.fillInfo();
    this.updateClipUI();
    if (this.round.phase === 'revealed') {
      this.root.classList.add('revealed');
      this.startTicker();
      return;
    }
    const item = this.round.item;
    this.round.phase = 'loading';
    this.setEnabled(false);
    this.caption('Loading the song…');
    const myToken = ++this.token;
    this.prepare(Player, item, (t) => this.caption(t), () => myToken === this.token).then((res) => {
      if (!res || myToken !== this.token || !this.round || this.round.item !== item) return;
      this.round.dur = res.dur;
      this.round.phase = 'ready';
      this.setEnabled(true);
      this.caption('Name that song');
      this.stageNext();
    }).catch((e) => { if (myToken === this.token) this.loadFailed(e); });
  },
  fillInfo() {
    const r = this.round;
    if (!r) return;
    const m = r.meta || {};
    const t = $('#g-title'), a = $('#g-artist'), al = $('#g-album');
    t.textContent = r.item.t;
    a.textContent = r.item.a;
    al.textContent = [m.album, m.year].filter(Boolean).join(' · ');
    const art = m.art || Meta.fallbackArt(r.item.v);
    const setCard = (el, kind, o) => { el.dataset.card = kind; Object.entries(o).forEach(([k, v]) => { el.dataset[k] = v || ''; }); };
    setCard(t, 'song', { artist: r.item.a, title: r.item.t, v: r.item.v, art });
    setCard(a, 'artist', { name: r.item.a });
    if (m.album) setCard(al, 'album', { artist: r.item.a, title: m.album, art }); else delete al.dataset.card;
    const back = $('#g-back');
    const dj = $('#g-djart');
    const setImg = (box, extra) => {
      if (!box) return;
      const img = box.querySelector('img');
      if (img && img.dataset.src === art) return;
      box.innerHTML = `<img alt="Album art" data-src="${esc(art)}" src="${esc(art)}">${extra || ''}`;
      const im = box.querySelector('img');
      im.onerror = () => { const fb = Meta.fallbackArt(r.item.v); if (im.src !== fb) im.src = fb; else im.remove(); };
    };
    setImg(back);
    if (this.mode === 'dj') {
      setImg(dj, `<div class="djst"></div><div class="djcap"><b>${esc(r.item.t)}</b><span>${esc(r.item.a)}</span></div>`);
      const cap = dj.querySelector('.djcap');
      if (cap) cap.innerHTML = `<b>${esc(r.item.t)}</b><span>${esc(r.item.a)}${m.year ? ' · ' + esc(m.year) : ''}</span>`;
    }
  },

  async playClip() {
    const r = this.round;
    if (r && r.phase === 'failed') { this.restoreRound(); return; }
    if (!r || r.phase === 'loading' || r.phase === 'revealed') return;
    const yt = Player.yt;
    this.stopTimers();
    const myToken = ++this.token;
    r.phase = 'playing';
    const startAt = r.start, len = r.len;
    try {
      if (Math.abs(Player.time() - startAt) > 0.05) yt.seekTo(startAt, true);
      yt.unMute();
      yt.setVolume(100);
      yt.playVideo();
      Player.sample('play clip ' + len + 's @' + startAt);
    } catch (e) { Errors.show('Could not play the clip.', e); return; }
    this.playUI(true, 0);
    let started = false, ad = false;
    const w0 = Date.now();
    while (Date.now() - w0 < 2500) {
      if (this.isAd()) { ad = true; break; }
      if (await Player.waitFor([1], 100)) { started = true; break; }
      if (myToken !== this.token) return;
    }
    if (myToken !== this.token) return;
    if (started && this.isAd()) ad = true;
    if (ad) { this.adMidClip(myToken, startAt); return; }
    if (!started) {
      r.phase = 'ready';
      this.playUI(false);
      if (!this.unlocked) Player.showUnlock();
      else toast('The song is still loading. Try Play clip again.');
      return;
    }
    this.unlocked = true;
    const t0 = performance.now();
    const step = () => {
      if (myToken !== this.token) return;
      if (this.isAd()) { this.adMidClip(myToken, startAt); return; }
      this.playUI(true, Math.min(1, (performance.now() - t0) / (len * 1000)));
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.clipTimer = setTimeout(() => {
      if (myToken !== this.token) return;
      cancelAnimationFrame(this.raf);
      try { yt.pauseVideo(); } catch (e) { /* ignore */ }
      const reached = Player.time();
      r.phase = 'ready';
      this.playUI(false);
      if (len >= 1 && reached < startAt + len * 0.4) toast('That clip may have been an ad or buffering. Tap Play clip again.');
      else r.tries += 1;
      try { yt.seekTo(startAt, true); } catch (e) { /* ignore */ }   // ready for an instant replay
    }, len * 1000);
  },
  async adMidClip(myToken, startAt) {
    const r = this.round, yt = Player.yt;
    clearTimeout(this.clipTimer);
    cancelAnimationFrame(this.raf);
    Player.mute();
    r.phase = 'loading';
    this.playUI(false);
    this.setEnabled(false);
    if (!(await this.waitOutAd(myToken))) return;
    try { Player.yt.pauseVideo(); Player.yt.seekTo(startAt, true); } catch (e) { /* ignore */ }
    r.phase = 'ready';
    this.setEnabled(true);
    this.caption('Name that song');
    toast('An ad came up and was muted. Tap Play clip.');
  },
  // Every quarter second: if anything is playing that the game didn't start (an ad, or the song
  // starting itself after an ad), silence it and stop it.
  guardTick() {
    const r = this.round;
    if (!r || r.phase !== 'ready') return;
    if (Player.state === 1) {
      try { Player.yt.mute(); Player.yt.pauseVideo(); } catch (e) { /* ignore */ }
      Player.log('guard: muted stray playback');
    } else if (this.isAd() && !Player.muted()) {
      Player.mute();
      Player.log('guard: muted an ad');
    }
  },
  playUI(on, p) {
    const b = $('#g-play'), lbl = $('#g-play-lbl'), prog = $('#g-prog');
    if (!b) return;
    if (on && !b.classList.contains('playing')) { b.classList.add('playing'); lbl.textContent = 'Playing…'; }
    if (!on && b.classList.contains('playing')) { b.classList.remove('playing'); lbl.innerHTML = ICON.play + ' Play clip'; }
    prog.style.transform = `scaleX(${on ? p || 0 : 0})`;
  },
  // Keep the player quiet unless the game asked it to play (an ad ending can start the song by itself).
  onState(s) {
    const r = this.round;
    if (!r || s !== 1) return;
    if (r.phase === 'ready') { try { Player.yt.mute(); Player.yt.pauseVideo(); Player.yt.seekTo(r.start, true); } catch (e) { /* ignore */ } }
  },
  moreTime() {
    const r = this.round;
    r.len = Math.round((r.len + r.base) * 100) / 100;
    this.updateClipUI();
  },
  skipSilence() {
    const r = this.round;
    r.undo.push(r.start);
    this.setStart(Math.round((r.start + r.len) * 100) / 100);
  },
  setStart(sec) {
    if (!this.round) return;
    this.round.start = Math.max(0, sec);
    if (this.round.phase === 'ready' && Player.state !== -1) { try { Player.yt.seekTo(this.round.start, true); } catch (e) { /* ignore */ } }
    this.updateClipUI();
  },

  reveal() {
    const r = this.round;
    if (!r || r.phase === 'revealed') return;
    this.stopTimers();
    this.token++;
    this.playUI(false);
    r.phase = 'revealed';
    this.fillInfo();
    this.root.classList.add('revealed');
    try {
      const yt = Player.yt;
      yt.unMute();
      if (!r.tries) yt.seekTo(r.start, true);
      yt.playVideo();
      Player.sample('reveal');
    } catch (e) { /* ignore */ }
    this.startTicker();
  },
  startTicker() {
    clearInterval(this.ticker);
    const tick = () => {
      if (!this.round || this.round.phase !== 'revealed') return;
      const d = Player.duration(), c = Player.time();
      const playing = Player.state === 1;
      if (!this.scrubbing) {
        $('#g-scrub').value = d ? Math.round((c / d) * 1000) : 0;
        $('#g-cur').textContent = fmtTime(c);
      }
      $('#g-scrub').style.setProperty('--fill', (d ? (c / d) * 100 : 0) + '%');
      $('#g-dur').textContent = fmtTime(d);
      const pp = $('#g-pp');
      if (pp.dataset.playing !== String(playing)) {
        pp.dataset.playing = String(playing);
        pp.innerHTML = playing ? ICON.pause : ICON.play;
        pp.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      }
    };
    tick();
    this.ticker = setInterval(tick, 250);
  },
  togglePause() {
    try { if (Player.state === 1) Player.yt.pauseVideo(); else { Player.yt.unMute(); Player.yt.playVideo(); } } catch (e) { /* ignore */ }
  },
  unreveal() {
    this.root.classList.remove('revealed');
    this.stopTimers();
    Player.stop();
  },
  next() {
    this.stopTimers();
    this.token++;
    Player.stop();
    const wasRevealed = this.root.classList.contains('revealed');
    this.root.classList.remove('revealed');
    if (this.mode === 'dj') { setTimeout(() => this.showDJPick(), wasRevealed ? 380 : 0); return; }
    setTimeout(() => this.newRound(), wasRevealed ? 420 : 0);
  },
  onPlayerError(code, p) {
    // 100 = removed, 101/150 = owner blocks playing outside YouTube, 2/5 = bad id/player problem
    const block = (v) => { const list = Store.get('blocked', []); if (v && !list.includes(v)) { list.push(v); Store.set('blocked', list); } };
    if (p && p !== Player) {          // the song loading in the background can't play: drop it quietly
      if (this.stage && this.stage.p === p) { block(this.stage.item && this.stage.item.v); this.dropStage(); }
      return;
    }
    const r = this.round;
    if (!r) return;
    if ([100, 101, 150, 2].includes(code)) {
      const list = Store.get('blocked', []);
      if (!list.includes(r.item.v)) list.push(r.item.v);
      Store.set('blocked', list);
      toast("That song can't play inside Mixtape. Skipping it.");
      if (this.mode === 'dj') this.showDJPick();
      else this.newRound();
    } else {
      Errors.show('The YouTube player reported a problem (code ' + code + ').');
    }
  },
  // Locking the phone mid-guess: drop the player so the lock screen can't show the song.
  onHide() {
    const r = this.round;
    if (!r || r.phase === 'revealed') return;
    this.stopTimers();
    this.token++;
    this.playUI(false);
    this.dropStage();
    Player.log('app hidden: players dropped');
    P1.reset(); P2.reset();
    this.unlocked = false;
    this.needsReload = true;
  },
  onShow() {
    if (!this.needsReload) return;
    this.needsReload = false;
    Player.log('app back on screen');
    setTimeout(() => { if (this.round && this.round.phase !== 'revealed' && currentView === Views.game) this.restoreRound(); }, 500);
  },

  /* ---- DJ mode ---- */
  djCandidates: [],
  showDJPick() {
    this.djPicking = true;
    this.round = null;
    this.stopTimers();
    this.token++;
    Player.stop();
    this.root.classList.remove('revealed');
    $('#dj-pick').hidden = false;
    $('#play-area').hidden = true;
    const q = $('#dj-q');
    if (q) q.value = '';
    this.renderDJResults('');
    Player.load().then(() => this.stageNext()).catch(() => {});
  },
  // Under the search box: a few random songs from the current pool (playlist songs, or Last.fm picks)
  async renderDJResults(query) {
    const box = $('#dj-results');
    if (!box) return;
    const seq = this.djSeq = (this.djSeq || 0) + 1;
    const f = Pool.get();
    const mode = Pool.mode(f);
    let list, note = '';
    if (query && query.trim()) {
      const all = Pool.searchable().concat(this.djSample || []);
      list = all.map((it) => ({ it, s: fuzzyScore(query, it.t + ' ' + it.a) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it);
      if (!list.length) { box.innerHTML = '<p class="muted">No close matches here. Tap Search YouTube.</p>'; this.djCandidates = []; return; }
    } else if (mode === 'P') {
      list = shuffle(Pool.searchable()).slice(0, 30);
      note = 'A few from this pool. Type to search your playlists.';
    } else {
      box.innerHTML = '<p class="muted">Picking a few songs from this pool…</p>';
      try { list = await Pool.sample(30); } catch (e) { list = []; if (e instanceof ApiError && /key/i.test(e.message)) Errors.show(e.message); }
      if (seq !== this.djSeq) return;
      this.djSample = list;
      note = 'A few from this pool. Type to search, or tap Search YouTube.';
    }
    this.djCandidates = list;
    box.innerHTML = list.length
      ? (note ? `<p class="muted small" style="margin:4px 0">${note}</p>` : '') + list.map((it, i) => resultRow(it, i)).join('')
      : '<p class="muted">Tap Random pick, or type a song and tap Search YouTube.</p>';
  },
  async djPickItem(item) {
    if (item.v) { SongFinder.remember(item.a, item.t, item.v); this.djChoose(item); return; }
    const box = $('#dj-results');
    const seq = this.djSeq = (this.djSeq || 0) + 1;
    box.innerHTML = `<p class="muted">Finding "${esc(item.t)}" on YouTube…</p>`;
    try {
      const v = await SongFinder.find(item.a, item.t);
      if (seq !== this.djSeq) return;
      if (!v) { toast("Couldn't find that one on YouTube. Pick another."); this.renderDJResults(''); return; }
      this.djChoose({ v, a: item.a, t: item.t });
    } catch (e) {
      this.renderDJResults('');
      Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
    }
  },
  // DJ "Random" button on the game screen: straight into a new random round
  async djRandomRound() {
    const seq = ++this.roundSeq;
    this.stopTimers();
    this.token++;
    Player.stop();
    this.round = null;
    this.root.classList.remove('revealed');
    this.setEnabled(false);
    const art = $('#g-djart');
    const say = (t) => { if (seq === this.roundSeq) art.innerHTML = `<div class="djwait">${esc(t)}</div>`; };
    say('Finding a song…');
    try {
      const item = await Pool.take(say);
      if (seq !== this.roundSeq) return;
      if (!item) { say('No songs fit this pool. Tap the pool bar to change it.'); return; }
      this.startRound(item);
    } catch (e) {
      say('Could not get a song');
      Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
    }
  },
  async djRandom() {
    const box = $('#dj-results');
    const seq = this.djSeq = (this.djSeq || 0) + 1;
    box.innerHTML = '<p class="muted">Finding a song…</p>';
    try {
      const item = await Pool.take((t) => { if (seq === this.djSeq) box.innerHTML = `<p class="muted">${esc(t)}</p>`; });
      if (seq !== this.djSeq) return;
      if (!item) { box.innerHTML = '<p class="muted">No songs fit this pool. Tap the pool bar to change it.</p>'; return; }
      this.djChoose(item);
    } catch (e) {
      box.innerHTML = '';
      Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
    }
  },
  async djSearchYouTube() {
    const q = ($('#dj-q') || {}).value || '';
    if (!q.trim()) { toast('Type a song or artist first'); $('#dj-q').focus(); return; }
    const box = $('#dj-results');
    clearTimeout(this.djTimer);
    const seq = this.djSeq = (this.djSeq || 0) + 1;
    box.innerHTML = '<p class="muted">Searching YouTube…</p>';
    try {
      SongFinder.count();
      const list = await YTData.searchSongs(q.trim());
      if (seq !== this.djSeq) return;
      this.djCandidates = list;
      box.innerHTML = list.length ? list.map((it, i) => resultRow(it, i)).join('') : '<p class="muted">Nothing found.</p>';
    } catch (e) {
      box.innerHTML = '';
      Errors.show(e.message || String(e));
    }
  },
  djChoose(item) {
    this.djPicking = false;
    $('#dj-pick').hidden = true;
    $('#play-area').hidden = false;
    this.startRound(item);
  },
  passPhone() {
    this.stopTimers();
    Player.stop();
    const blank = document.createElement('div');
    blank.className = 'blank';
    blank.innerHTML = `<div class="big">Pass the phone</div><p class="muted">Hand it to the next DJ.</p><button class="btn big primary" style="min-width:220px">I'm the DJ</button>`;
    document.body.appendChild(blank);
    blank.querySelector('button').onclick = () => { blank.remove(); this.showDJPick(); };
  },

  /* ---- song pool sheet ---- */
  openPools(onDone) {
    const draft = JSON.parse(JSON.stringify(Pool.get()));
    const before = JSON.stringify(draft);
    let addedPlaylist = false;
    Sheets.open({
      title: 'Song pool',
      html: `<p class="muted small" style="margin-top:0">Picks narrow each other: a playlist plus 90s plays that playlist's 90s songs. Several in one row widen it (70s + 90s). Nothing picked plays popular songs from any era.</p>
        <div class="now" data-now></div>
        <h3>Playlists</h3><div data-pl></div>
        <details class="add-pl"><summary>Add a YouTube Music playlist</summary>
          <input class="field" data-x="link" placeholder="Paste the playlist link" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="row" style="margin-top:8px"><button class="btn small primary" data-x="add">Add playlist</button><button class="link-btn" data-x="how">How to get the link</button></div>
          <p class="muted small" data-x="status"></p>
        </details>
        <h3>Artists</h3>
        <input class="field" data-x="asearch" placeholder="Search for an artist" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="ares" data-ares></div>
        <div class="chips" data-achips></div>
        <h3>Genres</h3><div class="chips" data-genres></div>
        <div class="row" style="margin-top:8px"><input class="field" data-x="gother" placeholder="Another genre (any Last.fm tag)" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn small" data-x="gadd">Add</button></div>
        <h3>Decades</h3><div class="chips" data-decades></div>
        <h3>Hits or deep cuts</h3><div class="hits" data-hits></div><p class="muted small" data-hitsnote></p>
        <div class="row sheet-actions"><button class="btn" data-x="clear">Clear all</button><button class="btn primary" style="flex:1" data-x="done">Done</button></div>`,
      onMount: (body, close) => {
        const $b = (s) => body.querySelector(s);
        const status = (t) => { $b('[data-x=status]').textContent = t; };
        const renderNow = () => { $b('[data-now]').innerHTML = `Plays: <b>${esc(Pool.label(draft))}</b>`; };
        const renderPl = () => {
          const pools = Store.get('pools', []);
          $b('[data-pl]').innerHTML = pools.map((p) => `<div class="pool-item">
            <button class="check ${draft.playlists.includes(p.id) ? 'on' : ''}" data-x="pl" data-id="${esc(p.id)}" aria-pressed="${draft.playlists.includes(p.id)}"><span class="box">${ICON.check}</span>
              <span class="main"><span class="n">${esc(p.name)}</span><span class="c">${p.count} songs · updated ${esc((p.updated || '').slice(0, 10))}</span></span></button>
            <button class="btn small" data-x="refresh" data-id="${esc(p.id)}">Refresh</button>
            <button class="icon-btn" data-x="remove" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${ICON.close}</button></div>`).join('')
            || '<p class="muted small">No playlists yet.</p>';
        };
        const renderArtists = () => {
          $b('[data-achips]').innerHTML = draft.artists.map((a, i) => `<span class="chip on art">
            <button data-x="albums" data-i="${i}">${esc(a.name)}<small>${a.albums && a.albums.length ? ` · ${a.albums.length} album${a.albums.length === 1 ? '' : 's'}` : ' · all songs'}</small></button>
            <button data-x="adel" data-i="${i}" aria-label="Remove ${esc(a.name)}">${ICON.close}</button></span>`).join('')
            + (draft.artists.length ? '<p class="muted small" style="flex-basis:100%;margin:2px 0 0">Tap an artist to pick albums.</p>' : '');
        };
        const renderGenres = () => {
          const all = GENRES.concat(draft.genres.filter((g) => !GENRES.includes(g)));
          $b('[data-genres]').innerHTML = all.map((g) => `<button class="chip ${draft.genres.includes(g) ? 'on' : ''}" data-x="genre" data-v="${esc(g)}">${esc(g)}</button>`).join('')
            + (draft.artists.length && draft.genres.length && !draft.playlists.length ? '<p class="muted small" style="flex-basis:100%;margin:2px 0 0">Genres are skipped while artists are picked.</p>' : '');
        };
        const renderDecades = () => {
          $b('[data-decades]').innerHTML = Object.keys(DEC).map((d) => `<button class="chip ${draft.decades.includes(d) ? 'on' : ''}" data-x="decade" data-v="${d}">${d}</button>`).join('');
        };
        const renderHits = () => {
          const h = draft.hits;
          $b('[data-hits]').innerHTML = `<button class="${h ? '' : 'on'}" data-x="hany">Any</button>` + BANDS.map((n, i) => `<button class="${h && i >= h[0] && i <= h[1] ? 'on' : ''}" data-x="hit" data-i="${i}">${n}</button>`).join('');
          $b('[data-hitsnote]').textContent = h
            ? `${this.hitsNote(h)} Big hits are an artist's top 3 songs on Last.fm (just the top one for a one-hit wonder); well known is the rest of their top 15. With genres, decades or nothing picked, songs come from well-known artists. Tap more steps to widen the range.`
            : 'Any: playlists play every song, picked artists play their hits through album tracks, and genres and decades play big hits and well-known songs by well-known artists.';
        };
        const all = () => { renderNow(); renderPl(); renderArtists(); renderGenres(); renderDecades(); renderHits(); };
        all();

        const fetchPool = async (id, existingName) => {
          status('Reading the playlist…');
          const name = existingName || await YTData.playlistName(id);
          const items = await YTData.playlistItems(id, (n, total) => status(`Reading the playlist… ${n}${total ? ' of ' + total : ''} songs`));
          if (!items.length) throw new ApiError('That playlist has no playable songs.');
          Store.set('pool.' + id, items);
          const pools = Store.get('pools', []).filter((p) => p.id !== id);
          pools.push({ id, name, count: items.length, updated: new Date().toISOString() });
          Store.set('pools', pools);
          SongFinder.forget();
          status('');
          return { name, count: items.length };
        };

        // Artist search (Last.fm, close matches as you type)
        let aTimer = null, aSeq = 0, aList = [];
        const asearch = $b('[data-x=asearch]');
        asearch.addEventListener('input', () => {
          clearTimeout(aTimer);
          const q = asearch.value.trim();
          if (!q) { $b('[data-ares]').innerHTML = ''; return; }
          aTimer = setTimeout(async () => {
            const seq = ++aSeq;
            try {
              const list = await LastFM.searchArtists(q);
              if (seq !== aSeq) return;
              aList = list.slice(0, 6);
              $b('[data-ares]').innerHTML = aList.map((a, i) => `<button class="rowbtn" data-x="apick" data-i="${i}"><span>${esc(a.name)}</span><span class="muted small">${a.listeners ? Math.round(a.listeners / 1000).toLocaleString() + 'k listeners' : ''}</span></button>`).join('')
                || '<p class="muted small">No artists found.</p>';
            } catch (e) {
              $b('[data-ares]').innerHTML = '';
              Errors.show(e.message || String(e));
            }
          }, 280);
        });

        body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-x]');
          if (!b) return;
          const x = b.dataset.x;
          try {
            if (x === 'how') showHelp('pools');
            if (x === 'pl') { const id = b.dataset.id; draft.playlists = draft.playlists.includes(id) ? draft.playlists.filter((p) => p !== id) : draft.playlists.concat(id); renderPl(); renderNow(); renderGenres(); }
            if (x === 'remove') {
              const pool = Store.get('pools', []).find((p) => p.id === b.dataset.id);
              if (pool && confirm(`Remove "${pool.name}" from Mixtape? (It stays in YouTube Music.)`)) {
                Store.set('pools', Store.get('pools', []).filter((p) => p.id !== pool.id));
                Store.del('pool.' + pool.id);
                draft.playlists = draft.playlists.filter((p) => p !== pool.id);
                SongFinder.forget();
                addedPlaylist = true;
                renderPl(); renderNow();
              }
            }
            if (x === 'refresh') {
              b.disabled = true;
              const pool = Store.get('pools', []).find((p) => p.id === b.dataset.id);
              const r = await fetchPool(b.dataset.id, pool && pool.name);
              addedPlaylist = true;
              renderPl();
              toast(`${r.name}: ${r.count} songs`);
            }
            if (x === 'add') {
              const id = YTData.parsePlaylistId($b('[data-x=link]').value);
              if (!id) { status("That doesn't look like a playlist link. In YouTube Music: playlist → ⋯ → Share → Copy link."); return; }
              b.disabled = true;
              const r = await fetchPool(id);
              b.disabled = false;
              $b('[data-x=link]').value = '';
              if (!draft.playlists.includes(id)) draft.playlists.push(id);
              addedPlaylist = true;
              renderPl(); renderNow();
              toast(`Added ${r.name}: ${r.count} songs`);
            }
            if (x === 'apick') {
              const a = aList[parseInt(b.dataset.i, 10)];
              if (a && !draft.artists.some((y) => norm(y.name) === norm(a.name))) draft.artists.push({ name: a.name, mbid: a.mbid, albums: [] });
              asearch.value = '';
              $b('[data-ares]').innerHTML = '';
              renderArtists(); renderNow(); renderGenres();
            }
            if (x === 'adel') { draft.artists.splice(parseInt(b.dataset.i, 10), 1); renderArtists(); renderNow(); renderGenres(); }
            if (x === 'albums') {
              const art = draft.artists[parseInt(b.dataset.i, 10)];
              if (art) this.albumPicker(art, () => { renderArtists(); renderNow(); });
            }
            if (x === 'genre') { const v = b.dataset.v; draft.genres = draft.genres.includes(v) ? draft.genres.filter((g) => g !== v) : draft.genres.concat(v); renderGenres(); renderNow(); }
            if (x === 'gadd') {
              const inp = $b('[data-x=gother]');
              const v = inp.value.trim().toLowerCase();
              if (v && !draft.genres.includes(v)) draft.genres.push(v);
              inp.value = '';
              renderGenres(); renderNow();
            }
            if (x === 'decade') { const v = b.dataset.v; draft.decades = draft.decades.includes(v) ? draft.decades.filter((g) => g !== v) : draft.decades.concat(v); renderDecades(); renderNow(); }
            if (x === 'hany') { draft.hits = null; renderHits(); renderNow(); }
            if (x === 'hit') {
              const i = parseInt(b.dataset.i, 10), h = draft.hits;
              if (!h) draft.hits = [i, i];
              else if (i < h[0]) draft.hits = [i, h[1]];
              else if (i > h[1]) draft.hits = [h[0], i];
              else if (h[0] === h[1]) draft.hits = null;
              else if (i === h[0]) draft.hits = [h[0] + 1, h[1]];
              else if (i === h[1]) draft.hits = [h[0], h[1] - 1];
              else draft.hits = [i, i];
              renderHits(); renderNow();
            }
            if (x === 'clear') { Object.assign(draft, Pool.defaults()); all(); }
            if (x === 'done') close();
          } catch (err) {
            b.disabled = false;
            status('');
            Errors.show(err.message || String(err), err instanceof ApiError ? '' : err);
          }
        });
      },
      onClose: () => {
        if (JSON.stringify(draft) !== before || addedPlaylist) {
          Pool.set(draft);
          if (onDone) onDone();
        }
      },
    });
  },
  hitsNote(h) { return h[0] === h[1] ? `${BANDS[h[0]]} only.` : `${BANDS[h[0]]} through ${BANDS[h[1]].toLowerCase()}.`; },
  albumPicker(art, onSave) {
    const chosen = new Set((art.albums || []).map((a) => a.id));
    let albums = [];
    Sheets.open({
      title: art.name,
      html: `<p class="muted small" style="margin-top:0">Pick albums to narrow the game to them. None picked plays all of ${esc(art.name)}'s songs.</p>
        <div class="row" style="gap:16px"><button class="link-btn" data-y="all">Select all</button><button class="link-btn" data-y="none">Select none</button></div>
        <div data-list><p class="muted">Loading albums…</p></div>
        <div class="row sheet-actions"><button class="btn primary wide" data-y="save">Save</button></div>`,
      onMount: async (body, close) => {
        const list = body.querySelector('[data-list]');
        const render = () => {
          list.innerHTML = albums.length ? albums.map((a) => `<button class="check ${chosen.has(a.id) ? 'on' : ''}" data-y="t" data-id="${esc(a.id)}"><span class="box">${ICON.check}</span>
            <span class="cvs"><img src="https://coverartarchive.org/release-group/${esc(a.id)}/front-250" alt="" loading="lazy" onerror="this.remove()"></span>
            <span class="main"><span class="n">${esc(a.title)}</span><span class="c">${a.year || ''}</span></span></button>`).join('') : '<p class="muted">No studio albums found for this artist.</p>';
        };
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-y]');
          if (!b) return;
          const y = b.dataset.y;
          if (y === 't') { const id = b.dataset.id; if (chosen.has(id)) chosen.delete(id); else chosen.add(id); render(); }
          if (y === 'all') { albums.forEach((a) => chosen.add(a.id)); render(); }
          if (y === 'none') { chosen.clear(); render(); }
          if (y === 'save') {
            art.albums = albums.filter((a) => chosen.has(a.id)).map((a) => ({ id: a.id, title: a.title, year: a.year }));
            close();
            onSave();
          }
        });
        try {
          let id = art.mbid;
          if (!id) { const f = await MB.findArtist(art.name); id = f && f.id; if (id) art.mbid = id; }
          albums = id ? await MB.albums(id) : [];
          render();
        } catch (e) {
          list.innerHTML = `<p class="muted">Couldn't load albums. ${esc(e.message || '')}</p>`;
        }
      },
    });
  },
};

function resultRow(it, i) {
  const thumb = it.thumb || (it.v ? `https://i.ytimg.com/vi/${it.v}/default.jpg` : '');
  return `<button class="result" data-pick="${i}">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
    <span style="min-width:0"><span class="t" style="display:block">${esc(it.t)}</span><span class="a" style="display:block">${esc(it.a)}</span></span></button>`;
}
function fmtSec(x) {
  const r = Math.round(x * 100) / 100;
  if (r >= 1) return r + ' s';
  return r.toFixed(Math.round(r * 100) % 10 ? 2 : 1) + ' s';
}

Views.game = {
  html: () => Game.html(),
  mount: (root) => Game.mount(root),
  leave: () => Game.leave(),
};
document.addEventListener('visibilitychange', () => {
  if (currentView !== Views.game) return;
  if (document.visibilityState === 'hidden') Game.onHide(); else Game.onShow();
});
