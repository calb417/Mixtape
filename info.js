'use strict';
/* Music data (Last.fm, MusicBrainz, Wikipedia/Wikidata), the song finder, and the
   artist / album / song / person info cards. Needs app.js loaded first. */

function stripHtml(s) {
  const d = document.createElement('div');
  d.innerHTML = String(s || '').replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/i, '');
  return (d.textContent || '').replace(/\s+\n/g, '\n').trim();
}
// "drums (drum set)" → "drums"; leaves out "original", "touring" and the like
function cleanInst(attrs) {
  const out = [];
  (attrs || []).forEach((x) => {
    if (/original|founder|additional|touring|guest|minor|support/i.test(x)) return;
    const v = String(x).replace(/\s*\([^)]*\)/g, '').trim();
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}
function yearsText(m) {
  if (!(m.b < 9999)) return '';
  const end = m.cur ? 'present' : (m.e || '');
  return end === m.b || !end ? String(m.b) : `${m.b}–${end}`;
}
function songKey(a, t) { return norm(a) + '|' + norm(t); }
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function yearOf(d) { const n = parseInt(String(d || '').slice(0, 4), 10); return n > 1800 ? n : 0; }
async function getJSON(url, who) {
  let r;
  try { r = await fetch(url); } catch (e) { throw new ApiError(`Could not reach ${who}. Check the internet connection.`); }
  if (r.status === 404) return null;
  if (!r.ok) throw new ApiError(`${who} error: HTTP ${r.status}`);
  return r.json();
}
// Clean a track title for display and matching ("Song - Remastered 2009" → "Song")
function cleanTitle(t) {
  return String(t || '').replace(/\s+[-–]\s+(\d{4}\s+)?(remaster(ed)?|mono|stereo|single version|album version|radio edit)( \d{4})?( version)?\s*$/i, '')
    .replace(/\s*[\(\[](\d{4}\s+)?remaster(ed)?( \d{4})?( version)?[\)\]]/ig, '').trim();
}
const NOT_STUDIO = /[\(\[\-–]\s*[^\)\]]*\b(live|demo|acoustic|instrumental|karaoke|commentary|interview|rehearsal|outtake|take \d|session|bbc)\b/i;

/* ================= Last.fm ================= */
const LastFM = {
  mem: new Map(),
  key() { return String(CONFIG.LASTFM_API_KEY || '').trim(); },
  ready() { const k = this.key(); return !!k && !k.startsWith('PASTE-'); },
  arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; },
  async call(method, params = {}) {
    if (!this.ready()) throw new ApiError('No Last.fm key yet. Open app.js on GitHub and paste your Last.fm key in the marked spot at the top.');
    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.searchParams.set('method', method);
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
    url.searchParams.set('api_key', this.key());
    url.searchParams.set('format', 'json');
    const ck = url.toString();
    if (this.mem.has(ck)) return this.mem.get(ck);
    const p = (async () => {
      let r;
      try { r = await fetch(ck); } catch (e) { throw new ApiError('Could not reach Last.fm. Check the internet connection and try again.'); }
      const j = await r.json().catch(() => ({}));
      if (j && j.error) {
        if (j.error === 10 || j.error === 26) throw new ApiError('Last.fm says the key is not valid. Check the Last.fm key at the top of app.js.');
        if (j.error === 29) throw new ApiError('Last.fm is busy (too many requests). Wait a minute and try again.');
        if (j.error === 6) return null;
        throw new ApiError('Last.fm error: ' + (j.message || j.error));
      }
      if (!r.ok) throw new ApiError('Last.fm error: HTTP ' + r.status);
      return j;
    })();
    this.mem.set(ck, p);
    p.catch(() => this.mem.delete(ck));
    return p;
  },
  async searchArtists(q) {
    const j = await this.call('artist.search', { artist: q, limit: 10 });
    return this.arr(j && j.results && j.results.artistmatches && j.results.artistmatches.artist)
      .map((a) => ({ name: a.name, mbid: a.mbid || '', listeners: +a.listeners || 0 }));
  },
  // An artist's songs, most played first, with duplicates, live and demo versions removed
  async topTracks(artist) {
    const j = await this.call('artist.getTopTracks', { artist, limit: 400, autocorrect: 1 });
    const seen = new Set(), out = [];
    this.arr(j && j.toptracks && j.toptracks.track).forEach((tr) => {
      if (!tr || !tr.name || NOT_STUDIO.test(tr.name)) return;
      const t = cleanTitle(tr.name), k = norm(t);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ a: (tr.artist && tr.artist.name) || artist, t, n: +tr.listeners || 0 });
    });
    return out;
  },
  async tagTopTracks(tag, pages = 2) {
    const out = [];
    for (let page = 1; page <= pages; page++) {
      const j = await this.call('tag.getTopTracks', { tag, limit: 150, page });
      const list = this.arr(j && j.tracks && j.tracks.track);
      list.forEach((tr) => { if (tr && tr.name && tr.artist) out.push({ a: tr.artist.name, t: cleanTitle(tr.name) }); });
      if (list.length < 150) break;
    }
    return out;
  },
  async tagTopArtists(tag) {
    const j = await this.call('tag.getTopArtists', { tag, limit: 200 });
    return this.arr(j && j.topartists && j.topartists.artist).map((a) => a.name).filter(Boolean);
  },
  async chartTopTracks() {
    const out = [];
    for (let page = 1; page <= 2; page++) {
      const j = await this.call('chart.getTopTracks', { limit: 150, page });
      this.arr(j && j.tracks && j.tracks.track).forEach((tr) => { if (tr && tr.name && tr.artist) out.push({ a: tr.artist.name, t: cleanTitle(tr.name) }); });
    }
    return out;
  },
  async chartTopArtists() {
    const j = await this.call('chart.getTopArtists', { limit: 200 });
    return this.arr(j && j.artists && j.artists.artist).map((a) => a.name).filter(Boolean);
  },
  async artistTags(artist) {
    const cache = Store.get('artistTags', {});
    const k = norm(artist);
    if (cache[k]) return cache[k];
    const j = await this.call('artist.getTopTags', { artist, autocorrect: 1 });
    const tags = this.arr(j && j.toptags && j.toptags.tag).slice(0, 8).map((t) => String(t.name || '').toLowerCase());
    cache[k] = tags;
    const keys = Object.keys(cache);
    if (keys.length > 1500) keys.slice(0, 300).forEach((x) => delete cache[x]);
    Store.set('artistTags', cache, true);
    return tags;
  },
  async artistInfo(artist) {
    const j = await this.call('artist.getInfo', { artist, autocorrect: 1 });
    return j && j.artist;
  },
  async trackInfo(artist, track) {
    const j = await this.call('track.getInfo', { artist, track, autocorrect: 1 });
    return j && j.track;
  },
};

