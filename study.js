'use strict';
/* Setlist Study Guide: look up any setlist on setlist.fm, and build a study guide (likely set, might play,
   swap slots, stage times) and playlist for a show. Also the setlist pieces used elsewhere: the artist
   card's Setlists button, the song card's "played at" line, and the diary's setlist.fm pull and import.
   Needs app.js, sync.js, info.js, diary.js and builder.js loaded first. */

/* ================= setlist.fm, through the relay (2 requests a second, remembered for a while) ================= */
const SetlistFM = {
  last: 0, chain: Promise.resolve(), mem: new Map(),
  ready() { return typeof Sync !== 'undefined' && Sync.has('setlistfm'); },
  cache() { if (!this._c) this._c = Store.get('slCache', {}); return this._c; },
  saveCache() {
    const c = this.cache(), keys = Object.keys(c);
    if (keys.length > 160) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - 160).forEach((k) => delete c[k]);
    try { localStorage.setItem('mixtape.slCache', JSON.stringify(c)); } catch (e) { /* full: it's only a cache */ }
  },
  async get(path, params = {}, maxAgeH = 6) {
    if (!this.ready()) throw new ApiError('setlist.fm isn\'t set up yet: the relay needs its SETLISTFM_KEY secret (see the spec\'s setup steps).');
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    const key = path + (q ? '?' + q : '');
    const hit = this.cache()[key];
    if (hit && Date.now() - hit.t < maxAgeH * 3600000) return hit.d;
    if (this.mem.has(key)) return this.mem.get(key);
    const p = (this.chain = this.chain.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = this.last + 600 - Date.now();
        if (wait > 0) await sleep(wait);
        this.last = Date.now();
        const r = await Sync.req('/setlistfm/' + key);
        if (r.status === 404) return null;                    // setlist.fm says "not found" when a search has no results
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (r.status === 401 || r.status === 403) throw new ApiError('setlist.fm turned the key down. Check SETLISTFM_KEY in Cloudflare.');
        if (!r.ok) throw new ApiError('setlist.fm error: HTTP ' + r.status);
        const d = await r.json();
        this.cache()[key] = { t: Date.now(), d };
        this.saveCache();
        return d;
      }
      throw new ApiError('setlist.fm is busy. Wait a minute and try again.');
    }));
    this.mem.set(key, p);
    p.finally(() => this.mem.delete(key)).catch(() => {});
    return p;
  },
  iso(d) { const m = String(d || '').match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; },
  sfm(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; },
  arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; },
  // One show in a simpler shape
  show(r) {
    const v = r.venue || {}, c = v.city || {};
    const sets = this.arr(r.sets && r.sets.set).map((s) => ({
      name: s.name || (s.encore ? (s.encore > 1 ? `Encore ${s.encore}` : 'Encore') : ''), encore: !!s.encore,
      songs: this.arr(s.song).filter((x) => x && x.name).map((x) => ({ t: x.name, cover: x.cover ? x.cover.name : '', with: x.with ? x.with.name : '', tape: !!x.tape, info: x.info || '' })),
    })).filter((s) => s.songs.length);
    const songs = [];
    sets.forEach((s) => s.songs.forEach((x) => { if (!x.tape) songs.push({ t: x.t, encore: s.encore, cover: x.cover }); }));
    return { id: r.id, date: this.iso(r.eventDate), artist: (r.artist && r.artist.name) || '', mbid: (r.artist && r.artist.mbid) || '',
      venue: v.name || '', city: [c.name, c.stateCode || (c.country && c.country.code !== 'US' ? c.country.name : '')].filter(Boolean).join(', '),
      tour: (r.tour && r.tour.name) || '', info: r.info || '', url: r.url || '', sets, songs };
  },
  async searchArtists(q) {
    const j = await this.get('search/artists', { artistName: q, sort: 'relevance', p: 1 }, 72);
    return this.arr(j && j.artist).slice(0, 8).map((a) => ({ name: a.name, mbid: a.mbid, dis: a.disambiguation || '' }));
  },
  async artistSetlists(mbid, page = 1) {
    const j = await this.get(`artist/${mbid}/setlists`, { p: page });
    return { list: this.arr(j && j.setlist).map((r) => this.show(r)), total: (j && j.total) || 0, per: (j && j.itemsPerPage) || 20 };
  },
  async search(params, page = 1) {
    const j = await this.get('search/setlists', Object.assign({}, params, { p: page }));
    return { list: this.arr(j && j.setlist).map((r) => this.show(r)), total: (j && j.total) || 0, per: (j && j.itemsPerPage) || 20 };
  },
  async attended(user, page = 1) {
    const j = await this.get(`user/${encodeURIComponent(user)}/attended`, { p: page }, 1);
    return { list: this.arr(j && j.setlist).map((r) => this.show(r)), total: (j && j.total) || 0, per: (j && j.itemsPerPage) || 20 };
  },
  // An artist name → setlist.fm's artist (MusicBrainz id)
  async findArtist(name, mbid) {
    if (mbid) return { name, mbid };
    const list = await this.searchArtists(name);
    const best = list.map((a) => ({ a, s: sim(a.name, name) })).sort((x, y) => y.s - x.s)[0];
    return best && best.s >= 0.7 ? best.a : null;
  },
  // The act's most recent shows that have songs, before a date
  async recent(mbid, before, n, onProgress) {
    const out = [];
    for (let page = 1; page <= 5 && out.length < n; page++) {
      const r = await this.artistSetlists(mbid, page);
      r.list.forEach((s) => { if (s.songs.length >= 3 && (!before || s.date < before) && out.length < n) out.push(s); });
      if (onProgress) onProgress(out.length);
      if (page * r.per >= r.total) break;
    }
    return out;
  },
  url(s) { return s.url || ('https://www.setlist.fm/search?query=' + encodeURIComponent([s.artist, s.venue, s.date].filter(Boolean).join(' '))); },
};

