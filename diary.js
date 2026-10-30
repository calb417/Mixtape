'use strict';
/* Concert Diary: every show you've been to. Shows are typed in by hand for now (setlists can be typed
   or pasted); pulling a setlist from setlist.fm arrives with the relay. Needs app.js and info.js first. */

const Diary = {
  list() { return Store.get('diary', []); },
  save(list) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.added).localeCompare(String(a.added)));
    Store.set('diary', list);
  },
  get(id) { return this.list().find((e) => e.id === id); },
  put(entry) {
    const list = this.list().filter((e) => e.id !== entry.id);
    list.push(entry);
    this.save(list);
  },
  remove(id) { this.save(this.list().filter((e) => e.id !== id)); },
  newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
  // One song per line; strips numbering like "1." or "01 -" and blank lines
  parseSongs(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*(\d+[\.\)]?\s*[-–:]?\s*)/, '').replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  },
  acts(e) { return [e.artist].concat(e.with || []).filter(Boolean); },
  fmtDate(d) {
    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return d || '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  stars(n, cls = '') { n = +n || 0; return n ? `<span class="stars ${cls}">${'★'.repeat(n)}<span class="off">${'☆'.repeat(5 - n)}</span></span>` : ''; },
  matches(e, q) {
    if (!q) return true;
    if (/^\d{4}$/.test(q)) return String(e.date || '').startsWith(q);   // a year: exact
    return fuzzyScore(q, [e.artist, (e.with || []).join(' '), e.venue, e.city, String(e.date).slice(0, 4)].join(' ')) > 0;
  },
};

Views.diary = {
  html() {
    return `<div class="screen" id="diary-root">
      <header class="topbar">
        <button class="icon-btn" data-d="home" aria-label="Back">${ICON.back}</button>
        <div class="title"><h1>Concert Diary</h1></div>
        <button class="icon-btn" data-d="help" aria-label="Help">?</button>
      </header>
      <div class="pad" style="display:flex; flex-direction:column; gap:10px; margin-top:6px">
        <div class="row">
          <button class="btn primary" style="flex:1" data-d="add">+ Add a show</button>
          <button class="btn" style="flex:0 0 auto" data-d="stats">Stats</button>
        </div>
        <input class="search" data-d="q" placeholder="Search artist, venue, city or year" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
      <div data-d="list"></div>
      <div style="height:30px"></div>
    </div>`;
  },
  mount(root) {
    const el = root.firstElementChild;
    const $d = (k) => el.querySelector(`[data-d=${k}]`);
    const render = () => {
      const all = Diary.list();
      const q = $d('q').value.trim();
      const list = all.filter((e) => Diary.matches(e, q));
      if (!all.length) {
        $d('list').innerHTML = `<div class="pad"><p class="muted">No shows yet. Tap <b>Add a show</b> for every concert you remember: artist, date and venue are enough to start. Add the setlist, the openers, a rating and notes whenever you like.</p></div>`;
        return;
      }
      if (!list.length) { $d('list').innerHTML = '<p class="muted pad">No matches.</p>'; return; }
      const years = new Map();
      list.forEach((e) => { const y = String(e.date || '').slice(0, 4) || 'No date'; if (!years.has(y)) years.set(y, []); years.get(y).push(e); });
      $d('list').innerHTML = [...years.entries()].map(([y, es]) => `<div class="list-h">${esc(y)} · ${es.length} show${es.length === 1 ? '' : 's'}</div>
        <div class="my-list">${es.map((e) => `<button class="diary-row" data-d="open" data-id="${esc(e.id)}">
          <span class="dd"><b>${esc(Diary.fmtDate(e.date).replace(/, \d{4}$/, ''))}</b></span>
          <span class="main"><span class="n">${esc(e.artist)}${(e.with || []).length ? `<span class="muted"> + ${esc(e.with.join(', '))}</span>` : ''}</span>
          <span class="c">${esc([e.venue, e.city].filter(Boolean).join(' · '))}${e.rating ? ' ' + Diary.stars(e.rating, 'sm') : ''}${(e.sets || []).some((s) => s.songs.length) ? ' · setlist' : ''}</span></span>
          ${ICON.chev}</button>`).join('')}</div>`).join('');
    };
    this.render = render;
    render();
    $d('q').addEventListener('input', render);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      const k = b.dataset.d;
      if (k === 'home') go('#home');
      if (k === 'help') showHelp('diary');
      if (k === 'add') openShowEditor(null, render);
      if (k === 'open') openShow(b.dataset.id, render);
      if (k === 'stats') openDiaryStats();
    });
    firstVisit('diary');
  },
};

