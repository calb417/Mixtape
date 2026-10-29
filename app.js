'use strict';

// =====================================================================
//  YOUR KEYS — this is the only block you ever need to edit.
//  Paste each key between its quotes.
// =====================================================================
const CONFIG = {
  YOUTUBE_API_KEY: 'AIzaSyDz0tlqHQZU8WFEoCWcc6w4VnK01l9sZYY',
  LASTFM_API_KEY: '506225735c83135da4286cc87db378b0',
};
// =====================================================================

const APP_VERSION = '2.3';

/* ---------------- On-screen errors (so they can be screenshotted) ---------------- */
const Errors = {
  list: [],
  show(message, detail) {
    const text = String(message || 'Something went wrong');
    const extra = detail ? String(detail && detail.stack ? detail.stack : detail) : '';
    this.list.push({ at: new Date().toISOString(), text, extra });
    try {
      const log = Store.get('errorlog', []);
      log.push({ at: new Date().toISOString(), text, extra: extra.slice(0, 600) });
      Store.set('errorlog', log.slice(-30), true);
    } catch (e) { /* ignore */ }
    const box = document.getElementById('errors');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<div><b>Mixtape hit a problem.</b> Take a screenshot of this and send it to Claude.</div>
      <div class="e">${esc(text)}${extra ? '\n' + esc(extra.slice(0, 400)) : ''}</div>
      <div class="row"><button data-x="dismiss">Dismiss</button></div>`;
    box.querySelector('[data-x=dismiss]').onclick = () => { box.hidden = true; };
  },
};
window.addEventListener('error', (e) => {
  if (e && e.target && e.target.tagName === 'SCRIPT') return; // a lookup script failing is handled where it's used
  Errors.show(e.message || 'Script error', e.error || (e.filename ? `${e.filename}:${e.lineno}` : ''));
});
window.addEventListener('unhandledrejection', (e) => Errors.show(e.reason && e.reason.message ? e.reason.message : 'Unexpected error', e.reason));

/* ---------------- Helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s-\s.*(remaster|version|edit|mix|live|mono|stereo).*$/i, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
// 0..1 similarity, forgiving of typos and word order
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  A.forEach((n, g) => { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); });
  B.forEach((n) => { total += n; });
  return total ? (2 * inter) / total : 0;
}
// close-match search: every typed word should roughly appear
function fuzzyScore(query, text) {
  const q = norm(query), t = norm(text);
  if (!q) return 1;
  if (t.includes(q)) return 2;
  const words = q.split(' ');
  const tw = t.split(' ');
  let score = 0;
  for (const w of words) {
    let best = 0;
    for (const x of tw) {
      if (x.startsWith(w)) { best = 1; break; }
      if (w.length > 2) best = Math.max(best, sim(w, x));
    }
    if (best < 0.55) return 0;
    score += best;
  }
  return score / words.length;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------- Storage (on this phone) ---------------- */
const Store = {
  k: (key) => 'mixtape.' + key,
  get(key, fallback) {
    try {
      const v = localStorage.getItem(this.k(key));
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value, quiet) {
    try { localStorage.setItem(this.k(key), JSON.stringify(value)); }
    catch (e) { if (!quiet) Errors.show('Could not save on this phone. Storage may be full.', e); }
  },
  del(key) { try { localStorage.removeItem(this.k(key)); } catch (e) { /* ignore */ } },
  allKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mixtape.')) out.push(k);
    }
    return out;
  },
};

/* ---------------- Settings ---------------- */
const DEFAULTS = { accent: '#F28C38', bg: '#121014', keepAwake: true, clipIndex: 3, ytKey: '' };
const Settings = {
  get() { return Object.assign({}, DEFAULTS, Store.get('settings', {})); },
  set(patch) { const s = Object.assign(this.get(), patch); Store.set('settings', s); return s; },
};

/* ---------------- Colors / theme ---------------- */
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [18, 16, 20];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
function luminance(hex) {
  const c = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function applyTheme() {
  const s = Settings.get();
  const bg = s.bg, dark = luminance(bg) < 0.35;
  const towards = dark ? '#ffffff' : '#000000';
  const text = dark ? '#F4EFE6' : '#1A1714';
  const root = document.documentElement.style;
  root.setProperty('--bg', bg);
  root.setProperty('--surface', mix(bg, towards, dark ? 0.06 : 0.05));
  root.setProperty('--surface2', mix(bg, towards, dark ? 0.11 : 0.09));
  root.setProperty('--line', mix(bg, towards, dark ? 0.18 : 0.16));
  root.setProperty('--text', text);
  root.setProperty('--muted', mix(text, bg, 0.3));
  root.setProperty('--faint', mix(text, bg, 0.42));
  root.setProperty('--accent', s.accent);
  root.setProperty('--on-accent', luminance(s.accent) > 0.4 ? '#1A1208' : '#FFFFFF');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', bg);
}

/* ---------------- Keep the screen awake ---------------- */
const Wake = {
  lock: null,
  async on() {
    if (!Settings.get().keepAwake || !('wakeLock' in navigator) || this.lock || document.visibilityState !== 'visible') return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; });
    } catch (e) { this.lock = null; }
  },
  off() { if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; } },
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Wake.on(); });
document.addEventListener('pointerdown', () => Wake.on(), { passive: true });

/* ---------------- Toast + sheets + help ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

const Sheets = {
  stack: [],
  open({ title, html, onMount, onClose, card }) {
    const root = $('#sheet-root');
    const back = document.createElement('div');
    back.className = 'sheet-backdrop';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', title || 'Panel');
    sheet.innerHTML = `<div class="grab"></div>
      <div class="sheet-top"><h2>${esc(title || '')}</h2>
      <span class="row" style="gap:6px; align-items:center"><button class="btn small ghost closeall" data-x="closeall" hidden>Close all</button>
      <button class="icon-btn" data-x="close" aria-label="Close">${ICON.close}</button></span></div>
      <div class="sheet-body">${html}</div>`;
    root.appendChild(back);
    root.appendChild(sheet);
    const entry = { back, sheet, onClose };
    this.stack.push(entry);
    const close = () => this.close(entry);
    back.onclick = close;
    sheet.querySelector('[data-x=close]').onclick = close;
    sheet.querySelector('[data-x=closeall]').onclick = () => this.closeAll();
    this.refresh();
    requestAnimationFrame(() => { back.classList.add('open'); sheet.classList.add('open'); });
    if (onMount) onMount(sheet.querySelector('.sheet-body'), close);
    return close;
  },
  close(entry) {
    const i = this.stack.indexOf(entry);
    if (i < 0) return;
    this.stack.splice(i, 1);
    entry.back.classList.remove('open');
    entry.sheet.classList.remove('open');
    setTimeout(() => { entry.back.remove(); entry.sheet.remove(); }, 320);
    this.refresh();
    if (entry.onClose) entry.onClose();
  },
  closeAll() { [...this.stack].reverse().forEach((e) => this.close(e)); },
  refresh() { this.stack.forEach((e) => { const b = e.sheet.querySelector('[data-x=closeall]'); if (b) b.hidden = this.stack.length < 2; }); },
};

const HELP = {
  home: {
    title: 'Welcome to Mixtape',
    html: `<p>Each tile opens a section. Guess the Intro is ready now; the other sections arrive in the next updates.</p>
      <ul><li><b>?</b> on any screen shows how that screen works.</li>
      <li>The gear opens Settings: colors, keeping the screen on, backups.</li>
      <li>The screen stays on while Mixtape is open. Press the side button to lock it as usual.</li></ul>`,
  },
  game: {
    title: 'Guess the Intro',
    html: `<ol><li><b>Pick the pool</b> with the bar next to Guess / DJ: playlists, artists (and their albums), genres, decades, and hits or deep cuts. Nothing picked plays popular songs.</li>
      <li>Set the <b>clip length</b> with the slider or − / +. The left half is 0.1 to 1 second, the right half 1 to 60 seconds.</li>
      <li><b>Play clip</b> plays the very start of the song; the button fills up while it plays. Tap it again to hear the same clip again.</li>
      <li><b>More time</b> adds the starting length once per tap.</li>
      <li><b>Skip silence</b>: if a clip was silent, the next try starts where it ended. <b>Undo</b>, <b>−0.25 s</b> and <b>0:00</b> step back. Nothing is saved.</li>
      <li><b>Reveal</b> flips the card and plays the rest of the song, with pause and a scrub bar. Tap the song, artist or album for its info card. <b>Next song</b> moves on.</li></ol>
      <h3>DJ Mode</h3><p>Switch to DJ at the top. The DJ taps <b>Random pick</b> (from the pool), searches your playlists, or searches all of YouTube. The album art and song stay on screen for the DJ. <b>Pass the phone</b> blanks the screen for the next DJ.</p>
      <h3>Locking the phone</h3><p>If the phone locks before Reveal, Mixtape drops the song so the lock screen can't give it away, and reloads it when you come back.</p>`,
  },
  pools: {
    title: 'Adding a playlist',
    html: `<ol><li>In YouTube Music, open the playlist → <b>⋯</b> → <b>Edit playlist</b> → set <b>Privacy</b> to <b>Unlisted</b> (or Public).</li>
      <li>Tap <b>⋯</b> → <b>Share</b> → <b>Copy link</b>.</li>
      <li>Paste the link in Song pool → Add a YouTube Music playlist.</li></ol>
      <p>Mixtape saves the song list on this phone. Tap <b>Refresh</b> after you change the playlist.</p>`,
  },
  settings: {
    title: 'Settings',
    html: `<ul><li><b>Appearance</b>: pick any accent and background color. Text adjusts to stay readable. Reset goes back to black and orange.</li>
      <li><b>Keep screen on</b>: the phone won't dim while Mixtape is open.</li>
      <li><b>Song lookups</b>: songs that come from artists, genres or decades are matched to YouTube once (100 a day) and then remembered.</li>
      <li><b>Backup</b>: saves everything on this phone to one file you can load later. Sync with a code comes with the next update.</li></ul>`,
  },
};
function showHelp(key) {
  const h = HELP[key];
  if (h) Sheets.open({ title: h.title, html: h.html });
}
function firstVisit(key) {
  const seen = Store.get('seenTips', {});
  if (seen[key]) return;
  seen[key] = true;
  Store.set('seenTips', seen);
  setTimeout(() => showHelp(key), 350);
}