/* ================= The likely set ================= */
const sk = (t) => norm(t);
const Predict = {
  // shows: newest first. Returns weights per show and a verdict per song.
  build(shows, showDate) {
    const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
    const cur = (shows.slice(0, 3).find((s) => s.tour) || {}).tour || '';
    const onTour = shows.filter((s) => cur && s.tour === cur);
    const tourStart = onTour.length ? onTour[onTour.length - 1].date : '';
    const lens = shows.map((s) => s.songs.length).sort((a, b) => a - b);
    const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const gap = shows.length && showDate ? days(showDate, shows[0].date) : 0;
    const low = onTour.length < 3 || gap > 75;
    // 1) how much each show counts
    const counted = shows.map((s) => {
      let kind, w;
      if (!cur) { kind = 'tour'; w = 1; }
      else if (s.tour === cur) { kind = 'tour'; w = 1; }
      else if (!s.tour && s.date >= tourStart) { kind = 'one-off'; w = 0.5; }
      else { kind = 'earlier tour'; w = onTour.length >= 5 ? 0 : onTour.length >= 3 ? 0.25 : 0.6; }
      const fest = /\bfest(ival)?\b/i.test(s.venue + ' ' + s.info + ' ' + s.tour) || s.songs.length < median * 0.6;
      if (fest && w) { w *= 0.5; kind += fest ? ' · short or festival set' : ''; }
      return { s, kind, w };
    });
    let rank = 0;
    counted.forEach((c) => { if (c.w > 0) { c.w *= Math.pow(0.88, rank); rank++; } });
    // 2) did the set change lately? (the last few shows match each other but not the ones before)
    const live = counted.filter((c) => c.w > 0);
    const keys = (c) => new Set(c.s.songs.map((x) => sk(x.t)));
    const jac = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i || 1); };
    let changed = '';
    for (let k = Math.min(4, live.length - 2); k >= 2 && !changed; k--) {
      const A = live.slice(0, k).map(keys), B = live.slice(k, k + 4).map(keys);
      if (B.length < 2) continue;
      let inA = 0, nA = 0, x = 0, nX = 0;
      A.forEach((a, i) => A.slice(i + 1).forEach((b) => { inA += jac(a, b); nA++; }));
      A.forEach((a) => B.forEach((b) => { x += jac(a, b); nX++; }));
      if (inA / nA >= 0.8 && x / nX < 0.65) {
        changed = live[k - 1].s.date;
        live.slice(k).forEach((c) => { c.w *= 0.25; });
      }
    }
    // 3) every song: weighted share of shows, recent count, usual spot, encore, cover
    const total = counted.reduce((t, c) => t + c.w, 0) || 1;
    const songs = new Map();
    counted.forEach((c, ci) => {
      const n = c.s.songs.length;
      c.s.songs.forEach((x, i) => {
        const k = sk(x.t);
        if (!k) return;
        const e = songs.get(k) || { t: x.t, w: 0, pos: 0, posW: 0, enc: 0, cover: x.cover, last3: 0, seen: [] };
        if (e.seen.includes(ci)) return;
        e.seen.push(ci);
        e.w += c.w;
        e.pos += c.w * (i / Math.max(1, n - 1)); e.posW += c.w;
        if (x.encore) e.enc += c.w;
        songs.set(k, e);
      });
    });
    const recent3 = live.slice(0, 3).map((c) => counted.indexOf(c));
    const latest = live[0] ? live[0].s.songs.map((x) => sk(x.t)) : [];
    const list = [...songs.values()].map((e) => ({
      t: e.t, pct: e.w / total, last3: e.seen.filter((i) => recent3.includes(i)).length, of3: recent3.length,
      encore: e.posW ? e.enc / e.posW > 0.5 : false, cover: e.cover || '',
      pos: latest.includes(sk(e.t)) ? latest.indexOf(sk(e.t)) / Math.max(1, latest.length - 1) : (e.posW ? e.pos / e.posW : 1),
      seen: e.seen,
    }));
    // 4) swap slots: two songs that never share a show, sit in about the same spot, and between them fill it most nights
    const cand = list.filter((x) => x.pct >= 0.15 && x.pct <= 0.85).sort((a, b) => b.pct - a.pct);
    const swaps = [], used = new Set();
    cand.forEach((a) => {
      if (used.has(a.t)) return;
      const b = cand.find((y) => y !== a && !used.has(y.t) && !y.seen.some((i) => a.seen.includes(i)) && a.pct + y.pct >= 0.75 && Math.abs(a.pos - y.pos) <= 0.12);
      if (b) { swaps.push([a, b]); used.add(a.t); used.add(b.t); }
    });
    list.forEach((x) => {
      x.kind = used.has(x.t) ? 'swap' : x.pct >= 0.5 ? 'likely' : x.pct >= 0.15 ? 'might' : 'rare';
      x.on = x.kind === 'likely' || x.kind === 'swap';
      delete x.seen;
    });
    swaps.forEach(([a, b], i) => { a.pair = i; b.pair = i; });
    list.sort((a, b) => a.pos - b.pos || b.pct - a.pct);
    return {
      shows: counted.map((c) => ({ id: c.s.id, date: c.s.date, tour: c.s.tour, venue: c.s.venue, city: c.s.city, n: c.s.songs.length, kind: c.kind, w: Math.round(c.w * 100) / 100 })),
      songs: list, changed, low, tour: cur, median: live.length ? Math.round(live.slice(0, 5).reduce((t, c) => t + c.s.songs.length, 0) / Math.min(5, live.length)) : median,
    };
  },
  // A new tour: songs from the newest album that haven't been played yet ("likely debut")
  async debuts(act, result) {
    const albums = await MB.albums(act.mbid).catch(() => []);
    const newest = albums.filter((a) => a.year).sort((a, b) => b.year - a.year)[0];
    const lastYear = +String((result.shows[0] || {}).date || '').slice(0, 4) || new Date().getFullYear();
    if (!newest || newest.year < lastYear - 1) return [];
    const at = await MB.albumTracks(newest.id).catch(() => ({ tracks: [] }));
    const have = new Set(result.songs.map((x) => sk(x.t)));
    const top = new Map((await LastFM.topTracks(act.name).catch(() => [])).map((x, i) => [sk(x.t), i]));
    const fresh = at.tracks.map((t) => cleanTitle(t.t)).filter((t) => t && !have.has(sk(t)));
    const ranked = fresh.slice().sort((a, b) => (top.has(sk(a)) ? top.get(sk(a)) : 999) - (top.has(sk(b)) ? top.get(sk(b)) : 999));
    const pick = new Set(ranked.slice(0, 5).map(sk));
    return fresh.map((t) => ({ t, pct: 0, last3: 0, of3: 0, encore: false, cover: '', pos: 2, kind: 'debut', on: pick.has(sk(t)), album: newest.title }));
  },
  // How well a guide did once the real setlist is posted
  score(predicted, played) {
    const P = predicted.map(sk), Q = played.map(sk);
    const hits = P.filter((x) => Q.includes(x));
    let ok = 0, all = 0;
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) { all++; if (Q.indexOf(hits[i]) < Q.indexOf(hits[j])) ok++; }
    return { hits: hits.length, predicted: P.length, played: Q.length, missed: played.filter((t) => !P.includes(sk(t))), wrong: predicted.filter((t) => !Q.includes(sk(t))), order: all ? Math.round((ok / all) * 100) : null };
  },
};

/* ================= Stage times ================= */
const Timing = {
  parse(t) { const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i); if (!m) return null; let h = +m[1]; const min = +(m[2] || 0); if (m[3]) { if (/p/i.test(m[3]) && h < 12) h += 12; if (/a/i.test(m[3]) && h === 12) h = 0; } else if (h < 12 && h >= 1 && h <= 11) h += 12; return h * 60 + min; },
  fmt(mins) { if (mins == null) return ''; mins = ((mins % 1440) + 1440) % 1440; let h = Math.floor(mins / 60); const m = mins % 60; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')}`; },
  // acts in stage order; each { name, songs, actual: { start, end } }
  plan(g) {
    const start = this.parse(g.times && g.times.start), gap = +(g.times && g.times.gap) || 30;
    if (start == null) return null;
    let t = start;
    return g.acts.map((a) => {
      const songs = (a.result && a.result.median) || (a.headliner ? 18 : 9);
      const len = Math.round(songs * 4.2 + (a.headliner ? 8 : 3));
      const real = (g.times.actual || {})[a.name] || {};
      const s = this.parse(real.start), e = this.parse(real.end);
      const from = s != null ? s : t, to = e != null ? e : from + len;
      t = to + gap;
      return { name: a.name, from, to, real: s != null };
    });
  },
};