/* ================= MusicBrainz (one request a second, cards go first) ================= */
const MB = {
  queue: [], running: false, last: 0, mem: new Map(),
  q(s) { return '"' + String(s || '').replace(/["\\]/g, ' ') + '"'; },
  get(path, params = {}, prio = 1) {
    const url = new URL('https://musicbrainz.org/ws/2/' + path);
    Object.entries(Object.assign({}, params, { fmt: 'json' })).forEach(([k, v]) => url.searchParams.set(k, v));
    const key = url.toString();
    if (this.mem.has(key)) return this.mem.get(key);
    const p = new Promise((res, rej) => { this.queue.push({ url: key, prio, res, rej }); this.pump(); });
    this.mem.set(key, p);
    p.catch(() => this.mem.delete(key));
    return p;
  },
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      this.queue.sort((a, b) => b.prio - a.prio);
      const job = this.queue.shift();
      const wait = this.last + 1050 - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      try {
        let r;
        try { r = await fetch(job.url); } catch (e) { throw new ApiError('Could not reach MusicBrainz.'); }
        if (r.status === 503) { await sleep(1600); this.last = Date.now(); r = await fetch(job.url); }
        if (r.status === 404 || r.status === 400) { job.res(null); continue; }
        if (!r.ok) throw new ApiError('MusicBrainz error: HTTP ' + r.status);
        job.res(await r.json());
      } catch (e) { job.rej(e); }
    }
    this.running = false;
  },
  credit(ac) { return (ac || []).map((c) => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || '')).join('').trim(); },
  wikidata(rels) {
    const r = (rels || []).find((x) => x.type === 'wikidata' && x.url);
    const m = r && String(r.url.resource || '').match(/Q\d+/);
    return m ? m[0] : '';
  },
  async findArtist(name) {
    const j = await this.get('artist', { query: 'artist:' + this.q(name), limit: 5 });
    const list = (j && j.artists) || [];
    list.sort((a, b) => (b.score || 0) + sim(b.name, name) * 50 - ((a.score || 0) + sim(a.name, name) * 50));
    return list[0] || null;
  },
  async albums(mbid) {
    const j = await this.get('release-group', { artist: mbid, type: 'album', limit: 100 });
    return ((j && j['release-groups']) || [])
      .filter((g) => g['primary-type'] === 'Album' && !(g['secondary-types'] || []).length)
      .map((g) => ({ id: g.id, title: g.title, year: yearOf(g['first-release-date']) }))
      .sort((a, b) => (a.year || 9999) - (b.year || 9999));
  },
  // Track list for an album (release group): the earliest official release
  async albumTracks(rgId, prio = 1) {
    const j = await this.get('release', { 'release-group': rgId, inc: 'recordings+labels', status: 'official', limit: 25 }, prio);
    const rels = ((j && j.releases) || []).filter((r) => (r.media || []).some((m) => (m.tracks || []).length));
    if (!rels.length) return { tracks: [], label: '', date: '' };
    rels.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
    const r = rels[0];
    const tracks = [];
    (r.media || []).forEach((m) => (m.tracks || []).forEach((t) => tracks.push({ t: t.title, len: t.length || (t.recording && t.recording.length) || 0, rec: t.recording && t.recording.id })));
    const li = (r['label-info'] || [])[0];
    return { tracks, label: (li && li.label && li.label.name) || '', date: r.date || '' };
  },
};