/* ---------------- Icons ---------------- */
const ICON = {
  close: '<svg viewBox="0 0 14 14" width="14" height="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12"/></svg>',
  back: '<svg viewBox="0 0 10 16" width="10" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2L2 8l6 6"/></svg>',
  chev: '<svg viewBox="0 0 10 16" width="10" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 2l6 6-6 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  play: '<svg viewBox="0 0 12 14" width="13" height="15" aria-hidden="true"><path d="M1 1l10 6-10 6z" fill="currentColor"/></svg>',
  tape: '<svg viewBox="0 0 30 22" width="30" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="1" width="28" height="20" rx="3"/><circle cx="9" cy="9.5" r="2.6"/><circle cx="21" cy="9.5" r="2.6"/><path d="M7.4 20L9.8 16H20.2L22.6 20"/></svg>',
  notes: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h13M3 12h13M3 18h8"/><path d="M19 15v6M16 18h6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  diary: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="ic"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/></svg>',
  pause: '<svg viewBox="0 0 14 14" width="16" height="16" aria-hidden="true"><path d="M3 1.5h2.6v11H3zM8.4 1.5H11v11H8.4z" fill="currentColor"/></svg>',
  filter: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  dice: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7"/></svg>',
  out: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

/* ---------------- YouTube Data API ---------------- */
class ApiError extends Error {}
const YTData = {
  key() { return (Settings.get().ytKey || '').trim() || CONFIG.YOUTUBE_API_KEY; },
  async get(path, params) {
    const key = this.key();
    if (!key || key.startsWith('PASTE-')) throw new ApiError('No YouTube key yet. Open app.js on GitHub and paste your key in the marked spot at the top.');
    const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
    Object.entries(Object.assign({}, params, { key })).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
    let r;
    try { r = await fetch(url.toString()); }
    catch (e) { throw new ApiError('Could not reach YouTube. Check the internet connection and try again.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (j && j.error) || {};
      const reason = (err.errors && err.errors[0] && err.errors[0].reason) || (err.details && err.details[0] && err.details[0].reason) || '';
      const msg = err.message || ('HTTP ' + r.status);
      if (/playlistNotFound/i.test(reason) || (r.status === 404 && path.startsWith('playlist'))) {
        throw new ApiError('Playlist not found. In YouTube Music, set its Privacy to Unlisted or Public, then try again.');
      }
      if (/quota/i.test(reason) || /quota/i.test(msg)) throw new ApiError("Today's free YouTube limit is used up. It resets overnight (midnight Pacific).");
      if (/REFERRER|referer/i.test(reason + msg)) throw new ApiError('YouTube refused the key from this address. The key is locked to calb417.github.io, so open Mixtape from there.');
      if (/keyInvalid|API key not valid/i.test(reason + msg)) throw new ApiError('YouTube says the key is not valid. Check the key at the top of app.js.');
      throw new ApiError('YouTube error: ' + msg);
    }
    return j;
  },
  parsePlaylistId(text) {
    const t = String(text || '').trim();
    const m = t.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    if (/^(PL|OL|RD|UU|LL|FL|VL)?[A-Za-z0-9_-]{10,}$/.test(t)) return t.replace(/^VL/, '');
    return '';
  },
  async playlistName(id) {
    const j = await this.get('playlists', { part: 'snippet', id, maxResults: 1 });
    const it = j.items && j.items[0];
    if (!it) throw new ApiError('Playlist not found. In YouTube Music, set its Privacy to Unlisted or Public, then try again.');
    return it.snippet.title;
  },
  async playlistItems(id, onProgress) {
    const out = [];
    let pageToken = '';
    let guard = 0;
    do {
      const j = await this.get('playlistItems', { part: 'snippet,contentDetails', playlistId: id, maxResults: 50, pageToken });
      (j.items || []).forEach((it) => {
        const item = cleanItem(it.snippet || {}, (it.contentDetails && it.contentDetails.videoId) || (it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId));
        if (item) out.push(item);
      });
      pageToken = j.nextPageToken || '';
      if (onProgress) onProgress(out.length, (j.pageInfo && j.pageInfo.totalResults) || 0);
      guard++;
    } while (pageToken && guard < 200);
    return out;
  },
  // A video's real length (1 unit per call), remembered. Lets the game tell an ad from the song.
  async duration(id) {
    const cache = Store.get('durs', {});
    if (cache[id]) return cache[id];
    const j = await this.get('videos', { part: 'contentDetails', id });
    const iso = (j.items && j.items[0] && j.items[0].contentDetails && j.items[0].contentDetails.duration) || '';
    const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
    const sec = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    if (sec) {
      cache[id] = sec;
      const keys = Object.keys(cache);
      if (keys.length > 6000) keys.slice(0, 1000).forEach((k) => delete cache[k]);
      Store.set('durs', cache, true);
    }
    return sec;
  },
  async searchSongs(q) {
    const j = await this.get('search', { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: 15, q });
    return (j.items || []).map((it) => {
      const sn = it.snippet || {};
      const item = cleanItem({ title: decodeEntities(sn.title), videoOwnerChannelTitle: sn.channelTitle }, it.id && it.id.videoId);
      if (item) item.thumb = sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || {}).url;
      return item;
    }).filter(Boolean);
  },
};
function decodeEntities(s) {
  const d = document.createElement('textarea');
  d.innerHTML = s || '';
  return d.value;
}
// Turn a YouTube playlist entry into { v: videoId, t: title, a: artist }
function cleanItem(sn, videoId) {
  if (!videoId) return null;
  let title = String(sn.title || '').trim();
  if (!title || /^(deleted|private) video$/i.test(title)) return null;
  const channel = String(sn.videoOwnerChannelTitle || '').trim();
  let artist = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official$/i, '').trim();
  if (!/ - Topic$/i.test(channel)) {
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m && (!artist || sim(m[1], artist) > 0.6 || channel === '')) { artist = m[1].trim(); title = m[2].trim(); }
    else if (m && sim(m[1], artist) <= 0.6) { artist = m[1].trim(); title = m[2].trim(); }
    title = title.replace(/\s*[\(\[][^\)\]]*(official|lyric|audio|video|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|remaster)[^\)\]]*[\)\]]/ig, '').trim();
  }
  return { v: videoId, t: title, a: artist };
}