/* ================= Study guides (saved and synced as "guides") ================= */
const Study = {
  list() { return Store.get('guides', []); },
  get(id) { return this.list().find((g) => g.id === id) || null; },
  put(g) { g.edited = Date.now(); const l = this.list().filter((x) => x.id !== g.id); l.push(g); l.sort((a, b) => String(a.date).localeCompare(String(b.date))); Store.set('guides', l); return g; },
  remove(id) { Store.set('guides', this.list().filter((g) => g.id !== id)); },
  today() { return new Date().toLocaleDateString('en-CA'); },
  tileText() {
    const next = this.list().find((g) => g.date >= this.today());
    return next ? `Next: ${next.artist} · ${this.fmt(next.date).replace(/, \d{4}$/, '')}` : 'Prep for your next show';
  },
  fmt(d) { return Diary.fmtDate(d); },
  headliner(g) { return g.acts.find((a) => a.headliner) || g.acts[g.acts.length - 1]; },
  create(artist, mbid, date) {
    return this.put({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), artist, mbid, date, venue: '', city: '', n: 15,
      acts: [{ name: artist, mbid, on: true, headliner: true }], times: { doors: '', start: '', gap: 30, age: '', actual: {} }, created: new Date().toISOString() });
  },

  // Ticketmaster (when the relay has its key): venue, lineup, start time, doors and age limit for the night
  async ticketmaster(g) {
    if (!Sync.has('ticketmaster')) return false;
    const next = new Date(Date.parse(g.date) + 86400000 * 1.5).toISOString().slice(0, 10);
    const r = await Sync.req('/ticketmaster/events.json?' + new URLSearchParams({ keyword: g.artist, classificationName: 'music', startDateTime: g.date + 'T00:00:00Z', endDateTime: next + 'T12:00:00Z', size: '20' }));
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const ev = ((j._embedded && j._embedded.events) || []).find((e) => e.dates && e.dates.start && e.dates.start.localDate === g.date);
    if (!ev) return false;
    const v = (ev._embedded && ev._embedded.venues && ev._embedded.venues[0]) || {};
    if (!g.venue) g.venue = v.name || '';
    if (!g.city) g.city = [v.city && v.city.name, v.state && v.state.stateCode].filter(Boolean).join(', ');
    const t = ev.dates.start.localTime;
    if (t && !g.times.start) g.times.start = Timing.fmt(+t.slice(0, 2) * 60 + +t.slice(3, 5)) + (+t.slice(0, 2) >= 12 ? ' pm' : ' am');
    const text = [ev.info, ev.pleaseNote].filter(Boolean).join(' ');
    const doors = text.match(/doors?(?: open)?(?: at)?:?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m)\b/i) || (ev.doorsTimes && ev.doorsTimes.localTime ? [0, ev.doorsTimes.localTime.slice(0, 5)] : null);
    if (doors && !g.times.doors) g.times.doors = doors[1];
    if (ev.ageRestrictions && ev.ageRestrictions.legalAgeEnforced && !g.times.age) g.times.age = 'Age limit applies (check the ticket)';
    const age = text.match(/\b(all ages|\d{2}\+|\d{2} and over)\b/i);
    if (age && !g.times.age) g.times.age = age[1];
    const names = ((ev._embedded && ev._embedded.attractions) || []).map((a) => a.name).filter((n) => n && sim(n, g.artist) < 0.8);
    // Billing order lists the special guest first; the last-billed act usually plays first
    names.reverse().forEach((n) => { if (!g.acts.some((a) => sim(a.name, n) >= 0.8)) g.acts.splice(g.acts.length - 1, 0, { name: n, mbid: '', on: false }); });
    g.tm = { id: ev.id, url: ev.url || '', name: ev.name || '' };
    return true;
  },

  // Pull each studied act's recent shows and work out the likely set
  async build(g, say = () => {}) {
    for (const a of g.acts) {
      if (!a.on) continue;
      if (!a.mbid) { const f = await SetlistFM.findArtist(a.name); if (f) { a.mbid = f.mbid; } else { a.result = { error: `Couldn't find ${a.name} on setlist.fm.` }; continue; } }
      say(`Reading ${a.name}'s recent setlists…`);
      const before = g.date && g.date <= this.today() ? g.date : '';
      const shows = await SetlistFM.recent(a.mbid, before, g.n || 15, (n) => say(`Reading ${a.name}'s setlists… ${n}`));
      if (!shows.length) { a.result = { error: `setlist.fm has no setlists for ${a.name} yet.`, songs: [], shows: [] }; continue; }
      const old = a.result && a.result.songs ? new Map(a.result.songs.map((x) => [sk(x.t), x.on])) : null;
      const res = Predict.build(shows, g.date);
      if (res.low && a.mbid) { say(`Checking ${a.name}'s newest album…`); res.songs = res.songs.concat(await Predict.debuts(a, res)); }
      if (old) res.songs.forEach((x) => { if (old.has(sk(x.t))) x.on = old.get(sk(x.t)); });   // keep the ticks you changed
      res.built = new Date().toISOString();
      a.result = res;
    }
    g.built = new Date().toISOString();
    this.put(g);
  },
  // The songs to study, in show order: openers first, then the headliner
  picked(g) {
    const out = [];
    g.acts.forEach((a) => { if (a.on && a.result && a.result.songs) this.order(a.result).forEach((x) => { if (x.on) out.push({ a: a.name, t: x.t }); }); });
    return out;
  },
  // likely set and swap slots in their spot, then debuts, then might play, then rare
  order(res) {
    const rank = { likely: 0, swap: 0, debut: 1, might: 2, rare: 3 };
    return res.songs.slice().sort((a, b) => rank[a.kind] - rank[b.kind] || a.pos - b.pos);
  },
  predicted(res) { return this.order(res).filter((x) => x.kind === 'likely' || x.kind === 'swap').map((x) => x.t); },

  // After the show: fetch what was really played and score the guide
  async check(g) {
    if (!g.date || g.date >= this.today() || g.scoredAll) return false;
    let changed = false;
    g.actual = g.actual || {};
    g.score = g.score || {};
    for (const a of g.acts) {
      if (g.actual[a.name] || !a.mbid) continue;
      const r = await SetlistFM.search({ artistMbid: a.mbid, date: SetlistFM.sfm(g.date) }, 1).catch(() => ({ list: [] }));
      const s = r.list.find((x) => x.songs.length);
      if (!s) continue;
      g.actual[a.name] = { id: s.id, url: s.url, venue: s.venue, city: s.city, sets: s.sets, songs: s.songs.map((x) => x.t) };
      if (!g.venue) g.venue = s.venue;
      if (!g.city) g.city = s.city;
      if (a.on && a.result && a.result.songs) g.score[a.name] = Object.assign(Predict.score(this.predicted(a.result), g.actual[a.name].songs), { at: new Date().toISOString(), shows: a.result.shows.length });
      changed = true;
    }
    if (g.acts.every((a) => g.actual[a.name] || !a.on)) g.scoredAll = true;
    if (changed) this.put(g);
    return changed;
  },
  hitRate() {
    let hits = 0, played = 0, n = 0;
    this.list().forEach((g) => Object.values(g.score || {}).forEach((s) => { hits += s.hits; played += s.played; n++; }));
    return n ? { pct: Math.round((hits / Math.max(1, played)) * 100), hits, played, n } : null;
  },
  exportLog() {
    const guides = this.list().filter((g) => g.score && Object.keys(g.score).length).map((g) => ({
      artist: g.artist, date: g.date, venue: g.venue, showsCounted: g.n,
      acts: g.acts.filter((a) => a.on && a.result && a.result.songs).map((a) => ({ name: a.name, tour: a.result.tour, setChanged: a.result.changed, lowConfidence: a.result.low,
        shows: a.result.shows, predicted: a.result.songs.map((x) => ({ t: x.t, kind: x.kind, pct: Math.round(x.pct * 100), last3: x.last3, on: x.on })),
        actual: (g.actual || {})[a.name] ? g.actual[a.name].songs : null, score: (g.score || {})[a.name] || null })),
    }));
    const blob = new Blob([JSON.stringify({ app: 'Mixtape', kind: 'accuracy log', version: APP_VERSION, savedAt: new Date().toISOString(), weights: { tour: 1, oneOff: 0.5, earlierTour: '0 / 0.25 / 0.6', festivalOrShort: 0.5, recencyDecay: 0.88, setChange: 0.25 }, guides }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mixtape-accuracy-log-${this.today()}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast(guides.length ? `Accuracy log made (${guides.length} show${guides.length === 1 ? '' : 's'})` : 'No scored guides yet; the file is empty');
  },

  // A guide's playlist: make it, or update it when the guide changes
  makePlaylist(g) {
    const songs = this.picked(g);
    if (!songs.length) { toast('Tick some songs first'); return; }
    const mix = g.mixId && Builder.get(g.mixId);
    if (!mix) {
      const m = Builder.create(`${g.artist} · ${this.fmt(g.date).replace(/, \d{4}$/, '')} study`);
      Builder.addTo(m, songs);
      g.mixId = m.id;
      this.put(g);
      toast('Playlist made');
      go('#builder?mix=' + m.id);
      return;
    }
    const have = new Map(mix.songs.map((s) => [songKey(s.a, s.t), s]));
    const want = new Set(songs.map((s) => songKey(s.a, s.t)));
    const add = songs.filter((s) => !have.has(songKey(s.a, s.t)));
    const drop = mix.songs.filter((s) => !want.has(songKey(s.a, s.t)));
    const saved = mix.saved && Google.on();
    Sheets.open({
      title: 'Update the playlist',
      html: `<p style="margin-top:0">Since <b>${esc(mix.name)}</b> was made: <b>${add.length}</b> new song${add.length === 1 ? '' : 's'}, <b>${drop.length}</b> no longer in the guide.</p>
        ${add.length ? `<h3>New</h3><div class="rows">${add.map((s) => `<div class="rowbtn"><span>${esc(s.t)}</span><span class="muted small">${esc(s.a)}</span></div>`).join('')}</div>` : ''}
        ${drop.length ? `<h3>Dropped from the guide</h3><div class="rows">${drop.map((s) => `<div class="rowbtn"><span>${esc(s.t)}</span><span class="muted small">${esc(s.a)}</span></div>`).join('')}</div>` : ''}
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:16px">
          <button class="btn primary" data-u="add" ${add.length ? '' : 'disabled'}>Add new songs only<span class="muted small" style="color:inherit; opacity:.8">&nbsp;· keeps everything</span></button>
          <button class="btn" data-u="match">Match the new guide<span class="muted small">&nbsp;· adds, removes, reorders</span></button>
          <button class="btn" data-u="new">Save as a new playlist</button>
        </div>
        ${mix.saved ? `<p class="muted small">${saved ? 'The changes go to YouTube Music too.' : 'Sign in with Google to send the changes to YouTube Music.'}</p>` : ''}`,
      onMount: (body, close) => {
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-u]');
          if (!b) return;
          const k = b.dataset.u;
          if (k === 'add') {
            // each new song goes in after the song before it in the guide
            const order = songs.map((s) => songKey(s.a, s.t));
            add.forEach((s) => {
              const i = order.indexOf(songKey(s.a, s.t));
              let at = mix.songs.length;
              for (let p = i - 1; p >= 0; p--) { const q = mix.songs.findIndex((x) => songKey(x.a, x.t) === order[p]); if (q >= 0) { at = q + 1; break; } }
              mix.next = (mix.next || mix.songs.length) + 1;
              mix.songs.splice(at, 0, { a: s.a, t: s.t, v: '', n: mix.next });
            });
            Builder.put(mix);
            close();
            if (saved) Job.start(mix);
            toast(`Added ${add.length} song${add.length === 1 ? '' : 's'}`);
          }
          if (k === 'match') {
            mix.songs = songs.map((s, i) => Object.assign({ v: '' }, have.get(songKey(s.a, s.t)) || {}, { a: s.a, t: s.t, n: i + 1 }));
            mix.next = mix.songs.length;
            Builder.put(mix);
            close();
            if (saved) Job.begin({ kind: 'match', name: mix.name, playlistId: mix.saved.id, songs: mix.songs.map((s) => ({ a: s.a, t: s.t, v: s.v || '' })), clean: !!mix.clean, total: null, missing: [] });
            toast('Playlist matches the guide');
          }
          if (k === 'new') {
            const m = Builder.create(`${g.artist} · ${this.fmt(g.date).replace(/, \d{4}$/, '')} study (new)`);
            Builder.addTo(m, songs);
            g.mixId = m.id;
            this.put(g);
            close();
            go('#builder?mix=' + m.id);
          }
          if (currentView === Views.study && Views.study.redraw) Views.study.redraw();
        });
      },
    });
  },

  // A finished show goes into the Concert Diary with its real setlists
  toDiary(g) {
    const e = (g.diaryId && Diary.get(g.diaryId)) || { id: Diary.newId(), rating: 0, notes: '', added: new Date().toISOString() };
    const head = this.headliner(g);
    e.artist = head.name;
    e.with = g.acts.filter((a) => a !== head).map((a) => a.name);
    e.date = g.date; e.venue = g.venue || e.venue || ''; e.city = g.city || e.city || '';
    e.sets = g.acts.map((a) => ({ act: a.name, songs: (g.actual && g.actual[a.name] && g.actual[a.name].songs) || [] })).filter((s) => s.songs.length);
    const sc = (g.score || {})[head.name];
    if (sc && !/Study guide got/.test(e.notes || '')) e.notes = ((e.notes || '') + `\nStudy guide got ${sc.hits} of the ${sc.played} songs played.`).trim();
    Diary.put(e);
    g.diaryId = e.id;
    this.put(g);
    toast('Added to the Concert Diary');
  },
};

