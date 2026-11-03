'use strict';
/* Concerts Near Me: upcoming shows by My Artists within a set distance of home (Ticketmaster, plus SeatGeek
   when the relay has its key). Checked when the section opens; no notifications. Needs app.js, sync.js,
   info.js, artists.js, builder.js and study.js loaded first. */

const NEAR_DEFAULTS = { zip: '11747', place: 'Melville', lat: 40.7934, lon: -73.4151, miles: 40, hideNJ: false };
const Near = {
  settings() { return Object.assign({}, NEAR_DEFAULTS, Store.get('nearSettings', {})); },
  set(patch) { Store.set('nearSettings', Object.assign(this.settings(), patch)); },
  ready() { return Sync.has('ticketmaster'); },
  seatgeek() { return Sync.has('seatgeek'); },
  // Ticketmaster looks for shows around a point given as a "geohash"
  geohash(lat, lon, len = 7) {
    const B = '0123456789bcdefghjkmnpqrstuvwxyz';
    let la = [-90, 90], lo = [-180, 180], bit = 0, ch = 0, even = true, out = '';
    while (out.length < len) {
      const r = even ? lo : la, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
      if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
      even = !even;
      if (++bit === 5) { out += B[ch]; bit = 0; ch = 0; }
    }
    return out;
  },
  miles(lat1, lon1, lat2, lon2) {
    const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  },
  last: 0, chain: Promise.resolve(),
  // Ticketmaster through the relay, at most 4 a second
  async tm(params) {
    const p = (this.chain = this.chain.catch(() => {}).then(async () => {
      const wait = this.last + 260 - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const r = await Sync.req('/ticketmaster/events.json?' + new URLSearchParams(params));
      if (r.status === 401 || r.status === 403) throw new ApiError('Ticketmaster turned the key down. Check TICKETMASTER_KEY in Cloudflare (it\'s the Consumer Key).');
      if (r.status === 429) { await sleep(1500); throw new ApiError('Ticketmaster is busy. Try Refresh in a minute.'); }
      if (!r.ok) throw new ApiError('Ticketmaster error: HTTP ' + r.status);
      return r.json();
    }));
    return p;
  },
  async sg(params) {
    const r = await Sync.req('/seatgeek/events?' + new URLSearchParams(params));
    if (!r.ok) return { events: [] };
    return r.json();
  },
  // One Ticketmaster event in a simpler shape
  fromTM(e) {
    const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || {};
    const loc = v.location || {};
    const text = [e.info, e.pleaseNote].filter(Boolean).join(' ');
    const doors = text.match(/doors?(?: open)?(?: at)?:?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m)\b/i);
    const age = text.match(/\b(all ages|\d{2}\+|\d{2} and over)\b/i);
    const t = (e.dates && e.dates.start && e.dates.start.localTime) || '';
    const pr = (e.priceRanges || [])[0];
    return { id: 'tm:' + e.id, src: 'Ticketmaster', name: e.name || '', date: (e.dates && e.dates.start && e.dates.start.localDate) || '',
      time: t ? Timing.fmt(+t.slice(0, 2) * 60 + +t.slice(3, 5)) + (+t.slice(0, 2) >= 12 ? ' pm' : ' am') : '',
      tbd: !!(e.dates && e.dates.start && (e.dates.start.timeTBA || e.dates.start.dateTBA)),
      status: (e.dates && e.dates.status && e.dates.status.code) || '',
      venue: v.name || '', city: (v.city && v.city.name) || '', state: (v.state && v.state.stateCode) || '',
      lat: +loc.latitude || 0, lon: +loc.longitude || 0,
      acts: ((e._embedded && e._embedded.attractions) || []).map((a) => a.name).filter(Boolean),
      url: e.url || '', doors: doors ? doors[1] : '', age: age ? age[1] : (e.ageRestrictions && e.ageRestrictions.legalAgeEnforced ? 'Age limit applies' : ''),
      price: pr && pr.min ? `$${Math.round(pr.min)}${pr.max && pr.max !== pr.min ? '–$' + Math.round(pr.max) : ''}` : '' };
  },
  fromSG(e) {
    const v = e.venue || {}, loc = v.location || {};
    const dt = String(e.datetime_local || '');
    const h = +dt.slice(11, 13), m = +dt.slice(14, 16);
    return { id: 'sg:' + e.id, src: 'SeatGeek', name: e.title || '', date: dt.slice(0, 10), time: e.time_tbd ? '' : Timing.fmt(h * 60 + m) + (h >= 12 ? ' pm' : ' am'), tbd: !!e.time_tbd, status: '',
      venue: v.name || '', city: v.city || '', state: v.state || '', lat: +loc.lat || 0, lon: +loc.lon || 0,
      acts: (e.performers || []).map((p) => p.name).filter(Boolean), url: e.url || '', doors: '', age: '', price: e.stats && e.stats.lowest_price ? `from $${Math.round(e.stats.lowest_price)}` : '' };
  },
  // Upcoming shows for one artist near home (both sources, the same night at the same venue counted once)
  async artistShows(name) {
    const s = this.settings();
    const out = [];
    const j = await this.tm({ keyword: name, geoPoint: this.geohash(s.lat, s.lon), radius: String(s.miles), unit: 'miles', classificationName: 'music', size: '50', sort: 'date,asc' });
    ((j._embedded && j._embedded.events) || []).forEach((e) => out.push(this.fromTM(e)));
    if (this.seatgeek()) {
      const g = await this.sg({ q: name, lat: s.lat, lon: s.lon, range: s.miles + 'mi', 'taxonomies.name': 'concert', per_page: '50' }).catch(() => ({ events: [] }));
      (g.events || []).map((e) => this.fromSG(e)).forEach((x) => { if (!out.some((y) => y.date === x.date && sim(y.venue, x.venue) >= 0.6)) out.push(x); });
    }
    // only shows this artist is actually playing (not a tribute act, not a festival that just mentions the name)
    return out.filter((x) => x.acts.some((a) => this.same(a, name)) && x.date >= Study.today() && x.status !== 'cancelled')
      .map((x) => Object.assign(x, { artist: name, dist: x.lat ? Math.round(this.miles(s.lat, s.lon, x.lat, x.lon)) : null }))
      .filter((x) => x.dist == null || x.dist <= s.miles + 1)
      .filter((x) => x.state !== 'CT');                           // across the Sound: close on a map, a long drive
  },
  // The same act (not "Ten - A Pearl Jam Tribute", not "Pearl Jam Night")
  same(a, b) {
    const x = norm(a), y = norm(b);
    if (x === y) return true;
    if (/tribute|salute|experience|celebrat|night of|music of|songs of|vs\.? /i.test(a)) return false;
    return Math.abs(x.length - y.length) <= 3 && sim(a, b) >= 0.85;
  },
  cache() { return Store.get('nearCache', null); },
  shows() { const c = this.cache(); return c ? c.shows : []; },
  stale() { const c = this.cache(); return !c || Date.now() - c.at > 12 * 3600000 || c.key !== this.cacheKey(); },
  cacheKey() { const s = this.settings(); return [s.lat, s.lon, s.miles, MyArtists.list().map((a) => norm(a.name)).sort().join(',')].join('|'); },
  busy: false,
  async check(onProgress) {
    if (this.busy) return;
    this.busy = true;
    try {
      const artists = MyArtists.list();
      const all = [];
      let n = 0;
      for (const a of artists) {
        const list = await this.artistShows(a.name).catch((e) => { if (/key/i.test(e.message)) throw e; return []; });
        list.forEach((x) => { const same = all.find((y) => y.date === x.date && sim(y.venue, x.venue) >= 0.6); if (same) { if (!same.mine.includes(a.name)) same.mine.push(a.name); } else all.push(Object.assign(x, { mine: [a.name] })); });
        if (onProgress) onProgress(++n, artists.length);
      }
      all.sort((x, y) => x.date.localeCompare(y.date) || String(x.time).localeCompare(String(y.time)));
      Store.set('nearCache', { at: Date.now(), key: this.cacheKey(), shows: all }, true);
      return all;
    } finally { this.busy = false; }
  },
  parking(x) {
    const when = x.date + (x.time ? '' : '');
    return {
      spothero: `https://spothero.com/search?${new URLSearchParams({ latitude: x.lat, longitude: x.lon, starts: `${x.date}T${String(Math.max(0, (Timing.parse(x.time) || 1170) - 60) / 60 | 0).padStart(2, '0')}:00` })}`,
      parkwhiz: `https://www.parkwhiz.com/search/?${new URLSearchParams({ lat: x.lat, lng: x.lon, start: when })}`,
    };
  },
  tileText() {
    if (!this.ready()) return 'Within 40 miles of Melville';
    const n = this.shows().length;
    return this.cache() ? `${n} show${n === 1 ? '' : 's'} by My Artists` : `Within ${this.settings().miles} miles of ${this.settings().place}`;
  },
};