/* ---------------- Album, year and cover art (Apple's free iTunes search) ---------------- */
function jsonp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cb = 'mxcb' + Date.now() + Math.floor(Math.random() * 1e6);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); try { delete window[cb]; } catch (e) { window[cb] = undefined; } s.remove(); }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('lookup failed')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
const Meta = {
  cache: null,
  load() { if (!this.cache) this.cache = Store.get('meta', {}); return this.cache; },
  save() {
    const keys = Object.keys(this.cache);
    if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach((k) => delete this.cache[k]);
    Store.set('meta', this.cache, true);
  },
  fallbackArt(v) { return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`; },
  async get(item) {
    const cache = this.load();
    if (cache[item.v]) return cache[item.v];
    let found = null;
    try {
      const params = new URLSearchParams({ term: `${item.a} ${item.t}`.slice(0, 120), entity: 'song', media: 'music', limit: '10' });
      const data = await jsonp('https://itunes.apple.com/search?' + params.toString());
      let best = null, bestScore = 0, year = '';
      (data.results || []).forEach((r) => {
        const s = sim(item.t, r.trackName) * 0.6 + sim(item.a, r.artistName) * 0.4;
        if (s > bestScore) { bestScore = s; best = r; }
        const y = String(r.releaseDate || '').slice(0, 4);
        if (s >= 0.8 && y && (!year || y < year)) year = y;   // earliest release, not the remaster
      });
      if (best && bestScore >= 0.7) {
        found = {
          album: String(best.collectionName || '').replace(/\s*-\s*(Single|EP)$/i, ''),
          year: year || String(best.releaseDate || '').slice(0, 4),
          art: String(best.artworkUrl100 || '').replace(/100x100bb/, '600x600bb'),
        };
      }
      if (typeof Year !== 'undefined') { const y = Year.known(item.a, item.t); if (found && y) found.year = String(y); }
    } catch (e) { /* lookups are best-effort */ }
    const meta = found || { album: '', year: '', art: '' };
    if (!meta.art) meta.art = this.fallbackArt(item.v);
    cache[item.v] = meta;
    this.save();
    return meta;
  },
};

/* ---------------- Router ---------------- */
const Views = {};
let currentView = null;
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
function route() {
  const name = (location.hash || '#home').slice(1).split('?')[0] || 'home';
  const view = Views[name] || Views.home;
  if (currentView && currentView.leave) currentView.leave();
  Sheets.closeAll();
  currentView = view;
  document.body.classList.toggle('locked', view === Views.game);
  $('#app').innerHTML = view.html();
  if (view.mount) view.mount($('#app'));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
// The game screen never moves: block page swipes except inside lists, panels and sliders.
document.addEventListener('touchmove', (e) => {
  if (!document.body.classList.contains('locked')) return;
  if (e.target.closest && e.target.closest('.sheet, .results, input[type=range], .yt-wrap.unlock')) return;
  e.preventDefault();
}, { passive: false });

/* ---------------- Open a song in the YouTube Music app ---------------- */
// Tries the app first; if the app doesn't open within a moment, opens the web page instead.
function openYTMusic(videoId, query) {
  const web = videoId ? 'https://music.youtube.com/watch?v=' + encodeURIComponent(videoId) : 'https://music.youtube.com/search?q=' + encodeURIComponent(query || '');
  const app = videoId ? 'youtubemusic://watch?v=' + encodeURIComponent(videoId) : 'youtubemusic://search?q=' + encodeURIComponent(query || '');
  let left = false;
  const onHide = () => { if (document.visibilityState === 'hidden') left = true; };
  document.addEventListener('visibilitychange', onHide);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left) window.open(web, '_blank');
  }, 1500);
  location.href = app;
}

/* ---------------- Home ---------------- */
Views.home = {
  html() {
    const pool = (typeof Pool !== 'undefined') ? Pool.label() : 'Popular songs';
    const clip = STOPS[Settings.get().clipIndex] || 0.5;
    return `<div class="screen">
      <header class="topbar">
        <div class="brand" style="color: var(--accent)">${ICON.tape}<h1 style="color: var(--text); margin:0; font-family: var(--display); font-weight: 800">Mixtape</h1></div>
        <div class="row" style="gap:6px">
          <button class="icon-btn" data-a="help" aria-label="Help">?</button>
          <button class="icon-btn" data-a="settings" aria-label="Settings">${ICON.gear}</button>
        </div>
      </header>
      <div class="home-body">
        <button class="jcard" data-a="game">
          <div class="kicker"><span>Side A · Game</span><span>${clip} s</span></div>
          <div class="big">Guess<br>the Intro</div>
          <div class="rule"></div>
          <div class="foot"><span class="pool">Pool: ${esc(pool)}</span><span class="pill">${ICON.play}Play</span></div>
        </button>
        <div class="tiles">
          ${tile('notes', 'Setlist Study Guide', 'Prep for your next show')}
          ${tile('list', 'Playlist Builder', 'Make, sort and fix playlists')}
          ${tile('pin', 'Concerts Near Me', 'Within 40 miles of Melville')}
          ${tile('diary', 'Concert Diary', "Every show you've seen")}
        </div>
        <button class="wide-tile" data-a="soon">
          <span class="row" style="align-items:center; gap:12px">${ICON.people}
            <span><span style="display:block; font-family: var(--display); font-weight:600; font-size:18px">My Artists</span>
            <span style="display:block; font-size:12.5px; color: var(--muted)">Bands you follow, in one place</span></span></span>
          <span class="soon" style="position:static; font-family: var(--mono); font-size:10px; letter-spacing:1px; color: var(--faint); border:1px solid var(--line); border-radius:999px; padding:3px 7px">SOON</span>
        </button>
      </div>
    </div>`;
    function tile(icon, t, d) {
      return `<button class="tile" data-a="soon"><span class="soon">SOON</span>${ICON[icon].replace('<svg', '<svg stroke="currentColor" style="color: var(--accent); width:26px; height:26px"')}
        <span class="t">${t}</span><span class="d">${d}</span></button>`;
    }
  },
  mount(root) {
    root.firstElementChild.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'help') showHelp('home');
      if (a === 'settings') go('#settings');
      if (a === 'game') go('#game');
      if (a === 'soon') toast('Coming in a later update');
    });
    firstVisit('home');
  },
};

/* ---------------- Settings ---------------- */
Views.settings = {
  html() {
    const s = Settings.get();
    const pools = Store.get('pools', []);
    const used = typeof SongFinder !== 'undefined' ? SongFinder.used() : 0;
    const remembered = Object.values(Store.get('songs', {})).filter(Boolean).length;
    return `<div class="screen">
      <header class="topbar">
        <button class="icon-btn" data-a="home" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>Settings</h1></div>
        <button class="icon-btn" data-a="help" aria-label="Help">?</button>
      </header>

      <div class="list-h">Screen</div>
      <div class="list">
        <label class="li"><span>Keep screen on while Mixtape is open<div class="sub">The phone still locks with the side button.</div></span>
          <span class="switch"><input type="checkbox" data-s="keepAwake" ${s.keepAwake ? 'checked' : ''}><span></span></span></label>
      </div>

      <div class="list-h">Game</div>
      <div class="list">
        <div class="li"><span>Song pool<div class="sub">${esc(typeof Pool !== 'undefined' ? Pool.label() : '')} · ${pools.length} saved playlist${pools.length === 1 ? '' : 's'}</div></span>
          <button class="btn small" data-a="pools">Change</button></div>
        <div class="li"><span>Song lookups today<div class="sub">${used} of 100 used · ${remembered} songs remembered</div></span></div>
        <div class="li"><span>Player log<div class="sub">What YouTube reported during the last few songs. Screenshot it for Claude if ads get through.</div></span>
          <button class="btn small" data-a="playerlog">View</button></div>
        <div class="li"><span>Last.fm key<div class="sub">${typeof LastFM !== 'undefined' && LastFM.ready() ? 'Added' : 'Not added yet (top of app.js)'}</div></span></div>
      </div>

      <div class="list-h">Saving</div>
      <div class="list">
        <div class="li"><span>This phone only<div class="sub">Sync with a code arrives in the next update.</div></span></div>
        <div class="li"><span>Backup file<div class="sub">Everything on this phone, in one file</div></span>
          <span class="row"><button class="btn small" data-a="export">Export</button><button class="btn small" data-a="import">Import</button></span></div>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>

      <details class="details">
        <summary>More</summary>
        <div class="list" style="margin: 8px 0 0 0">
          <div class="li"><span>Accent color</span><input type="color" data-c="accent" value="${esc(s.accent)}" aria-label="Accent color"></div>
          <div class="li"><span>Background color</span><input type="color" data-c="bg" value="${esc(s.bg)}" aria-label="Background color"></div>
          <div class="li"><span>Colors</span><button class="btn small" data-a="resetColors">Reset to black and orange</button></div>
          <div class="li" style="display:block"><div>Your own YouTube key (optional)<div class="sub">Leave empty to use the built-in key. A personal key gets its own daily limit.</div></div>
            <input class="field" style="margin-top:8px" data-s="ytKey" value="${esc(s.ytKey)}" placeholder="Paste a key, or leave empty" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
          <div class="li"><span>Error log<div class="sub">${Store.get('errorlog', []).length} saved</div></span><button class="btn small" data-a="errors">View</button></div>
          <div class="li"><span>Version</span><span class="muted mono">${APP_VERSION}</span></div>
        </div>
      </details>
      <div style="height: 30px"></div>
    </div>`;
  },
  mount(root) {
    root = root.firstElementChild;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'home') go('#home');
      if (a === 'help') showHelp('settings');
      if (a === 'pools') Game.openPools(() => route());
      if (a === 'export') Backup.export();
      if (a === 'import') $('#import-file').click();
      if (a === 'resetColors') { Settings.set({ accent: DEFAULTS.accent, bg: DEFAULTS.bg }); applyTheme(); route(); }
      if (a === 'playerlog') {
        const log = (Player.logList || Store.get('playerlog', [])).slice(-120);
        Sheets.open({ title: 'Player log', html: log.length ? `<p class="muted small" style="margin-top:0">Newest at the bottom. Each line: time, event, player state, position, length, video, sound.</p><pre class="plog">${esc(log.join('\n'))}</pre><button class="btn small" data-x="clearplog">Clear log</button>` : '<p>Nothing logged yet. Play a few songs first.</p>',
          onMount(body, close) {
            const pre = body.querySelector('.plog');
            if (pre) setTimeout(() => { body.parentElement.scrollTop = body.parentElement.scrollHeight; }, 50);
            const c = body.querySelector('[data-x=clearplog]');
            if (c) c.onclick = () => { Player.logList = []; Store.set('playerlog', []); close(); };
          } });
      }
      if (a === 'errors') {
        const log = Store.get('errorlog', []).slice().reverse();
        Sheets.open({ title: 'Error log', html: log.length ? log.map((l) => `<p class="mono" style="font-size:12px">${esc(l.at)}<br>${esc(l.text)}<br>${esc(l.extra || '')}</p>`).join('') + '<button class="btn small" data-x="clearlog">Clear log</button>' : '<p>No errors saved.</p>',
          onMount(body, close) { const c = body.querySelector('[data-x=clearlog]'); if (c) c.onclick = () => { Store.set('errorlog', []); close(); route(); }; } });
      }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.s === 'keepAwake') { Settings.set({ keepAwake: t.checked }); if (t.checked) Wake.on(); else Wake.off(); }
      if (t.dataset.s === 'ytKey') { Settings.set({ ytKey: t.value.trim() }); toast('Saved'); }
    });
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.c) { Settings.set({ [t.dataset.c]: t.value }); applyTheme(); }
    });
    $('#import-file').addEventListener('change', (e) => Backup.import(e.target.files && e.target.files[0]));
  },
};

/* ---------------- Backup ---------------- */
const Backup = {
  export() {
    const data = { app: 'Mixtape', version: APP_VERSION, savedAt: new Date().toISOString(), items: {} };
    Store.allKeys().forEach((k) => { if (k !== 'mixtape.errorlog') data.items[k] = localStorage.getItem(k); });
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mixtape-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    toast('Backup file made');
  },
  async import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'Mixtape' || !data.items) throw new Error('This is not a Mixtape backup file.');
      if (!confirm('Load this backup? It replaces what Mixtape has saved on this phone.')) return;
      Store.allKeys().forEach((k) => localStorage.removeItem(k));
      Object.entries(data.items).forEach(([k, v]) => { if (k.startsWith('mixtape.')) localStorage.setItem(k, v); });
      toast('Backup loaded');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      Errors.show('Could not load that backup: ' + e.message);
    }
  },
};

/* ---------------- Start ---------------- */
const STOPS = [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 15, 30, 60];
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  route();
  Wake.on();
});