/* ---------------- One show ---------------- */
function openShow(id, onChange) {
  const e = Diary.get(id);
  if (!e) return;
  const sets = (e.sets || []).filter((s) => s.songs && s.songs.length);
  Sheets.open({
    title: Diary.fmtDate(e.date),
    card: true,
    html: `<div class="card-body">
      <div class="hero-name"><button class="tap link-plain" ${Cards.attrs('artist', { name: e.artist })}>${esc(e.artist)}</button></div>
      <div class="hero-meta">${esc([e.venue, e.city].filter(Boolean).join(' · '))}</div>
      ${e.rating ? `<div style="margin-top:6px">${Diary.stars(e.rating)}</div>` : ''}
      ${(e.with || []).length ? `<h3>Also on the bill</h3><div class="chips">${e.with.map((n) => `<button class="chip link" ${Cards.attrs('artist', { name: n })}>${esc(n)}</button>`).join('')}</div>` : ''}
      ${sets.map((s) => `<h3>${esc(s.act)} setlist <span class="muted small">${s.songs.length} songs</span></h3>
        <div class="rows">${s.songs.map((t, i) => `<button class="rowbtn" ${Cards.attrs('song', { artist: s.act, title: t })}><span><span class="num">${i + 1}</span>${esc(t)}</span></button>`).join('')}</div>`).join('')}
      ${e.notes ? `<h3>Notes</h3><p class="about">${esc(e.notes)}</p>` : ''}
      <div class="card-actions">
        <button class="btn small primary" data-s="edit">Edit</button>
        <button class="btn small" data-s="sfm">${ICON.out} Find on setlist.fm</button>
      </div>
      ${sets.length ? '' : '<p class="muted small">No setlist yet. Tap Edit to type or paste one. Pulling it from setlist.fm arrives with the sync update.</p>'}
    </div>`,
    onMount(body, close) {
      body.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-s]');
        if (!b) return;
        if (b.dataset.s === 'edit') { close(); setTimeout(() => openShowEditor(id, onChange), 330); }
        if (b.dataset.s === 'sfm') window.open('https://www.setlist.fm/search?query=' + encodeURIComponent([e.artist, e.venue, e.city].filter(Boolean).join(' ')), '_blank');
      });
    },
  });
}