/* ================= A single setlist ================= */
function openSetlist(s) {
  let num = 0;
  Sheets.open({
    title: Study.fmt(s.date),
    card: true,
    html: `<div class="card-body">
      <div class="hero-name"><button class="tap link-plain" ${Cards.attrs('artist', { name: s.artist, mbid: s.mbid })}>${esc(s.artist)}</button></div>
      <div class="hero-meta">${esc([s.venue, s.city].filter(Boolean).join(' · '))}</div>
      ${s.tour ? `<div class="hero-meta">Tour: ${esc(s.tour)}</div>` : ''}
      ${s.sets.map((set) => `<h3>${esc(set.name || 'Set')}${set.encore ? '' : ''}</h3>
        <div class="rows">${set.songs.map((x) => x.tape ? `<div class="rowbtn"><span class="muted"><span class="num">♪</span>${esc(x.t)} (tape)</span></div>`
          : `<button class="rowbtn" ${Cards.attrs('song', { artist: x.cover || s.artist, title: x.t })}><span><span class="num">${++num}</span>${esc(x.t)}${x.cover ? `<span class="muted small"> · ${esc(x.cover)} cover</span>` : ''}${x.with ? `<span class="muted small"> · with ${esc(x.with)}</span>` : ''}${x.info ? `<span class="muted small"> · ${esc(x.info)}</span>` : ''}</span></button>`).join('')}</div>`).join('') || '<p class="muted">No songs listed for this show.</p>'}
      ${s.info ? `<p class="muted small">${esc(s.info)}</p>` : ''}
      <div class="card-actions">
        ${s.songs.length ? `<button class="btn small primary" data-l="play">${ICON.play} Play</button><button class="btn small" data-l="mix">+ Playlist</button>` : ''}
        <button class="btn small" data-l="diary">I was there</button>
        <button class="btn small" data-l="open">${ICON.out} Open on setlist.fm</button>
      </div></div>`,
    onMount(body) {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-l]');
        if (!b) return;
        if (b.dataset.l === 'open') window.open(SetlistFM.url(s), '_blank');
        if (b.dataset.l === 'play') Music.play(s.songs.map((x) => ({ a: s.artist, t: x.t })), 0, { name: `${s.artist} · ${Study.fmt(s.date)}` });
        if (b.dataset.l === 'mix') Builder.chooseMix((mix) => { const n = Builder.addTo(mix, s.songs.map((x) => ({ a: s.artist, t: x.t }))); toast(`Added ${n} song${n === 1 ? '' : 's'} to ${mix.name}`); });
        if (b.dataset.l === 'diary') {
          const old = Diary.list().find((d) => d.date === s.date && (sim(d.artist, s.artist) >= 0.8 || (d.with || []).some((w) => sim(w, s.artist) >= 0.8)));
          const e2 = old || { id: Diary.newId(), artist: s.artist, with: [], date: s.date, venue: s.venue, city: s.city, rating: 0, notes: '', sets: [], added: new Date().toISOString() };
          e2.sets = (e2.sets || []).filter((x) => sim(x.act, s.artist) < 0.8).concat([{ act: s.artist, songs: s.songs.map((x) => x.t) }]);
          if (old && sim(old.artist, s.artist) < 0.8 && !(old.with || []).some((w) => sim(w, s.artist) >= 0.8)) old.with = (old.with || []).concat(s.artist);
          Diary.put(e2);
          toast(old ? 'Setlist added to that show in the diary' : 'Added to the Concert Diary');
        }
      });
    },
  });
}
// A list of shows (search results or an artist's setlists) with More
function showRows(list) {
  return list.map((s, i) => `<button class="diary-row" data-sl="${i}"><span class="dd"><b>${esc(Study.fmt(s.date).replace(/, \d{4}$/, ''))}</b><br><span class="muted">${esc(s.date.slice(0, 4))}</span></span>
    <span class="main"><span class="n">${esc(s.artist)}</span><span class="c">${esc([s.venue, s.city].filter(Boolean).join(' · '))}${s.songs.length ? ` · ${s.songs.length} songs` : ' · no songs yet'}</span>${s.tour ? `<span class="c">${esc(s.tour)}</span>` : ''}</span>${ICON.chev}</button>`).join('');
}
function openArtistSetlists(name, mbid) {
  Sheets.open({
    title: `${name} setlists`,
    html: '<div data-a="list"><p class="muted">Loading…</p></div><div data-a="more"></div>',
    onMount: async (body) => {
      let page = 1, all = [], art = null, total = 0;
      const draw = () => {
        body.querySelector('[data-a=list]').innerHTML = all.length ? `<div class="my-list" style="margin:0">${showRows(all)}</div>` : '<p class="muted">No setlists on setlist.fm yet.</p>';
        body.querySelector('[data-a=more]').innerHTML = all.length < total ? '<button class="btn small wide" style="margin-top:12px" data-a="next">Older shows</button>' : '';
      };
      const load = async () => { const r = await SetlistFM.artistSetlists(art.mbid, page); all = all.concat(r.list); total = r.total; draw(); };
      body.addEventListener('click', async (e) => {
        const r = e.target.closest('[data-sl]');
        if (r) openSetlist(all[+r.dataset.sl]);
        if (e.target.closest('[data-a=next]')) { page++; await load().catch((err) => Errors.show(err.message || String(err))); }
      });
      try {
        art = await SetlistFM.findArtist(name, mbid);
        if (!art) { body.querySelector('[data-a=list]').innerHTML = `<p class="muted">Couldn't find ${esc(name)} on setlist.fm.</p>`; return; }
        await load();
      } catch (e) { body.querySelector('[data-a=list]').innerHTML = `<p class="muted">${esc(e.message || e)}</p>`; }
    },
  });
}
// "Played at X of the last N shows" on a song card
async function songTourLine(artist, title) {
  if (!SetlistFM.ready()) return '';
  const art = await SetlistFM.findArtist(artist).catch(() => null);
  if (!art) return '';
  const shows = await SetlistFM.recent(art.mbid, '', 15).catch(() => []);
  if (!shows.length) return '';
  const n = shows.filter((s) => s.songs.some((x) => sk(x.t) === sk(title))).length;
  return `Played at ${n} of ${art.name}'s last ${shows.length} shows (setlist.fm)`;
}

