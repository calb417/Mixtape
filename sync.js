'use strict';
/* Sync with a code, through the Mixtape relay (relay/worker.js on Cloudflare). Off until CONFIG.RELAY_URL
   is filled in. Two phones that use the same code share My Artists, the Concert Diary, playlists, the
   game's pool and song memory, and settings. Needs app.js loaded first. */

const SYNC_KEYS = ['settings', 'myArtists', 'diary', 'pools', 'filters', 'blocked', 'songs', 'recent'];
const WORDS_A = ['amber', 'blue', 'brave', 'calm', 'cosmic', 'crimson', 'electric', 'golden', 'happy', 'indigo', 'jolly', 'lucky', 'mellow', 'neon', 'quiet', 'rapid', 'silver', 'sunny', 'velvet', 'wild'];
const WORDS_B = ['falcon', 'guitar', 'tiger', 'comet', 'harbor', 'piano', 'river', 'rocket', 'meadow', 'tempo', 'vinyl', 'echo', 'drum', 'lantern', 'canyon', 'otter', 'maple', 'anchor', 'tuba', 'zebra'];

const Sync = {
  rev: 0,
  timer: null,
  busy: false,
  url() { return String(CONFIG.RELAY_URL || '').trim().replace(/\/+$/, ''); },
  on() { return !!this.url() && !!this.code(); },
  code() { return Store.get('syncCode', ''); },
  syncable(k) { return SYNC_KEYS.includes(k) || k.startsWith('pool.') || k.startsWith('deleted.'); },
  meta() { if (!this._meta) this._meta = Store.get('syncMeta', {}); return this._meta; },
  saveMeta() { try { localStorage.setItem('mixtape.syncMeta', JSON.stringify(this.meta())); } catch (e) { /* ignore */ } },
  localKeys() { return Store.allKeys().map((k) => k.slice('mixtape.'.length)).filter((k) => this.syncable(k)); },
  newCode() { const p = (a) => a[Math.floor(Math.random() * a.length)]; return `${p(WORDS_A)}-${p(WORDS_B)}-${10 + Math.floor(Math.random() * 90)}`; },

  // Called by Store.set / Store.del for every change
  touch(k) {
    if (!this.syncable(k)) return;
    this.meta()[k] = Date.now();
    this.saveMeta();
    if (!this.on()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push().catch(() => {}), 60000);   // changes are grouped and saved a minute later
  },

  /* ---------- relay info (which keys the relay holds) ---------- */
  info() { return Store.get('relayInfo', {}); },
  async ping() {
    if (!this.url()) return null;
    const r = await fetch(this.url() + '/ping');
    if (!r.ok) throw new Error('relay ' + r.status);
    const j = await r.json();
    Store.set('relayInfo', Object.assign({ at: new Date().toISOString() }, j), true);
    return j;
  },
  has(service) { return !!(this.url() && this.info().keys && this.info().keys[service]); },

  /* ---------- pull, merge, push ---------- */
  async pull() {
    const r = await fetch(`${this.url()}/sync/${this.code()}`);
    if (r.status === 404) { this.rev = 0; return false; }
    if (!r.ok) throw new ApiError('Sync: the relay answered ' + r.status);
    const doc = await r.json();
    this.rev = doc.rev || 0;
    return this.merge(doc.items || {});
  },
  async push() {
    if (!this.on() || this.busy) return;
    this.busy = true;
    clearTimeout(this.timer);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const meta = this.meta(), items = {};
        this.localKeys().forEach((k) => { items[k] = { v: localStorage.getItem('mixtape.' + k), t: meta[k] || 0 }; });
        const r = await fetch(`${this.url()}/sync/${this.code()}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRev: this.rev, items }) });
        if (r.status === 409) {                       // the other phone saved first: take its changes, then try again
          const j = await r.json();
          this.rev = (j.current && j.current.rev) || 0;
          if (j.current) this.merge(j.current.items || {});
          continue;
        }
        if (!r.ok) throw new ApiError('Sync: the relay answered ' + r.status);
        const j = await r.json();
        this.rev = j.rev;
        Store.set('syncLast', new Date().toISOString(), true);
        return;
      }
    } finally { this.busy = false; }
  },
  async run(quiet) {
    if (!this.on()) return;
    try {
      const changed = await this.pull();
      await this.push();
      if (changed) this.refreshViews();
    } catch (e) {
      if (!quiet) Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
    }
  },
  refreshViews() {
    // memory caches that read storage once
    if (typeof SongFinder !== 'undefined') { SongFinder.mem = null; SongFinder.forget(); }
    if (typeof Pool !== 'undefined') { Pool.recentList = null; Pool.reset(); }
    applyTheme();
    if (currentView && currentView !== Views.game) route();
  },

  // Newer wins for most things. My Artists and the diary merge item by item, and deletions are remembered.
  merge(items) {
    const meta = this.meta();
    let changed = false;
    const raw = (k) => localStorage.getItem('mixtape.' + k);
    const write = (k, v, t) => { if (raw(k) !== v) { localStorage.setItem('mixtape.' + k, v); changed = true; } meta[k] = Math.max(meta[k] || 0, t); };
    const keys = Object.keys(items).sort((a, b) => (b.startsWith('deleted.') ? 1 : 0) - (a.startsWith('deleted.') ? 1 : 0));
    keys.forEach((k) => {
      const rem = items[k];
      if (!rem || typeof rem.v !== 'string' || !this.syncable(k)) return;
      const lt = meta[k] || 0;
      if (k.startsWith('deleted.')) {
        const both = new Map();
        [].concat(JSON.parse(raw(k) || '[]'), JSON.parse(rem.v)).forEach((d) => { const x = both.get(d.k); if (!x || x.t < d.t) both.set(d.k, d); });
        write(k, JSON.stringify([...both.values()]), Math.max(lt, rem.t));
      } else if (k === 'diary' || k === 'myArtists') {
        const idOf = k === 'diary' ? (e) => e.id : (e) => norm(e.name);
        const when = (e) => e.edited || Date.parse(e.added || 0) || 0;
        const dead = new Map(JSON.parse(raw('deleted.' + k) || '[]').map((d) => [d.k, d.t]));
        const all = new Map();
        [].concat(JSON.parse(raw(k) || '[]'), JSON.parse(rem.v)).forEach((e) => { const id = idOf(e), x = all.get(id); if (!x || when(x) < when(e)) all.set(id, e); });
        const merged = [...all.values()].filter((e) => !(dead.has(idOf(e)) && dead.get(idOf(e)) >= when(e)));
        if (k === 'diary') merged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        else merged.sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
        write(k, JSON.stringify(merged), Math.max(lt, rem.t));
      } else if (rem.t > lt) {
        write(k, rem.v, rem.t);
      }
    });
    this.saveMeta();
    return changed;
  },
  // Remember a deletion so the other phone deletes it too
  tombstone(list, key) {
    const k = 'deleted.' + list;
    const d = Store.get(k, []).filter((x) => x.k !== key);
    d.push({ k: key, t: Date.now() });
    Store.set(k, d.slice(-500), true);
    this.touch(k);
  },
  untomb(list, key) {
    const k = 'deleted.' + list;
    const d = Store.get(k, []);
    if (d.some((x) => x.k === key)) { Store.set(k, d.filter((x) => x.k !== key), true); this.touch(k); }
  },

  /* ---------- turning it on and off ---------- */
  async start() {
    let code = this.newCode();
    for (let i = 0; i < 5; i++) {                     // make sure nobody uses this code yet
      const r = await fetch(`${this.url()}/sync/${code}`);
      if (r.status === 404) break;
      code = this.newCode();
    }
    Store.set('syncCode', code, true);
    this.rev = 0;
    this.localKeys().forEach((k) => { if (!this.meta()[k]) this.meta()[k] = Date.now(); });
    this.saveMeta();
    await this.push();
    return code;
  },
  async join(code) {
    code = String(code || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z]+-[a-z]+-\d{2,3}$/.test(code)) throw new ApiError('That code doesn\'t look right. It looks like amber-falcon-42.');
    const r = await fetch(`${this.url()}/sync/${code}`);
    if (r.status === 404) throw new ApiError('No one is syncing with that code yet. Check it on the other phone (Settings → Saving).');
    if (!r.ok) throw new ApiError('Sync: the relay answered ' + r.status);
    const doc = await r.json();
    Store.set('syncCode', code, true);
    this.rev = doc.rev || 0;
    // the shared copy wins for plain settings; lists merge with what's on this phone
    Object.keys(doc.items || {}).forEach((k) => { if (!['diary', 'myArtists'].includes(k) && !k.startsWith('deleted.')) this.meta()[k] = 0; });
    this.merge(doc.items || {});
    await this.push();
    this.refreshViews();
  },
  stop() { Store.del('syncCode'); clearTimeout(this.timer); },
};

// Sync when Mixtape opens, when it comes back on screen, and try to save on the way out.
document.addEventListener('DOMContentLoaded', () => {
  if (!Sync.url()) return;
  Sync.ping().catch(() => {});
  Sync.run(true);
});
document.addEventListener('visibilitychange', () => {
  if (!Sync.on()) return;
  if (document.visibilityState === 'visible') Sync.run(true);
  else Sync.push().catch(() => {});
});