/* ---------------- One show ---------------- */
function openConcert(x) {
  const p = x.lat ? Near.parking(x) : null;
  Sheets.open({
    title: Study.fmt(x.date),
    card: true,
    html: `<div class="card-body">
      <div class="hero-name">${esc(x.name || x.artist)}</div>
      <div class="hero-meta">${esc([x.venue, [x.city, x.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}${x.dist != null ? ` · ${x.dist} mi` : ''}</div>
      <div class="facts">
        <div class="fact"><span class="k">Date</span><span class="v">${esc(Study.fmt(x.date))}</span></div>
        <div class="fact"><span class="k">Starts</span><span class="v">${esc(x.tbd ? 'TBA' : x.time || '—')}</span></div>
        ${x.doors ? `<div class="fact"><span class="k">Doors</span><span class="v">${esc(x.doors)}</span></div>` : ''}
        ${x.age ? `<div class="fact"><span class="k">Ages</span><span class="v">${esc(x.age)}</span></div>` : ''}
        ${x.price ? `<div class="fact"><span class="k">Tickets</span><span class="v">${esc(x.price)}</span></div>` : ''}
        <div class="fact"><span class="k">Sold by</span><span class="v">${esc(x.src)}</span></div>
      </div>
      ${x.acts.length ? `<h3>On the bill</h3><div class="chips">${x.acts.map((a) => `<button class="chip link" ${Cards.attrs('artist', { name: a })}>${esc(a)}</button>`).join('')}</div>` : ''}
      <div class="card-actions">
        ${x.url ? `<button class="btn small primary" data-c="tix">${ICON.out} Tickets</button>` : ''}
        <button class="btn small" data-c="study">Study this show</button>
        <button class="btn small" data-c="sets">Recent setlists</button>
        ${p ? '<button class="btn small" data-c="spot">Parking: SpotHero</button><button class="btn small" data-c="pw">Parking: ParkWhiz</button>' : ''}
      </div>
      <p class="muted small">Doors, start time and age limits show only when ${esc(x.src)} lists them.</p></div>`,
    onMount(body, close) {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        const k = b.dataset.c;
        if (k === 'tix') window.open(x.url, '_blank');
        if (k === 'spot') window.open(p.spothero, '_blank');
        if (k === 'pw') window.open(p.parkwhiz, '_blank');
        if (k === 'sets') openArtistSetlists(x.artist, '');
        if (k === 'study') {
          const old = Study.list().find((g) => g.date === x.date && sim(g.artist, x.artist) >= 0.85);
          if (old) { close(); go('#study?g=' + old.id); return; }
          const my = MyArtists.list().find((a) => sim(a.name, x.artist) >= 0.85);
          const g = Study.create(x.artist, (my && my.mbid) || '', x.date);
          g.venue = x.venue; g.city = [x.city, x.state].filter(Boolean).join(', ');
          if (x.time && !x.tbd) g.times.start = x.time;
          if (x.doors) g.times.doors = x.doors;
          if (x.age) g.times.age = x.age;
          x.acts.filter((a) => sim(a, x.artist) < 0.85).reverse().forEach((a) => g.acts.splice(g.acts.length - 1, 0, { name: a, mbid: '', on: false }));
          Study.put(g);
          close();
          go('#study?g=' + g.id + '&build=1');
        }
      });
    },
  });
}