/* ---------------- Add or edit a show ---------------- */
function openShowEditor(id, onChange) {
  const old = id ? Diary.get(id) : null;
  const e = old ? JSON.parse(JSON.stringify(old)) : { id: Diary.newId(), artist: '', with: [], date: '', venue: '', city: '', rating: 0, notes: '', sets: [], added: new Date().toISOString() };
  const setText = (act) => { const s = (e.sets || []).find((x) => norm(x.act) === norm(act)); return s ? s.songs.join('\n') : ''; };
  Sheets.open({
    title: old ? 'Edit show' : 'Add a show',
    html: `<label class="flabel">Artist<input class="field" data-f="artist" value="${esc(e.artist)}" placeholder="Who you went to see" autocomplete="off" autocapitalize="words" spellcheck="false"></label>
      <div class="ares" data-f="ares"></div>
      <div class="row" style="gap:10px">
        <label class="flabel" style="flex:1">Date<input class="field" type="date" data-f="date" value="${esc(e.date)}"></label>
        <label class="flabel" style="flex:1">Rating<span class="rate" data-f="rate"></span></label>
      </div>
      <label class="flabel">Venue<input class="field" data-f="venue" value="${esc(e.venue)}" placeholder="Madison Square Garden" autocomplete="off" autocapitalize="words"></label>
      <label class="flabel">City<input class="field" data-f="city" value="${esc(e.city)}" placeholder="New York, NY" autocomplete="off" autocapitalize="words"></label>
      <label class="flabel">Also on the bill<input class="field" data-f="with" value="${esc((e.with || []).join(', '))}" placeholder="Openers, separated by commas" autocomplete="off" autocapitalize="words"></label>
      <h3>Setlists</h3>
      <p class="muted small" style="margin-top:0">One song per line. Paste from setlist.fm or Notes; numbers in front are removed.</p>
      <div data-f="sets"></div>
      <label class="flabel">Notes<textarea class="field area" data-f="notes" rows="3" placeholder="Who you went with, highlights…">${esc(e.notes)}</textarea></label>
      <div class="row sheet-actions">
        ${old ? '<button class="btn" data-f="delete">Delete</button>' : ''}
        <button class="btn primary" style="flex:1" data-f="save">${old ? 'Save' : 'Add show'}</button>
      </div>`,
    onMount(body, close) {
      const $f = (k) => body.querySelector(`[data-f=${k}]`);
      const drawRate = () => {
        $f('rate').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= e.rating ? 'on' : ''}" data-f="star" data-n="${n}" aria-label="${n} star${n === 1 ? '' : 's'}">★</button>`).join('');
      };
      // One box per act. Existing boxes are kept as they are (so typing isn't interrupted);
      // boxes are only added or removed when the list of acts changes.
      const typed = {};
      const drawSets = () => {
        const box = $f('sets');
        const acts = [$f('artist').value.trim()].concat($f('with').value.split(',').map((x) => x.trim())).filter(Boolean);
        const have = new Map();
        box.querySelectorAll('details.setbox').forEach((d) => { const t = d.querySelector('textarea'); typed[norm(t.dataset.act)] = t.value; have.set(norm(t.dataset.act), d); });
        const hint = box.querySelector('p');
        if (hint) hint.remove();
        if (!acts.length) { box.innerHTML = '<p class="muted small">Type the artist first.</p>'; return; }
        const keep = new Set(acts.map(norm));
        have.forEach((d, k) => { if (!keep.has(k)) d.remove(); });
        acts.forEach((a, i) => {
          const k = norm(a);
          let d = have.get(k);
          if (!d) {
            const v = typed[k] !== undefined ? typed[k] : setText(a);
            d = document.createElement('details');
            d.className = 'setbox';
            if (v) d.open = true;
            d.innerHTML = `<summary>${esc(a)}</summary><textarea class="field area" data-f="set" data-act="${esc(a)}" rows="6" placeholder="Song one&#10;Song two&#10;…">${esc(v)}</textarea>`;
          }
          if (box.children[i] !== d) box.insertBefore(d, box.children[i] || null);
        });
      };
      drawRate();
      drawSets();
      // artist suggestions (Last.fm)
      let timer = null, seq = 0, sugg = [];
      $f('artist').addEventListener('input', () => {
        clearTimeout(timer);
        const q = $f('artist').value.trim();
        if (q.length < 2 || !LastFM.ready()) { $f('ares').innerHTML = ''; return; }
        timer = setTimeout(async () => {
          const my = ++seq;
          try {
            const list = await LastFM.searchArtists(q);
            if (my !== seq) return;
            sugg = list.slice(0, 4).filter((a) => norm(a.name) !== norm(q));
            $f('ares').innerHTML = sugg.map((a, i) => `<button type="button" class="rowbtn" data-f="pick" data-i="${i}"><span>${esc(a.name)}</span></button>`).join('');
          } catch (err) { $f('ares').innerHTML = ''; }
        }, 300);
      });
      $f('artist').addEventListener('change', drawSets);
      $f('with').addEventListener('change', drawSets);
      body.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-f]');
        if (!b || b.tagName === 'INPUT' || b.tagName === 'TEXTAREA') return;
        const k = b.dataset.f;
        if (k === 'pick') { const a = sugg[parseInt(b.dataset.i, 10)]; if (a) { $f('artist').value = a.name; $f('ares').innerHTML = ''; drawSets(); } }
        if (k === 'star') { const n = parseInt(b.dataset.n, 10); e.rating = e.rating === n ? 0 : n; drawRate(); }
        if (k === 'delete') {
          if (!confirm(`Delete ${e.artist} on ${Diary.fmtDate(e.date)}?`)) return;
          Diary.remove(e.id);
          close();
          if (onChange) onChange();
        }
        if (k === 'save') {
          const artist = $f('artist').value.trim(), date = $f('date').value;
          if (!artist) { toast('Add the artist'); $f('artist').focus(); return; }
          if (!date) { toast('Add the date'); $f('date').focus(); return; }
          body.querySelectorAll('[data-f=set]').forEach((t) => { typed[norm(t.dataset.act)] = t.value; });
          e.artist = artist;
          e.date = date;
          e.venue = $f('venue').value.trim();
          e.city = $f('city').value.trim();
          e.with = $f('with').value.split(',').map((x) => x.trim()).filter(Boolean);
          e.notes = $f('notes').value.trim();
          e.sets = Diary.acts(e).map((act) => ({ act, songs: Diary.parseSongs(typed[norm(act)] !== undefined ? typed[norm(act)] : setText(act)) })).filter((s) => s.songs.length);
          Diary.put(e);
          toast(old ? 'Saved' : 'Show added');
          close();
          if (onChange) onChange();
        }
      });
    },
  });
}