/* ================= The Setlist Study Guide screens ================= */
function studyRow(x, ai, si, act) {
  const bits = [];
  if (x.kind === 'debut') bits.push(`likely debut${x.album ? ' · ' + x.album : ''}`);
  else { bits.push(`${Math.round(x.pct * 100)}%`); if (x.of3) bits.push(`${x.last3} of last ${x.of3}`); }
  if (x.encore) bits.push('encore');
  if (x.cover) bits.push(`${x.cover} cover`);
  return `<div class="check ${x.on ? 'on' : ''}">
    <button class="box-btn" data-g="tick" data-a="${ai}" data-s="${si}" aria-label="Study ${esc(x.t)}"><span class="box">${ICON.check}</span></button>
    <button class="main tapcard" ${Cards.attrs('song', { artist: x.cover || act, title: x.t })}><span class="n">${esc(x.t)}</span><span class="c">${esc(bits.join(' · '))}</span></button></div>`;
}
Views.study = {
  gid() { const m = (location.hash || '').match(/[?&]g=([^&]+)/); return m ? decodeURIComponent(m[1]) : ''; },
  html() {
    return `<div class="screen">
      <header class="topbar">
        <button class="icon-btn" data-g="back" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>${this.gid() ? 'Study guide' : 'Setlist Study Guide'}</h1></div>
        <button class="icon-btn" data-g="help" aria-label="Help">?</button>
      </header>
      <div data-g="body"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const id = this.gid();
    if (id && !Study.get(id)) { go('#study'); return; }
    this.el = el;
    el.querySelector('[data-g=back]').onclick = () => go(id ? '#study' : '#home');
    el.querySelector('[data-g=help]').onclick = () => showHelp('study');
    if (id) this.guide(el, id); else this.home(el);
    firstVisit('study');
  },

  /* ---- the section's front page ---- */
  home(el) {
    const body = el.querySelector('[data-g=body]');
    const today = Study.today();
    let pick = null, lookup = { list: [], total: 0, page: 1, params: null }, timer = null, seq = 0, found = [];
    const draw = () => {
      const all = Study.list(), up = all.filter((g) => g.date >= today), past = all.filter((g) => g.date < today).reverse();
      const hr = Study.hitRate();
      const row = (g) => { const sc = (g.score || {})[Study.headliner(g).name]; return `<button class="diary-row" data-g="open" data-id="${esc(g.id)}"><span class="dd"><b>${esc(Study.fmt(g.date).replace(/, \d{4}$/, ''))}</b><br><span class="muted">${esc(String(g.date).slice(0, 4))}</span></span>
        <span class="main"><span class="n">${esc(g.artist)}${g.acts.length > 1 ? `<span class="muted"> + ${esc(g.acts.filter((a) => !a.headliner).map((a) => a.name).join(', '))}</span>` : ''}</span>
        <span class="c">${esc([g.venue, g.city].filter(Boolean).join(' · ') || 'Venue not set')}${sc ? ` · got ${sc.hits} of ${sc.played}` : ''}</span></span>${ICON.chev}</button>`; };
      body.innerHTML = `${SetlistFM.ready() ? '' : `<div class="note-card"><b>setlist.fm isn't connected yet.</b><span>The relay needs a free setlist.fm key (SETLISTFM_KEY). Until then, guides and lookups can't load.</span><button class="btn small" data-g="ping">Check again</button></div>`}
        ${hr ? `<div class="note-card"><b>Guides got ${hr.pct}% of the songs played</b><span>${hr.hits} of ${hr.played} songs across ${hr.n} set${hr.n === 1 ? '' : 's'}. Settings → More → Export accuracy log to tune it with Claude.</span></div>` : ''}
        <div class="list-h">New study guide</div>
        <div class="pad" style="display:flex; flex-direction:column; gap:8px; margin-top:8px">
          <input class="search" data-g="art" placeholder="Who are you seeing?" value="${esc(pick ? pick.name : '')}" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="ares" data-g="ares"></div>
          ${pick ? '' : (MyArtists.list().length ? `<div class="chips">${MyArtists.list().slice(0, 12).map((a, i) => `<button class="chip" data-g="my" data-i="${i}">${esc(a.name)}</button>`).join('')}</div>` : '')}
          <label class="flabel" style="margin-top:0">Show date<input class="field" type="date" data-g="date" value="${esc(this.date || '')}"></label>
          <button class="btn primary wide" data-g="new" ${pick ? '' : 'disabled'}>Build the guide</button>
        </div>
        ${up.length ? `<div class="list-h">Coming up</div><div class="my-list">${up.map(row).join('')}</div>` : ''}
        ${past.length ? `<div class="list-h">Past shows</div><div class="my-list">${past.map(row).join('')}</div>` : ''}
        <div class="list-h">Look up a setlist</div>
        <div class="pad" style="display:flex; flex-direction:column; gap:8px; margin-top:8px">
          <input class="field" data-q="artistName" placeholder="Artist" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="row" style="gap:8px"><input class="field" type="date" data-q="date" style="flex:1"><input class="field" data-q="year" placeholder="or a year" inputmode="numeric" style="flex:1"></div>
          <div class="row" style="gap:8px"><input class="field" data-q="venueName" placeholder="Venue" autocomplete="off" spellcheck="false" style="flex:1"><input class="field" data-q="cityName" placeholder="City" autocomplete="off" spellcheck="false" style="flex:1"></div>
          <button class="btn wide" data-g="find">Search setlist.fm</button>
        </div>
        <div data-g="results"></div>`;
      drawResults();
    };
    const drawResults = () => {
      const box = body.querySelector('[data-g=results]');
      if (!box || !lookup.params) return;
      box.innerHTML = lookup.list.length ? `<div class="my-list">${showRows(lookup.list)}</div>${lookup.list.length < lookup.total ? '<div class="pad"><button class="btn small wide" style="margin-top:10px" data-g="more">More</button></div>' : ''}`
        : '<p class="muted pad">No setlists found. Try fewer details.</p>';
    };
    draw();
    this.redraw = draw;
    body.addEventListener('input', (e) => {
      if (e.target.dataset.g === 'date') this.date = e.target.value;
      if (e.target.dataset.g !== 'art') return;
      pick = null;
      body.querySelector('[data-g=new]').disabled = true;
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (!q) { body.querySelector('[data-g=ares]').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          found = await SetlistFM.searchArtists(q);
          if (my !== seq) return;
          body.querySelector('[data-g=ares]').innerHTML = found.map((a, i) => `<button class="rowbtn" data-g="pick" data-i="${i}"><span>${esc(a.name)}</span><span class="muted small">${esc(a.dis)}</span></button>`).join('') || '<p class="muted small">No artists found.</p>';
        } catch (err) { Errors.show(err.message || String(err)); }
      }, 350);
    });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-g],[data-sl]');
      if (!b) return;
      if (b.dataset.sl != null) { openSetlist(lookup.list[+b.dataset.sl]); return; }
      const k = b.dataset.g;
      try {
        if (k === 'pick') { pick = found[+b.dataset.i]; draw(); }
        if (k === 'my') { const a = MyArtists.list()[+b.dataset.i]; pick = { name: a.name, mbid: a.mbid || '' }; draw(); }
        if (k === 'open') go('#study?g=' + b.dataset.id);
        if (k === 'ping') { b.disabled = true; await Sync.ping(); draw(); }
        if (k === 'new') {
          const date = body.querySelector('[data-g=date]').value;
          if (!date) { toast('Pick the show date'); return; }
          const g = Study.create(pick.name, pick.mbid, date);
          this.date = '';
          go('#study?g=' + g.id + '&build=1');
        }
        if (k === 'find' || k === 'more') {
          if (k === 'find') {
            const p = {};
            body.querySelectorAll('[data-q]').forEach((i) => { if (i.value.trim()) p[i.dataset.q] = i.dataset.q === 'date' ? SetlistFM.sfm(i.value) : i.value.trim(); });
            if (!Object.keys(p).length) { toast('Type an artist, venue or city'); return; }
            lookup = { list: [], total: 0, page: 1, params: p };
          } else lookup.page++;
          b.disabled = true;
          const r = await SetlistFM.search(lookup.params, lookup.page);
          lookup.list = lookup.list.concat(r.list); lookup.total = r.total;
          b.disabled = false;
          drawResults();
        }
      } catch (err) { b.disabled = false; Errors.show(err.message || String(err), err instanceof ApiError ? '' : err); }
    });
  },

  /* ---- one guide ---- */
  guide(el, id) {
    const body = el.querySelector('[data-g=body]');
    let busy = '';
    const draw = () => {
      const g = Study.get(id);
      if (!g) return;
      const plan = Timing.plan(g);
      const past = g.date < Study.today();
      const mix = g.mixId && Builder.get(g.mixId);
      const n = Study.picked(g).length;
      const tl = [g.times.doors ? `Doors ${esc(g.times.doors)}` : '']
        .concat(plan ? plan.map((p) => `${esc(p.name)} ${p.real ? '' : '~'}${Timing.fmt(p.from)}–${Timing.fmt(p.to)}`) : []).filter(Boolean).join(' · ');
      body.innerHTML = `<div class="pad" style="margin-top:4px">
          <div style="font-family: var(--display); font-weight: 700; font-size: 24px"><button class="tap link-plain" ${Cards.attrs('artist', { name: g.artist, mbid: g.mbid })}>${esc(g.artist)}</button></div>
          <div class="muted">${esc([Study.fmt(g.date), g.venue, g.city].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="note-card"><b>${plan ? 'Show times' : 'Stage times'}</b>
          <span>${tl || 'Add the start time (and doors if you know them) to see estimated stage times.'}${plan && !plan.every((p) => p.real) ? '<br>~ = estimate from recent set lengths, with ' + (+g.times.gap || 30) + ' minutes between sets.' : ''}${g.times.age ? '<br>' + esc(g.times.age) : ''}</span>
          <span class="row"><button class="btn small" data-g="times">Edit times</button>${Sync.has('ticketmaster') ? '<button class="btn small" data-g="tm">Find on Ticketmaster</button>' : ''}</span></div>
        <div class="list-h">Who's playing (in stage order)</div>
        <div class="list">${g.acts.map((a, i) => `<div class="li"><span>${esc(a.name)}<div class="sub">${a.headliner ? 'Headliner' : 'Opener'}${a.result && a.result.shows ? ` · ${a.result.shows.length} shows read` : ''}</div></span>
            <span class="row" style="align-items:center; gap:6px">${a.headliner ? '' : `<button class="icon-btn sm" data-g="actdel" data-i="${i}" aria-label="Remove ${esc(a.name)}">${ICON.close}</button>`}
            <label class="switch"><input type="checkbox" data-g="acton" data-i="${i}" ${a.on ? 'checked' : ''}><span></span></label></span></div>`).join('')}
          <button class="li" data-g="actadd" style="color: var(--accent); font-weight:600">+ Add an opener</button></div>
        <div class="pad row" style="align-items:center; justify-content:space-between; margin-top:12px; gap:10px">
          <span class="muted small">Recent shows counted: <b>${g.n || 15}</b></span>
          <span class="row" style="gap:6px"><button class="icon-btn sm" data-g="nminus" aria-label="Fewer">−</button><button class="icon-btn sm" data-g="nplus" aria-label="More">+</button>
          <button class="btn small" data-g="build" ${busy ? 'disabled' : ''}>${g.built ? 'Rebuild' : 'Build'}</button></span></div>
        ${busy ? `<p class="pad muted small" data-g="status">${esc(busy)}</p>` : g.built ? `<p class="pad muted small">Built ${esc(new Date(g.built).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}. Rebuild closer to the show for the newest setlists.</p>` : ''}
        ${g.acts.map((a, ai) => this.actSection(g, a, ai)).join('')}
        ${past ? this.actualSection(g) : ''}
        <div class="org-actions">
          <button class="btn primary wide" data-g="mix" ${n ? '' : 'disabled'}>${mix ? `Update the playlist (${n} songs)` : `Make playlist (${n} songs)`}</button>
          <span class="row" style="justify-content:center; gap:18px; margin-top:6px">${n ? '<button class="link-btn" data-g="play">Play the study list</button>' : ''}${mix ? '<button class="link-btn" data-g="openmix">Open it in Playlist Builder</button>' : ''}</span>
        </div>
        <div class="pad" style="display:flex; flex-direction:column; align-items:center; gap:4px; margin-top:8px">
          ${past && g.actual && Object.keys(g.actual).length ? `<button class="btn small" data-g="diary">${g.diaryId ? 'Update the diary entry' : 'Add to Concert Diary'}</button>` : ''}
          <button class="link-btn" data-g="delete">Delete this guide</button></div>`;
    };
    this.redraw = draw;
    const build = async (withTm) => {
      const g = Study.get(id);
      busy = 'Starting…'; draw();
      const say = (t) => { busy = t; const s = body.querySelector('[data-g=status]'); if (s) s.textContent = t; };
      try {
        if (withTm) { say('Looking for the show on Ticketmaster…'); await Study.ticketmaster(g).catch(() => false); Study.put(g); }
        await Study.build(g, say);
        busy = '';
        if (g.date < Study.today()) await Study.check(g).catch(() => false);
      } catch (e) { busy = ''; Errors.show(e.message || String(e), e instanceof ApiError ? '' : e); }
      if (currentView === Views.study && this.el === el) draw();
    };
    draw();
    if (/[?&]build=1/.test(location.hash)) { history.replaceState(null, '', '#study?g=' + id); build(true); }
    else { const g = Study.get(id); if (g.date < Study.today() && !g.scoredAll && SetlistFM.ready()) Study.check(g).then((c) => { if (c && currentView === Views.study && this.el === el) draw(); }).catch(() => {}); }

    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.g === 'acton') { const g = Study.get(id); g.acts[+t.dataset.i].on = t.checked; Study.put(g); if (t.checked && !g.acts[+t.dataset.i].result) build(false); else draw(); }
    });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-g]');
      if (!b || b.tagName === 'INPUT' || b.tagName === 'LABEL') return;
      const k = b.dataset.g, g = Study.get(id);
      try {
        if (k === 'tick') { const x = g.acts[+b.dataset.a].result.songs[+b.dataset.s]; x.on = !x.on; Study.put(g); draw(); }
        if (k === 'build') build(false);
        if (k === 'tm') { b.disabled = true; const ok = await Study.ticketmaster(g); Study.put(g); toast(ok ? 'Filled in from Ticketmaster' : 'Ticketmaster has no listing for that date'); draw(); }
        if (k === 'nminus' || k === 'nplus') { g.n = Math.max(5, Math.min(40, (g.n || 15) + (k === 'nplus' ? 5 : -5))); Study.put(g); draw(); }
        if (k === 'actdel') { g.acts.splice(+b.dataset.i, 1); Study.put(g); draw(); }
        if (k === 'actadd') this.addAct(id, draw);
        if (k === 'times') this.editTimes(id, draw);
        if (k === 'mix') Study.makePlaylist(g);
        if (k === 'openmix') go('#builder?mix=' + g.mixId);
        if (k === 'play') { const m = g.mixId && Builder.get(g.mixId); Music.play(Study.picked(g), 0, { name: `${g.artist} study list`, playlist: m && m.saved && m.saved.id }); }
        if (k === 'diary') { Study.toDiary(g); draw(); }
        if (k === 'shows') { const a = g.acts[+b.dataset.a]; openArtistSetlists(a.name, a.mbid); }
        if (k === 'show') { const r = await SetlistFM.search({ artistMbid: g.acts[+b.dataset.a].mbid, date: SetlistFM.sfm(b.dataset.date) }); const s = r.list.find((x) => x.id === b.dataset.id) || r.list[0]; if (s) openSetlist(s); }
        if (k === 'real') { const a = g.actual[b.dataset.name]; if (a) window.open(a.url || SetlistFM.url({ artist: b.dataset.name, date: g.date, venue: g.venue }), '_blank'); }
        if (k === 'delete' && confirm(`Delete the study guide for ${g.artist}?${g.mixId ? ' Its playlist stays.' : ''}`)) { Study.remove(id); go('#study'); }
      } catch (err) { b.disabled = false; Errors.show(err.message || String(err), err instanceof ApiError ? '' : err); }
    });
  },
  actSection(g, a, ai) {
    if (!a.on) return '';
    const r = a.result;
    if (!r) return `<div class="list-h">${esc(a.name)}</div><p class="pad muted small">Tap Build to read ${esc(a.name)}'s recent setlists.</p>`;
    if (r.error) return `<div class="list-h">${esc(a.name)}</div><p class="pad muted small">${esc(r.error)}</p>`;
    const songs = r.songs.map((x, si) => ({ x, si }));
    const order = Study.order(r).map((x) => songs.find((s) => s.x === x));
    const sect = (kind) => order.filter((s) => s.x.kind === kind);
    const main = order.filter((s) => s.x.kind === 'likely' || s.x.kind === 'swap');
    let lastPair = -1;
    const mainRows = main.map((s) => {
      if (s.x.kind !== 'swap') return studyRow(s.x, ai, s.si, a.name);
      if (s.x.pair === lastPair) return '';
      lastPair = s.x.pair;
      const both = main.filter((y) => y.x.kind === 'swap' && y.x.pair === s.x.pair);
      return `<div class="swapbox"><div class="muted small">Swap slot: one or the other most nights</div>${both.map((y) => studyRow(y.x, ai, y.si, a.name)).join('')}</div>`;
    }).join('');
    const tourShows = r.shows.filter((s) => s.kind.startsWith('tour')).length;
    return `<div class="list-h">${esc(a.name)}${a.headliner ? '' : ' · opener'}</div>
      <div class="pad">
        <p class="muted small" style="margin:6px 0">${r.tour ? `Tour: <b>${esc(r.tour)}</b> · ${tourShows} show${tourShows === 1 ? '' : 's'} on it. ` : ''}About ${r.median} songs a night. % = how often it was played, recent shows counting most.</p>
        ${r.changed ? `<p class="small" style="margin:6px 0; color: var(--accent)">Set changed on ${esc(Study.fmt(r.changed))}. The newer set is used as the likely set.</p>` : ''}
        ${r.low ? '<p class="small" style="margin:6px 0; color: var(--accent)">Low confidence: few shows on this tour yet (or none lately), so this leans on the last tour plus the newest album. Rebuild after a few more shows.</p>' : ''}
        <h3 style="margin:14px 0 2px">Likely set</h3><div class="batch-list">${mainRows || '<p class="muted small">No song was played at most of these shows.</p>'}</div>
        ${sect('debut').length ? `<h3 style="margin:14px 0 2px">Likely debut</h3><div class="batch-list">${sect('debut').map((s) => studyRow(s.x, ai, s.si, a.name)).join('')}</div>` : ''}
        ${sect('might').length ? `<h3 style="margin:14px 0 2px">Might play</h3><div class="batch-list">${sect('might').map((s) => studyRow(s.x, ai, s.si, a.name)).join('')}</div>` : ''}
        ${sect('rare').length ? `<details class="add-pl"><summary>Rare (${sect('rare').length})</summary><div class="batch-list">${sect('rare').map((s) => studyRow(s.x, ai, s.si, a.name)).join('')}</div></details>` : ''}
        <details class="add-pl"><summary>Shows counted (${r.shows.length})</summary><div class="rows">${r.shows.map((s) => `<button class="rowbtn" data-g="show" data-a="${ai}" data-id="${esc(s.id)}" data-date="${esc(s.date)}"><span>${esc(Study.fmt(s.date))}<span class="muted small" style="display:block">${esc([s.venue, s.city].filter(Boolean).join(' · '))}</span></span><span class="muted small">${s.n} songs · ${esc(s.kind)}${s.w ? '' : ' · not counted'}</span></button>`).join('')}</div>
          <button class="link-btn" data-g="shows" data-a="${ai}">All of ${esc(a.name)}'s setlists</button></details>
      </div>`;
  },
  actualSection(g) {
    const acts = g.acts.filter((a) => g.actual && g.actual[a.name]);
    if (!acts.length) return `<div class="list-h">After the show</div><p class="pad muted small">${SetlistFM.ready() ? 'The real setlist shows up here once someone posts it on setlist.fm, and the guide gets scored.' : 'Connect setlist.fm to score this guide.'}</p>`;
    return acts.map((a) => {
      const real = g.actual[a.name], sc = (g.score || {})[a.name];
      const pred = a.result && a.result.songs ? new Set(Study.predicted(a.result).map(sk)) : new Set();
      return `<div class="list-h">What ${esc(a.name)} played</div>
        ${sc ? `<div class="note-card"><b>The guide got ${sc.hits} of ${sc.played} songs (${Math.round((sc.hits / Math.max(1, sc.played)) * 100)}%)</b>
          <span>${sc.order != null ? `Order: ${sc.order}% of pairs in the right order. ` : ''}${sc.wrong.length ? `Predicted but not played: ${esc(sc.wrong.join(', '))}.` : 'Every predicted song was played.'}</span></div>` : ''}
        <div class="pad"><div class="rows">${real.songs.map((t, i) => `<button class="rowbtn" ${Cards.attrs('song', { artist: a.name, title: t })}><span><span class="num">${i + 1}</span>${esc(t)}</span><span class="small" style="color:${pred.has(sk(t)) ? 'var(--accent)' : 'var(--muted)'}">${pred.size ? (pred.has(sk(t)) ? '✓ predicted' : 'missed') : ''}</span></button>`).join('')}</div>
        <button class="link-btn" data-g="real" data-name="${esc(a.name)}">Open on setlist.fm</button></div>`;
    }).join('');
  },
  addAct(id, onDone) {
    Sheets.open({
      title: 'Add an opener',
      html: `<input class="search" data-x="q" placeholder="Search setlist.fm artists" autocomplete="off" autocapitalize="off" spellcheck="false"><div data-x="res"></div>
        <p class="muted small">Add openers in the order they play: the first one added plays first.</p>`,
      onMount: (body, close) => {
        let timer = null, list = [];
        body.querySelector('[data-x=q]').addEventListener('input', (e) => {
          clearTimeout(timer);
          const q = e.target.value.trim();
          timer = setTimeout(async () => {
            if (!q) return;
            try { list = await SetlistFM.searchArtists(q); body.querySelector('[data-x=res]').innerHTML = list.map((a, i) => `<button class="rowbtn" data-x="pick" data-i="${i}"><span>${esc(a.name)}</span><span class="muted small">${esc(a.dis)}</span></button>`).join('') || '<p class="muted small">No artists found.</p>'; }
            catch (err) { Errors.show(err.message || String(err)); }
          }, 350);
        });
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-x=pick]');
          if (!b) return;
          const a = list[+b.dataset.i], g = Study.get(id);
          const head = g.acts.findIndex((x) => x.headliner);
          g.acts.splice(head, 0, { name: a.name, mbid: a.mbid, on: true });
          Study.put(g);
          close();
          onDone();
          toast(`Added ${a.name}. Tap Rebuild to study them.`);
        });
        setTimeout(() => body.querySelector('[data-x=q]').focus(), 350);
      },
    });
  },
  editTimes(id, onDone) {
    const g = Study.get(id);
    Sheets.open({
      title: 'Show details and times',
      html: `<label class="flabel">Date<input class="field" type="date" data-t="date" value="${esc(g.date)}"></label>
        <div class="row" style="gap:8px"><label class="flabel" style="flex:1">Venue<input class="field" data-t="venue" value="${esc(g.venue)}" autocomplete="off"></label><label class="flabel" style="flex:1">City<input class="field" data-t="city" value="${esc(g.city)}" autocomplete="off"></label></div>
        <div class="row" style="gap:8px"><label class="flabel" style="flex:1">Doors<input class="field" data-t="doors" value="${esc(g.times.doors)}" placeholder="6:30 pm"></label><label class="flabel" style="flex:1">Show starts<input class="field" data-t="start" value="${esc(g.times.start)}" placeholder="7:30 pm"></label></div>
        <div class="row" style="gap:8px"><label class="flabel" style="flex:1">Minutes between sets<input class="field" data-t="gap" value="${esc(g.times.gap || 30)}" inputmode="numeric"></label><label class="flabel" style="flex:1">Age limit<input class="field" data-t="age" value="${esc(g.times.age)}" placeholder="All ages, 21+…"></label></div>
        <h3>Real set times (from the venue, on show day)</h3>
        ${g.acts.map((a) => { const r = (g.times.actual || {})[a.name] || {}; return `<div class="row" style="gap:8px; align-items:flex-end"><span style="flex:1.2; padding-bottom:12px; font-weight:600">${esc(a.name)}</span><label class="flabel" style="flex:1">On<input class="field" data-r="${esc(a.name)}" data-w="start" value="${esc(r.start || '')}" placeholder="8:40"></label><label class="flabel" style="flex:1">Off<input class="field" data-r="${esc(a.name)}" data-w="end" value="${esc(r.end || '')}" placeholder="10:15"></label></div>`; }).join('')}
        <p class="muted small">Times like 7:30, 7:30 pm or 19:30 all work. Real times replace the estimates.</p>
        <div class="row sheet-actions"><button class="btn primary wide" data-t="save">Save</button></div>`,
      onMount: (body, close) => {
        body.querySelector('[data-t=save]').onclick = () => {
          const v = (k) => body.querySelector(`[data-t=${k}]`).value.trim();
          g.date = v('date') || g.date; g.venue = v('venue'); g.city = v('city');
          g.times.doors = v('doors'); g.times.start = v('start'); g.times.gap = parseInt(v('gap'), 10) || 30; g.times.age = v('age');
          g.times.actual = {};
          body.querySelectorAll('[data-r]').forEach((i) => { if (i.value.trim()) { (g.times.actual[i.dataset.r] = g.times.actual[i.dataset.r] || {})[i.dataset.w] = i.value.trim(); } });
          Study.put(g);
          close();
          onDone();
        };
      },
    });
  },
};