/* ---------------- The Concerts Near Me screen ---------------- */
Views.near = {
  html() {
    return `<div class="screen">
      <header class="topbar">
        <button class="icon-btn" data-n="back" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>Concerts Near Me</h1></div>
        <button class="icon-btn" data-n="help" aria-label="Help">?</button>
      </header>
      <div data-n="body"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const body = el.querySelector('[data-n=body]');
    let status = '', extra = null, timer = null;
    const row = (x) => `<button class="diary-row" data-n="show" data-id="${esc(x.id)}">
        <span class="dd"><b>${esc(Study.fmt(x.date).replace(/, \d{4}$/, ''))}</b><br><span class="muted">${esc(new Date(x.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' }))}</span></span>
        <span class="main"><span class="n">${esc((x.mine || [x.artist]).join(' + '))}${x.acts.filter((a) => !(x.mine || [x.artist]).some((m) => sim(m, a) >= 0.85)).length ? `<span class="muted"> with ${esc(x.acts.filter((a) => !(x.mine || [x.artist]).some((m) => sim(m, a) >= 0.85)).slice(0, 2).join(', '))}</span>` : ''}</span>
        <span class="c">${esc([x.venue, x.city].filter(Boolean).join(' · '))}${x.dist != null ? ` · ${x.dist} mi` : ''}${x.time && !x.tbd ? ' · ' + esc(x.time) : ''}</span></span>${ICON.chev}</button>`;
    const draw = () => {
      const s = Near.settings();
      const shows = Near.shows();
      const ny = shows.filter((x) => x.state !== 'NJ'), nj = shows.filter((x) => x.state === 'NJ');
      const c = Near.cache();
      body.innerHTML = `${Near.ready() ? '' : `<div class="note-card"><b>Ticketmaster isn't connected yet.</b><span>The relay needs the free Ticketmaster key (TICKETMASTER_KEY).</span><button class="btn small" data-n="ping">Check again</button></div>`}
        <div class="pad muted small" style="margin-top:4px">${MyArtists.list().length} artists in My Artists · within <b>${s.miles} miles</b> of ${esc(s.place)} (${esc(s.zip)})${Near.seatgeek() ? ' · Ticketmaster + SeatGeek' : ' · Ticketmaster'}
          <br>${status ? esc(status) : c ? `Checked ${esc(new Date(c.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}.` : ''}
          <span class="row" style="gap:14px; margin-top:4px"><button class="link-btn" data-n="refresh" ${Near.busy ? 'disabled' : ''}>Refresh</button><button class="link-btn" data-n="opts">Distance and home</button></span></div>
        <div class="pad" style="margin-top:6px"><input class="search" data-n="q" placeholder="Check any artist near you" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div data-n="extra"></div>
        ${!MyArtists.list().length ? '<p class="pad muted">Add bands to My Artists (on the home screen) and their shows near you show up here.</p>' : ''}
        ${ny.length ? `<div class="list-h">New York · ${ny.length} show${ny.length === 1 ? '' : 's'}</div><div class="my-list">${ny.map(row).join('')}</div>` : (c && !status ? '<p class="pad muted">No shows in New York by My Artists right now.</p>' : '')}
        ${nj.length ? `<div class="list-h row" style="justify-content:space-between; align-items:center">New Jersey · ${nj.length}<label class="row" style="gap:6px; align-items:center; text-transform:none; letter-spacing:0; font-family:var(--body)">Hide <span class="switch" style="transform:scale(.8)"><input type="checkbox" data-n="hidenj" ${s.hideNJ ? 'checked' : ''}><span></span></span></label></div>
          ${s.hideNJ ? '' : `<div class="my-list">${nj.map(row).join('')}</div>`}` : ''}
        <p class="pad muted small">Connecticut venues are left out: close across the Sound, but a long drive.</p>`;
      drawExtra();
    };
    const drawExtra = () => {
      const box = body.querySelector('[data-n=extra]');
      if (!box || !extra) return;
      box.innerHTML = extra.loading ? '<p class="pad muted small">Checking…</p>'
        : `<div class="list-h">${esc(extra.name)} near you</div>${extra.list.length ? `<div class="my-list">${extra.list.map(row).join('')}</div>` : '<p class="pad muted small">No shows near you right now.</p>'}
          ${MyArtists.has(extra.name) ? '' : `<div class="pad"><button class="btn small" data-n="addmy">+ Add ${esc(extra.name)} to My Artists</button></div>`}`;
    };
    const refresh = async () => {
      if (!Near.ready() || !MyArtists.list().length) return;
      status = 'Checking…'; draw();
      try {
        await Near.check((n, total) => { status = `Checking ${n} of ${total} artists…`; const s = el.querySelector('[data-n=body] .pad.muted'); if (s) draw(); });
        status = '';
      } catch (e) { status = ''; Errors.show(e.message || String(e), e instanceof ApiError ? '' : e); }
      if (currentView === Views.near) draw();
    };
    this.redraw = draw;
    draw();
    if (Near.ready() && Near.stale()) refresh();

    body.addEventListener('input', (e) => {
      if (e.target.dataset.n !== 'q') return;
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (!q) { extra = null; body.querySelector('[data-n=extra]').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        if (!Near.ready()) return;
        const found = (await LastFM.searchArtists(q).catch(() => []))[0];
        const name = found ? found.name : q;
        extra = { name, loading: true, list: [] }; drawExtra();
        try { extra = { name, list: await Near.artistShows(name) }; } catch (err) { extra = null; Errors.show(err.message || String(err)); }
        drawExtra();
      }, 700);
    });
    body.addEventListener('change', (e) => { if (e.target.dataset.n === 'hidenj') { Near.set({ hideNJ: e.target.checked }); draw(); } });
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-n]');
      if (!b || b.tagName === 'INPUT') return;
      const k = b.dataset.n;
      if (k === 'show') { const x = Near.shows().concat(extra ? extra.list : []).find((y) => y.id === b.dataset.id); if (x) openConcert(x); }
      if (k === 'refresh') refresh();
      if (k === 'ping') { b.disabled = true; await Sync.ping().catch(() => {}); draw(); if (Near.ready()) refresh(); }
      if (k === 'addmy' && extra) { MyArtists.add(extra.name); toast(`Added ${extra.name}`); drawExtra(); }
      if (k === 'opts') openNearSettings(() => { draw(); refresh(); });
    });
    el.querySelector('[data-n=back]').onclick = () => go('#home');
    el.querySelector('[data-n=help]').onclick = () => showHelp('near');
    firstVisit('near');
  },
};
function openNearSettings(onDone) {
  const s = Near.settings();
  Sheets.open({
    title: 'Distance and home',
    html: `<label class="flabel">Miles from home (straight line)<input class="field" data-o="miles" value="${s.miles}" inputmode="numeric"></label>
      <p class="muted small">40 miles from Melville reaches every NYC borough (Manhattan and Brooklyn arenas are about 31) and MetLife (about 35) and Prudential Center (about 40) in New Jersey.</p>
      <label class="flabel">Home ZIP code<input class="field" data-o="zip" value="${esc(s.zip)}" inputmode="numeric"></label>
      <p class="muted small" data-o="st"></p>
      <div class="row sheet-actions"><button class="btn primary wide" data-o="save">Save</button></div>`,
    onMount(body, close) {
      body.querySelector('[data-o=save]').onclick = async () => {
        const miles = Math.max(5, Math.min(150, parseInt(body.querySelector('[data-o=miles]').value, 10) || 40));
        const zip = body.querySelector('[data-o=zip]').value.trim();
        const patch = { miles };
        if (zip && zip !== s.zip) {
          try {
            const j = await getJSON('https://api.zippopotam.us/us/' + encodeURIComponent(zip), 'the ZIP code lookup');
            const pl = j && j.places && j.places[0];
            if (!pl) { body.querySelector('[data-o=st]').textContent = "Couldn't find that ZIP code."; return; }
            Object.assign(patch, { zip, place: pl['place name'], lat: +pl.latitude, lon: +pl.longitude });
          } catch (e) { body.querySelector('[data-o=st]').textContent = e.message; return; }
        }
        Near.set(patch);
        close();
        onDone();
      };
    },
  });
}
// Artist cards: upcoming shows near you
async function nearLine(name) {
  if (!Near.ready()) return '';
  const list = await Near.artistShows(name).catch(() => []);
  if (!list.length) return `<p class="muted small">No ${esc(name)} shows within ${Near.settings().miles} miles right now.</p>`;
  window.__nearCard = list;
  return `<h3>Upcoming near you</h3><div class="rows">${list.slice(0, 6).map((x, i) => `<button class="rowbtn" data-nearshow="${i}"><span>${esc(Study.fmt(x.date))}<span class="muted small" style="display:block">${esc([x.venue, x.city].filter(Boolean).join(' · '))}${x.dist != null ? ` · ${x.dist} mi` : ''}</span></span>${ICON.chev}</button>`).join('')}</div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-nearshow]');
  if (b && window.__nearCard) openConcert(window.__nearCard[+b.dataset.nearshow]);
});

HELP.near = {
  title: 'Concerts Near Me',
  html: `<p>Upcoming shows by everyone in My Artists, within ${NEAR_DEFAULTS.miles} miles of home (change it with <b>Distance and home</b>). Mixtape checks when you open this screen, at most every 12 hours; <b>Refresh</b> checks now. There are no notifications.</p>
    <ul><li>New York shows come first; New Jersey shows are in their own group with a switch to hide them. Connecticut venues are left out.</li>
    <li>Tap a show for the date, start time, doors and age limit (when the ticket seller lists them), who's on the bill, and buttons for <b>Tickets</b>, <b>Study this show</b> (opens the Setlist Study Guide with everything filled in), <b>Recent setlists</b>, and parking on SpotHero or ParkWhiz.</li>
    <li><b>Check any artist near you</b> looks up a band that isn't in My Artists.</li></ul>
    <p>Shows come from Ticketmaster, so shows sold only by AXS or a small venue may be missing. Artist cards show upcoming shows near you too.</p>`,
};