/* ---------------- Stats ---------------- */
function openDiaryStats() {
  const list = Diary.list();
  const count = (keyFn) => {
    const m = new Map();
    list.forEach((e) => [].concat(keyFn(e)).filter(Boolean).forEach((k) => { const n = norm(k); const x = m.get(n) || { label: k, n: 0 }; x.n++; m.set(n, x); }));
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  };
  const bars = (rows, max = 10, kind) => {
    if (!rows.length) return '<p class="muted small">Nothing yet.</p>';
    const top = rows[0].n;
    return '<div class="bars">' + rows.slice(0, max).map((r) => `<div class="bar-row">
      ${kind ? `<button class="tap bar-label" ${Cards.attrs(kind, kind === 'song' ? { artist: r.artist, title: r.label } : { name: r.label })}>${esc(r.label)}</button>` : `<span class="bar-label">${esc(r.label)}</span>`}
      <span class="bar"><i style="width:${Math.max(4, Math.round((r.n / top) * 100))}%"></i></span><span class="bar-n">${r.n}</span></div>`).join('') + '</div>';
  };
  const years = count((e) => String(e.date).slice(0, 4)).sort((a, b) => b.label.localeCompare(a.label));
  const artists = count((e) => Diary.acts(e));
  const venues = count((e) => e.venue);
  // songs heard live: counted per act + title
  const songs = new Map();
  list.forEach((e) => (e.sets || []).forEach((s) => s.songs.forEach((t) => { const k = norm(s.act) + '|' + norm(t); const x = songs.get(k) || { label: t, artist: s.act, n: 0 }; x.n++; songs.set(k, x); })));
  const songRows = [...songs.values()].filter((x) => x.n > 1).sort((a, b) => b.n - a.n).map((x) => Object.assign(x, { label: x.label }));
  Sheets.open({
    title: 'Diary stats',
    card: true,
    html: `<div class="card-body">
      <div class="facts"><div class="fact"><span class="k">Shows</span><span class="v">${list.length}</span></div>
        <div class="fact"><span class="k">Artists seen</span><span class="v">${artists.length}</span></div>
        <div class="fact"><span class="k">Venues</span><span class="v">${venues.length}</span></div>
        <div class="fact"><span class="k">Songs logged</span><span class="v">${list.reduce((n, e) => n + (e.sets || []).reduce((m, s) => m + s.songs.length, 0), 0)}</span></div></div>
      <h3>Shows per year</h3>${bars(years, 50)}
      <h3>Most-seen artists</h3>${bars(artists, 10, 'artist')}
      <h3>Most-visited venues</h3>${bars(venues, 10)}
      <h3>Songs heard live most often</h3>${songRows.length ? bars(songRows, 10, 'song') : '<p class="muted small">Shows up once a song is in two or more of your setlists.</p>'}
    </div>`,
  });
}