/* ================= Wikipedia + Wikidata ================= */
const Wiki = {
  async entities(ids) {
    ids = [...new Set(ids.filter(Boolean))];
    if (!ids.length) return {};
    const out = {};
    for (let i = 0; i < ids.length; i += 45) {
      const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&languages=en&props=labels|claims|sitelinks&ids=' + ids.slice(i, i + 45).join('|');
      const j = await getJSON(url, 'Wikidata');
      Object.assign(out, (j && j.entities) || {});
    }
    return out;
  },
  claim(ent, p) { const c = ent && ent.claims && ent.claims[p] && ent.claims[p][0]; return c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null; },
  claims(ent, p) { return ((ent && ent.claims && ent.claims[p]) || []).map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter(Boolean); },
  label(ent) { return (ent && ent.labels && ent.labels.en && ent.labels.en.value) || ''; },
  enTitle(ent) { return (ent && ent.sitelinks && ent.sitelinks.enwiki && ent.sitelinks.enwiki.title) || ''; },
  image(file, w = 300) { return file ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=' + w : ''; },
  async summary(title) {
    if (!title) return null;
    return getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')), 'Wikipedia');
  },
  async wikitext(title) {
    const j = await getJSON('https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&origin=*&redirects=1&prop=wikitext&page=' + encodeURIComponent(title), 'Wikipedia');
    return (j && j.parse && j.parse.wikitext) || '';
  },
  // Find a song's Wikipedia article: "<title> (… song)" by that artist
  async findSong(title, artist) {
    const j = await getJSON('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=' + encodeURIComponent(`"${title}" ${artist} song`), 'Wikipedia');
    const hits = (j && j.query && j.query.search) || [];
    const t = norm(title);
    const hit = hits.find((h) => norm(h.title.replace(/\s*\(.*\)$/, '')) === t && (/\bsong\b|single/i.test(h.title) || norm(h.snippet).includes(norm(artist))));
    return hit ? hit.title : '';
  },
  // Writers from a song article's infobox
  songwriters(wt) {
    const kv = templateKV(wt, /\{\{\s*Infobox (song|single)/i);
    const raw = [kv.writer, kv.writers, kv.songwriter, kv.songwriters, kv.composer, kv.lyricist].filter(Boolean).join('|');
    if (!raw) return [];
    const v = raw.replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const names = [...v.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].replace(/\s*\(.*\)$/, '').trim());
    v.replace(/\[\[[^\]]*\]\]/g, '|').replace(/\{\{|\}\}|\b(flatlist|hlist|plainlist|ubl|unbulleted list)\b|<br\s*\/?>|\*/gi, '|')
      .split(/[|,\n]|\band\b|&/).map((x) => x.trim()).filter((x) => /^[A-Z][\w.'’ -]{2,40}$/.test(x)).forEach((x) => names.push(x));
    return names.filter((n, i) => n && names.findIndex((m) => norm(m) === norm(n)) === i).slice(0, 8);
  },
  // Pull the "Professional ratings" box from an album's Wikipedia page
  ratings(wt) {
    const start = wt.search(/\{\{\s*(Album|Music) ratings/i);
    if (start < 0) return [];
    let depth = 0, i = start;
    for (; i < wt.length; i++) {
      if (wt.startsWith('{{', i)) { depth++; i++; } else if (wt.startsWith('}}', i)) { depth--; i++; if (!depth) break; }
    }
    const body = wt.slice(start + 2, i - 1);
    const parts = splitTop(body).slice(1);
    const kv = {};
    parts.forEach((p) => { const m = p.match(/^\s*([A-Za-z0-9 ]+?)\s*=\s*([\s\S]*)$/); if (m) kv[m[1].toLowerCase().replace(/\s+/g, '')] = m[2].trim(); });
    const refUrl = (txt) => {
      let m = txt.match(/<ref[^>\/]*>([\s\S]*?)<\/ref>/i);
      let inner = m ? m[1] : '';
      if (!inner) {
        const n = txt.match(/<ref\s+name\s*=\s*"?([^"\/>]+?)"?\s*\/>/i);
        if (n) { const d = wt.match(new RegExp('<ref\\s+name\\s*=\\s*"?' + n[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?\\s*>([\\s\\S]*?)<\\/ref>', 'i')); if (d) inner = d[1]; }
      }
      const u = inner.match(/\|\s*url\s*=\s*([^|}\s]+)/i) || inner.match(/\[(https?:\/\/[^\s\]]+)/);
      return u ? u[1] : '';
    };
    const clean = (s) => String(s || '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
      .replace(/''+/g, '').replace(/<[^>]+>/g, '').replace(/\{\{[^}]*\}\}/g, '').trim();
    const score = (s) => {
      const r = String(s || '').match(/\{\{\s*Rating\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i);
      if (r) return { stars: +r[1], of: +r[2] };
      const t = clean(s);
      return t ? { text: t } : null;
    };
    const out = [];
    for (let n = 1; n <= 30; n++) {
      const name = kv['rev' + n], sc = kv['rev' + n + 'score'];
      if (!name || !sc) continue;
      const s = score(sc);
      if (s) out.push({ name: clean(name), score: s, url: refUrl(sc) });
    }
    if (kv.mc) { const s = score(kv.mc); if (s) out.unshift({ name: 'Metacritic', score: s, url: refUrl(kv.mc) }); }
    return out;
  },
};
function templateKV(wt, re) {
  const start = wt.search(re);
  if (start < 0) return {};
  let depth = 0, i = start;
  for (; i < wt.length; i++) {
    if (wt.startsWith('{{', i)) { depth++; i++; } else if (wt.startsWith('}}', i)) { depth--; i++; if (!depth) break; }
  }
  const kv = {};
  splitTop(wt.slice(start + 2, i - 1)).slice(1).forEach((p) => { const m = p.match(/^\s*([A-Za-z0-9 _]+?)\s*=\s*([\s\S]*)$/); if (m) kv[m[1].toLowerCase().replace(/[\s_]+/g, '')] = m[2].trim(); });
  return kv;
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if ((two === '}}' || two === ']]') && depth > 0) { depth--; cur += two; i++; continue; }
    if (s[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

/* ================= A song's first-release year (MusicBrainz) ================= */
const Year = {
  cache: null,
  load() { if (!this.cache) this.cache = Store.get('years', {}); return this.cache; },
  known(a, t) { const c = this.load(); const k = songKey(a, t); return k in c ? c[k] : undefined; },
  async get(a, t) {
    const c = this.load(), k = songKey(a, t);
    if (k in c) return c[k];
    const j = await MB.get('recording', { query: `recording:${MB.q(t)} AND artist:${MB.q(a)}`, limit: 25 }, 0);
    const years = ((j && j.recordings) || [])
      .filter((r) => (r.score || 0) >= 60 && sim(r.title, t) >= 0.85 && sim(MB.credit(r['artist-credit']), a) >= 0.6 && !/live|demo|remix|rehearsal|acoustic|karaoke/i.test(r.disambiguation || ''))
      .map((r) => yearOf(r['first-release-date'])).filter(Boolean);
    const y = years.length ? Math.min(...years) : 0;
    c[k] = y;
    const keys = Object.keys(c);
    if (keys.length > 6000) keys.slice(0, 1000).forEach((x) => delete c[x]);
    Store.set('years', c, true);
    return y;
  },
};

/* ================= Song finder: artist + title → YouTube video, remembered ================= */
const DAILY_LOOKUPS = 100;
const SongFinder = {
  mem: null, idx: null,
  load() { if (!this.mem) this.mem = Store.get('songs', {}); return this.mem; },
  day() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); },
  used() { const u = Store.get('lookups', {}); return u.day === this.day() ? u.n : 0; },
  count() { Store.set('lookups', { day: this.day(), n: this.used() + 1 }, true); },
  poolIndex() {
    if (this.idx) return this.idx;
    const m = new Map();
    Store.get('pools', []).forEach((p) => Store.get('pool.' + p.id, []).forEach((it) => { const k = songKey(it.a, it.t); if (!m.has(k)) m.set(k, it.v); }));
    this.idx = m;
    return m;
  },
  forget() { this.idx = null; },
  remember(a, t, v) { const m = this.load(); m[songKey(a, t)] = v; Store.set('songs', m, true); },
  async find(a, t) {
    const m = this.load(), k = songKey(a, t);
    this.looked = false;
    if (m[k] !== undefined) return m[k] || null;
    const fromPool = this.poolIndex().get(k);
    if (fromPool) return fromPool;
    if (this.used() >= DAILY_LOOKUPS) throw new ApiError(`Today's ${DAILY_LOOKUPS} song lookups are used up. Playlist pools still work. The count resets overnight (midnight Pacific).`);
    this.count();
    this.looked = true;
    const j = await YTData.get('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: 10, q: `${a} ${t}` });
    const bad = /\b(live|cover|karaoke|remix|instrumental|sped up|slowed|8d|reaction|tutorial|lesson|lyrics? video|full album|concert)\b/i;
    let best = null, bestScore = 0;
    (j.items || []).forEach((it, i) => {
      const sn = it.snippet || {};
      const raw = decodeEntities(sn.title);
      const c = cleanItem({ title: raw, videoOwnerChannelTitle: sn.channelTitle }, it.id && it.id.videoId);
      if (!c) return;
      const ts = Math.max(sim(t, c.t), sim(t, raw)), as = Math.max(sim(a, c.a), sim(a, sn.channelTitle));
      if (ts < 0.6 || as < 0.45) return;
      let s = ts * 0.6 + as * 0.4 - i * 0.01;
      if (/ - Topic$/i.test(sn.channelTitle || '')) s += 0.2;
      if (bad.test(raw) && !bad.test(t)) s -= 0.4;
      if (s > bestScore) { bestScore = s; best = c.v; }
    });
    m[k] = best || '';
    const keys = Object.keys(m);
    if (keys.length > 8000) keys.slice(0, 1000).forEach((x) => delete m[x]);
    Store.set('songs', m, true);
    return best;
  },
};

/* ================= Info cards ================= */
const Cards = {
  open(kind, o) {
    const titles = { artist: 'Artist', album: 'Album', song: 'Song', person: 'Person' };
    Sheets.open({
      title: titles[kind] || 'Info',
      card: true,
      html: '<div class="card-body"><p class="muted">Loading…</p></div>',
      onMount: (body) => {
        const box = body.querySelector('.card-body');
        this[kind](box, o || {}).catch((e) => {
          box.innerHTML = `<p class="muted">Couldn't load this card. ${esc(e && e.message ? e.message : '')}</p>`;
          if (e instanceof ApiError && /key/i.test(e.message)) Errors.show(e.message);
        });
      },
    });
  },
  fromEl(el) {
    const d = el.dataset;
    this.open(d.card, { name: d.name, mbid: d.mbid, artist: d.artist, title: d.title, rg: d.rg, v: d.v, art: d.art });
  },
  attrs(kind, o) {
    return `data-card="${kind}"` + Object.entries(o).filter(([, v]) => v).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  },
  set(box, sel, html) { const el = box.querySelector(sel); if (el) el.innerHTML = html; },
  initials(name) { return esc(String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()); },
  peopleRow(list) {
    return `<div class="people">${list.map((p) => `<button class="person" ${this.attrs('person', { mbid: p.mbid, name: p.name })}>
      <span class="ph">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${this.initials(p.name)}</i></span>
      <span class="n">${esc(p.name)}</span>${p.sub ? `<span class="s">${esc(p.sub)}</span>` : ''}${p.years ? `<span class="s">${esc(p.years)}</span>` : ''}</button>`).join('')}</div>`;
  },
  albumGrid(list, artist) {
    return `<div class="albums">${list.map((g) => `<button class="album" ${this.attrs('album', { rg: g.id, artist, title: g.title })}>
      <span class="cv"><img src="https://coverartarchive.org/release-group/${esc(g.id)}/front-250" alt="" loading="lazy" onerror="this.remove()"></span>
      <span class="n">${esc(g.title)}</span><span class="s">${g.year || ''}</span></button>`).join('')}</div>`;
  },
  about(text, link) {
    if (!text) return '';
    return `<p class="about clamp">${esc(text)}</p><div class="row" style="gap:16px"><button class="link-btn" data-more>More</button>${link ? `<button class="link-btn" data-open="${esc(link)}">Wikipedia</button>` : ''}</div>`;
  },
  wire(box) {
    box.addEventListener('click', (e) => {
      const m = e.target.closest('[data-more]');
      if (m) { const p = m.parentElement.previousElementSibling; if (p) p.classList.toggle('clamp'); m.textContent = p && p.classList.contains('clamp') ? 'More' : 'Less'; }
      const o = e.target.closest('[data-open]');
      if (o) window.open(o.dataset.open, '_blank');
      const y = e.target.closest('[data-ytm]');
      if (y) openYTMusic(y.dataset.ytm, y.dataset.q);
    });
  },
  stars(s) {
    if (s.stars != null && s.of === 5) {
      const full = Math.floor(s.stars), half = s.stars - full >= 0.5 ? 1 : 0;
      return '<span class="stars" aria-label="' + s.stars + ' out of 5">' + '★'.repeat(full) + (half ? '½' : '') + '<span class="off">' + '☆'.repeat(Math.max(0, 5 - full - half)) + '</span></span>';
    }
    if (s.stars != null) return esc(`${s.stars}/${s.of}`);
    return esc(s.text);
  },

  /* ---- Artist ---- */
  async artist(box, o) {
    this.wire(box);
    const name = o.name || o.artist || '';
    box.innerHTML = `<div class="hero"><div class="hero-ph round" data-ph><i>${this.initials(name)}</i></div>
        <div><div class="hero-name">${esc(name)}</div><div class="hero-meta" data-meta></div></div></div>
      <div data-about><p class="muted">Loading…</p></div>
      <div data-members></div>
      <h3>Albums</h3><div data-albums><p class="muted">Loading…</p></div>
      <div data-tags></div>
      <div data-similar></div>
      <p class="muted small">Setlists and upcoming shows arrive with the Setlist Study Guide and Concerts Near Me updates.</p>
      <div class="card-actions"><button class="btn small" data-ytm="" data-q="${esc(name)}">${ICON.out} YouTube Music</button></div>`;
    const lf = await LastFM.artistInfo(name).catch((e) => { if (/key/i.test(e.message)) throw e; return null; });
    const realName = (lf && lf.name) || name;
    this.set(box, '.hero-name', esc(realName));
    this.set(box, '[data-ph]', `<i>${this.initials(realName)}</i>`);
    if (lf) {
      const tags = LastFM.arr(lf.tags && lf.tags.tag).slice(0, 6).map((t) => t.name);
      if (tags.length) this.set(box, '[data-tags]', '<h3>Genres</h3><div class="chips">' + tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('') + '</div>');
      const sim2 = LastFM.arr(lf.similar && lf.similar.artist).slice(0, 8).map((a) => a.name);
      if (sim2.length) this.set(box, '[data-similar]', `<h3>Similar artists</h3><div class="chips">${sim2.map((n) => `<button class="chip link" ${this.attrs('artist', { name: n })}>${esc(n)}</button>`).join('')}</div>`);
    }
    let mb = null;
    const mbid = o.mbid || (lf && lf.mbid);
    try { mb = mbid ? await MB.get('artist/' + mbid, { inc: 'url-rels+artist-rels' }) : null; } catch (e) { mb = null; }
    if (!mb) {
      const f = await MB.findArtist(realName).catch(() => null);
      if (f) mb = await MB.get('artist/' + f.id, { inc: 'url-rels+artist-rels' }).catch(() => null);
    }
    // Meta line: origin · years · type
    if (mb) {
      const ls = mb['life-span'] || {};
      const yrs = yearOf(ls.begin) ? `${yearOf(ls.begin)}–${ls.ended ? (yearOf(ls.end) || '') : 'present'}` : '';
      const origin = [mb['begin-area'] && mb['begin-area'].name, mb.area && mb.area.name].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      this.set(box, '[data-meta]', esc([origin, yrs, mb.type === 'Group' ? 'Band' : mb.type].filter(Boolean).join(' · ')));
    }
    // Photo + bio from Wikipedia
    const q = mb ? MB.wikidata(mb.relations) : '';
    let ents = {};
    try { ents = q ? await Wiki.entities([q]) : {}; } catch (e) { ents = {}; }
    const ent = ents[q];
    const sum = await Wiki.summary(Wiki.enTitle(ent)).catch(() => null);
    const photo = (sum && sum.thumbnail && sum.thumbnail.source) || Wiki.image(Wiki.claim(ent, 'P18'), 400);
    if (photo) this.set(box, '[data-ph]', `<img src="${esc(photo)}" alt="" onerror="this.remove()"><i>${this.initials(realName)}</i>`);
    const bio = (sum && sum.extract) || (lf && stripHtml(lf.bio && lf.bio.summary)) || '';
    this.set(box, '[data-about]', bio ? '<h3>About</h3>' + this.about(bio, sum && sum.content_urls && sum.content_urls.mobile && sum.content_urls.mobile.page) : '');
    // Members
    if (mb && mb.type === 'Group') {
      const byId = new Map();
      (mb.relations || []).filter((r) => r.type === 'member of band' && r.direction === 'backward' && r.artist).forEach((r) => {
        const m = byId.get(r.artist.id) || { mbid: r.artist.id, name: r.artist.name, inst: new Set(), b: 9999, e: 0, cur: false };
        cleanInst(r.attributes).forEach((x) => m.inst.add(x));
        const b = yearOf(r.begin), e = yearOf(r.end);
        if (b) m.b = Math.min(m.b, b);
        if (!r.ended) m.cur = true; else if (e) m.e = Math.max(m.e, e);
        byId.set(r.artist.id, m);
      });
      // Longest-serving first (the Beatles: John, Paul, George, Ringo, then Pete Best, Stuart Sutcliffe…)
      const now = new Date().getFullYear();
      const span = (m) => (m.b < 9999 ? (m.cur ? now : (m.e || m.b)) - m.b : 0);
      const members = [...byId.values()].sort((x, y) => (y.cur - x.cur) * (mb['life-span'] && mb['life-span'].ended ? 0 : 1) || span(y) - span(x) || x.b - y.b);
      if (members.length) {
        let photos = {};
        try {
          const parts = Wiki.claims(ent, 'P527').map((v) => v.id).filter(Boolean);
          const pe = await Wiki.entities(parts);
          Object.values(pe).forEach((x) => { const f = Wiki.claim(x, 'P18'); if (f) photos[norm(Wiki.label(x))] = Wiki.image(f, 200); });
        } catch (e) { photos = {}; }
        this.set(box, '[data-members]', '<h3>Members</h3>' + this.peopleRow(members.map((m) => ({
          mbid: m.mbid, name: m.name, sub: [...m.inst].slice(0, 3).join(', '),
          years: yearsText(m),
          photo: photos[norm(m.name)] || Object.entries(photos).find(([k]) => sim(k, m.name) > 0.85)?.[1] || '',
        }))));
      }
    }
    // Albums
    if (mb) {
      const albums = await MB.albums(mb.id).catch(() => []);
      this.set(box, '[data-albums]', albums.length ? this.albumGrid(albums, realName) : '<p class="muted">No studio albums listed.</p>');
    } else this.set(box, '[data-albums]', '<p class="muted">Not found on MusicBrainz.</p>');
  },

  /* ---- Person ---- */
  async person(box, o) {
    this.wire(box);
    box.innerHTML = `<div class="hero"><div class="hero-ph round" data-ph><i>${this.initials(o.name)}</i></div>
      <div><div class="hero-name">${esc(o.name || '')}</div><div class="hero-meta" data-meta></div></div></div>
      <div data-inst></div><div data-about></div><div data-bands><p class="muted">Loading…</p></div><div data-solo></div>`;
    let id = o.mbid;
    if (!id) { const f = await MB.findArtist(o.name); id = f && f.id; }
    if (!id) { this.set(box, '[data-bands]', '<p class="muted">Not found on MusicBrainz.</p>'); return; }
    const mb = await MB.get('artist/' + id, { inc: 'url-rels+artist-rels' });
    if (!mb) { this.set(box, '[data-bands]', '<p class="muted">Not found on MusicBrainz.</p>'); return; }
    this.set(box, '.hero-name', esc(mb.name));
    const ls = mb['life-span'] || {};
    this.set(box, '[data-meta]', esc([mb.area && mb.area.name, yearOf(ls.begin) ? `Born ${yearOf(ls.begin)}` : '', yearOf(ls.end) ? `Died ${yearOf(ls.end)}` : ''].filter(Boolean).join(' · ')));
    const bands = new Map(), inst = new Set();
    (mb.relations || []).filter((r) => r.type === 'member of band' && r.direction === 'forward' && r.artist).forEach((r) => {
      const b = bands.get(r.artist.id) || { mbid: r.artist.id, name: r.artist.name, b: 9999, e: 0, cur: false };
      cleanInst(r.attributes).forEach((x) => inst.add(x));
      if (yearOf(r.begin)) b.b = Math.min(b.b, yearOf(r.begin));
      if (!r.ended) b.cur = true; else if (yearOf(r.end)) b.e = Math.max(b.e, yearOf(r.end));
      bands.set(r.artist.id, b);
    });
    if (inst.size) this.set(box, '[data-inst]', `<div class="chips">${[...inst].slice(0, 6).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>`);
    const bl = [...bands.values()].sort((x, y) => x.b - y.b);
    this.set(box, '[data-bands]', bl.length ? '<h3>Bands</h3><div class="rows">' + bl.map((b) => `<button class="rowbtn" ${this.attrs('artist', { name: b.name, mbid: b.mbid })}><span>${esc(b.name)}</span><span class="muted">${yearsText(b)}</span></button>`).join('') + '</div>' : '');
    const q = MB.wikidata(mb.relations);
    const ents = q ? await Wiki.entities([q]).catch(() => ({})) : {};
    const sum = await Wiki.summary(Wiki.enTitle(ents[q])).catch(() => null);
    const photo = (sum && sum.thumbnail && sum.thumbnail.source) || Wiki.image(Wiki.claim(ents[q], 'P18'), 400);
    if (photo) this.set(box, '[data-ph]', `<img src="${esc(photo)}" alt="" onerror="this.remove()"><i>${this.initials(mb.name)}</i>`);
    if (sum && sum.extract) this.set(box, '[data-about]', '<h3>About</h3>' + this.about(sum.extract, sum.content_urls && sum.content_urls.mobile && sum.content_urls.mobile.page));
    const solo = await MB.albums(id).catch(() => []);
    if (solo.length) this.set(box, '[data-solo]', '<h3>Solo albums</h3>' + this.albumGrid(solo, mb.name));
  },

  /* ---- Album ---- */
  async album(box, o) {
    this.wire(box);
    box.innerHTML = `<div class="hero"><div class="hero-ph" data-ph>${o.art ? `<img src="${esc(o.art)}" alt="">` : ''}</div>
      <div><div class="hero-name">${esc(o.title || '')}</div><button class="hero-meta link" ${this.attrs('artist', { name: o.artist })}>${esc(o.artist || '')}</button><div class="hero-meta" data-meta></div></div></div>
      <h3>Tracks</h3><div data-tracks><p class="muted">Loading…</p></div><div data-ratings></div><div data-about></div>`;
    let rg = o.rg;
    if (!rg) {
      const j = await MB.get('release-group', { query: `releasegroup:${MB.q(o.title)} AND artist:${MB.q(o.artist)}`, limit: 10 });
      const list = ((j && j['release-groups']) || []).map((g) => ({ g, s: (g.score || 0) / 100 + sim(g.title, o.title) + (g['primary-type'] === 'Album' && !(g['secondary-types'] || []).length ? 0.3 : 0) }))
        .sort((a, b) => b.s - a.s);
      rg = list[0] && list[0].s > 1.4 ? list[0].g.id : '';
    }
    if (!rg) { this.set(box, '[data-tracks]', '<p class="muted">Not found on MusicBrainz.</p>'); return; }
    const g = await MB.get('release-group/' + rg, { inc: 'url-rels+artist-credits' });
    if (g) {
      this.set(box, '.hero-name', esc(g.title));
      const artist = MB.credit(g['artist-credit']) || o.artist;
      const ab = box.querySelector('.hero .link');
      if (ab) { ab.textContent = artist; ab.dataset.name = artist; }
    }
    const cover = `https://coverartarchive.org/release-group/${rg}/front-500`;
    const ph = box.querySelector('[data-ph]');
    const img = new Image();
    img.onload = () => { ph.innerHTML = ''; ph.appendChild(img); };
    img.src = cover;
    const at = await MB.albumTracks(rg);
    this.set(box, '[data-meta]', esc([yearOf(g && g['first-release-date']) || yearOf(at.date) || '', at.label].filter(Boolean).join(' · ')));
    const artistName = g ? MB.credit(g['artist-credit']) : o.artist;
    this.set(box, '[data-tracks]', at.tracks.length ? '<div class="rows">' + at.tracks.map((t, i) => `<button class="rowbtn" ${this.attrs('song', { artist: artistName, title: t.t })}><span><span class="num">${i + 1}</span>${esc(t.t)}</span><span class="muted mono">${t.len ? fmtTime(t.len / 1000) : ''}</span></button>`).join('') + '</div>' : '<p class="muted">No track list found.</p>');
    const q = g ? MB.wikidata(g.relations) : '';
    if (!q) return;
    const ents = await Wiki.entities([q]).catch(() => ({}));
    const title = Wiki.enTitle(ents[q]);
    if (!title) return;
    const [sum, wt] = await Promise.all([Wiki.summary(title).catch(() => null), Wiki.wikitext(title).catch(() => '')]);
    const rt = wt ? Wiki.ratings(wt) : [];
    if (rt.length) {
      this.set(box, '[data-ratings]', '<h3>Critic ratings</h3><div class="rows">' + rt.map((r) => `<${r.url ? `button class="rowbtn" data-open="${esc(r.url)}"` : 'div class="rowbtn"'}><span>${esc(r.name)}</span><span>${this.stars(r.score)}</span></${r.url ? 'button' : 'div'}>`).join('') + '</div>');
    }
    if (sum && sum.extract) this.set(box, '[data-about]', '<h3>About</h3>' + this.about(sum.extract, sum.content_urls && sum.content_urls.mobile && sum.content_urls.mobile.page));
  },

  /* ---- Song ---- */
  async song(box, o) {
    this.wire(box);
    const artist = o.artist || '', title = o.title || '';
    box.innerHTML = `<div class="hero"><div class="hero-ph" data-ph>${o.art ? `<img src="${esc(o.art)}" alt="">` : ''}</div>
      <div><div class="hero-name">${esc(title)}</div><button class="hero-meta link" ${this.attrs('artist', { name: artist })}>${esc(artist)}</button></div></div>
      <div class="facts" data-facts><p class="muted">Loading…</p></div>
      <div data-writers></div>
      <div data-about></div><div class="chips" data-tags></div>
      <div class="card-actions"><button class="btn small" data-open="https://genius.com/search?q=${encodeURIComponent(artist + ' ' + title)}">Lyrics</button>
        <button class="btn small" data-ytm="${esc(o.v || '')}" data-q="${esc(artist + ' ' + title)}">${ICON.out} YouTube Music</button></div>
      <p class="muted small">How often it's played on the current tour arrives with the Setlist Study Guide update.</p>`;
    const facts = { album: '', rg: '', year: 0, len: 0 };
    const showFacts = () => {
      const rows = [];
      if (facts.album) rows.push(`<div class="fact wide"><span class="k">Album</span><button class="v link" ${this.attrs('album', { rg: facts.rg, artist, title: facts.album })}>${esc(facts.album)}</button></div>`);
      if (facts.year) rows.push(`<div class="fact"><span class="k">Year</span><span class="v">${facts.year}</span></div>`);
      if (facts.len) rows.push(`<div class="fact"><span class="k">Length</span><span class="v">${fmtTime(facts.len)}</span></div>`);
      this.set(box, '[data-facts]', rows.join('') || '<p class="muted">No details found.</p>');
    };
    let bgSet = false;
    const setBg = (text, link) => { if (text) { this.set(box, '[data-about]', '<h3>Background</h3>' + this.about(text, link)); bgSet = true; } };
    const lf = await LastFM.trackInfo(artist, title).catch((e) => { if (/key/i.test(e.message)) throw e; return null; });
    if (lf) {
      facts.album = (lf.album && lf.album.title) || '';
      facts.len = (+lf.duration || 0) / 1000;
      const tags = LastFM.arr(lf.toptags && lf.toptags.tag).slice(0, 5).map((t) => t.name);
      this.set(box, '[data-tags]', tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(''));
      const art = lf.album && LastFM.arr(lf.album.image).map((i) => i['#text']).filter(Boolean).pop();
      if (art && !o.art) this.set(box, '[data-ph]', `<img src="${esc(art)}" alt="">`);
      const w = lf.wiki && stripHtml(lf.wiki.summary);
      if (w) this.set(box, '[data-about]', '<h3>Background</h3>' + this.about(w));
    }
    showFacts();
    // MusicBrainz: earliest studio recording → year, length, album; its "work" → the writers
    const j = await MB.get('recording', { query: `recording:${MB.q(title)} AND artist:${MB.q(artist)}`, limit: 25 }).catch(() => null);
    const recs = ((j && j.recordings) || []).filter((r) => (r.score || 0) >= 60 && sim(r.title, title) >= 0.85 && sim(MB.credit(r['artist-credit']), artist) >= 0.6 && !/live|demo|remix|rehearsal|acoustic|karaoke/i.test(r.disambiguation || ''))
      .sort((a, b) => (yearOf(a['first-release-date']) || 9999) - (yearOf(b['first-release-date']) || 9999));
    const rec = recs[0];
    if (rec) {
      facts.year = yearOf(rec['first-release-date']);
      if (!facts.len && rec.length) facts.len = rec.length / 1000;
      const albumRel = (rec.releases || []).filter((r) => r['release-group'] && r['release-group']['primary-type'] === 'Album' && !(r['release-group']['secondary-types'] || []).length)
        .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))[0];
      if (albumRel) { facts.album = albumRel['release-group'].title; facts.rg = albumRel['release-group'].id; }
      showFacts();
    }
    const writers = [];
    let work = null;
    for (const r of recs.slice(0, 3)) {          // the first recordings that link to the song's "work"
      const full = await MB.get('recording/' + r.id, { inc: 'work-rels' }).catch(() => null);
      const wr = full && (full.relations || []).find((x) => x.type === 'performance' && x.work);
      if (!wr) continue;
      work = await MB.get('work/' + wr.work.id, { inc: 'artist-rels+url-rels' }).catch(() => null);
      if (work) break;
    }
    if (work) {
      const byId = new Map();
      (work.relations || []).filter((r) => /composer|lyricist|writer/.test(r.type) && r.artist).forEach((r) => {
        const w = byId.get(r.artist.id) || { mbid: r.artist.id, name: r.artist.name, roles: new Set() };
        w.roles.add(r.type === 'lyricist' ? 'lyrics' : r.type === 'composer' ? 'music' : 'words & music');
        byId.set(r.artist.id, w);
      });
      byId.forEach((w) => writers.push({ mbid: w.mbid, name: w.name, sub: w.roles.size > 1 ? 'words & music' : [...w.roles][0] }));
    }
    // Wikipedia: the song's own article (for the background, and for writers MusicBrainz doesn't list)
    let page = '';
    const q = work ? MB.wikidata(work.relations) : '';
    if (q) { const ents = await Wiki.entities([q]).catch(() => ({})); page = Wiki.enTitle(ents[q]); }
    if (!page) page = await Wiki.findSong(title, artist).catch(() => '');
    if (page) {
      const [sum, wt] = await Promise.all([Wiki.summary(page).catch(() => null), writers.length ? '' : Wiki.wikitext(page).catch(() => '')]);
      if (sum && sum.extract) setBg(sum.extract, sum.content_urls && sum.content_urls.mobile && sum.content_urls.mobile.page);
      if (!writers.length && wt) Wiki.songwriters(wt).forEach((n) => writers.push({ name: n }));
    }
    if (writers.length) this.set(box, '[data-writers]', '<h3>Written by</h3>' + this.peopleRow(writers));
    if (!bgSet && !(lf && lf.wiki)) this.set(box, '[data-about]', '');
  },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-card]');
  if (el && !el.disabled) { e.preventDefault(); Cards.fromEl(el); }
});