HELP.study = {
  title: 'Setlist Study Guide',
  html: `<p>Learn the songs before a show, or look up any setlist.</p>
    <ol><li><b>New study guide</b>: pick the artist (search, or tap one of My Artists) and the show date, then <b>Build the guide</b>. With a Ticketmaster key in the relay it also fills in the venue, the openers and the start time.</li>
    <li>Mixtape reads the act's recent setlists on setlist.fm (15 by default; − / + to change, then Rebuild) and works out:
      <ul><li><b>Likely set</b>, in the order of the latest show, with how often each song was played. Shows on the current tour count most, recent shows more than older ones; festival and short sets count less.</li>
      <li><b>Swap slots</b>: two songs that trade the same spot. Both are ticked; untick one to keep just the other.</li>
      <li><b>Might play</b> (rotation) and <b>Rare</b>. Early in a new tour, <b>Likely debut</b> lists songs from the newest album.</li></ul></li>
    <li>Turn openers on in <b>Who's playing</b> to study them too, and add any that are missing.</li>
    <li><b>Make playlist</b> sends the ticked songs to Playlist Builder in show order (openers first). Rebuild later and <b>Update the playlist</b> shows what changed and lets you add the new songs, match the guide, or save a new one.</li>
    <li><b>Edit times</b>: doors, start time and minutes between sets give estimated stage times. Type the real ones on show day.</li></ol>
    <p>After the show, the real setlist appears here once it's on setlist.fm, the guide gets a score, and <b>Add to Concert Diary</b> saves the night with every act's setlist.</p>
    <p><b>Look up a setlist</b> searches setlist.fm by artist, date or year, venue and city.</p>`,
};
