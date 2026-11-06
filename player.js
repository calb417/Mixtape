'use strict';
/* The music player: a mini bar at the bottom of every screen (except the game) that opens a full player with
   play/pause, a scrub bar, previous/next, shuffle and the queue. Any song can be previewed from its card, and
   Playlist Builder lists, study guides, setlists and your YouTube Music playlists can be played whole.
   Plays while Mixtape is open and the phone unlocked. Needs app.js, info.js and game.js (YTPlayer) first. */

class MusicYT extends YTPlayer {
  // The first song needs one tap on the video for sound (an iPhone rule); after that it just plays
  finishUnlock() { this.hideUnlock(); this.unlocked = true; Music.drawBar(); }
}
const P3 = new MusicYT(3);

const Music = {
  queue: [], idx: -1, source: null, shuffle: false, playing: false, loadingSong: false, open: null, ticker: null,
  current() { return this.queue[this.idx] || null; },
  // Play a list (songs: { a, t, v? }), starting at one of them. source: { name, playlist? } for "Open in YouTube Music"
  play(songs, start = 0, source = null) {
    const list = songs.filter((s) => s && s.a && s.t).map((s) => ({ a: s.a, t: s.t, v: s.v || '' }));
    if (!list.length) { toast('Nothing to play'); return; }
    this.queue = list;
    this.source = source;
    if (this.shuffle) { const first = list[start]; const rest = shuffle(list.filter((x) => x !== first)); this.queue = [first].concat(rest); start = 0; }
    this.go(start);
    toast(source && source.name ? `Playing ${source.name}` : `Playing ${list[start].t}`);
  },
  // Play one song now; the rest of the queue carries on after it
  playNow(s) {
    if (!this.queue.length) { this.play([s], 0); return; }
    this.queue.splice(this.idx + 1, 0, { a: s.a, t: s.t, v: s.v || '' });
    this.source = null;
    this.go(this.idx + 1);
  },
  addNext(s) { if (!this.queue.length) { this.play([s]); return; } this.queue.splice(this.idx + 1, 0, { a: s.a, t: s.t, v: s.v || '' }); toast(`Up next: ${s.t}`); this.drawFull(); },
  async go(i) {
    if (i < 0 || i >= this.queue.length) { this.playing = false; this.drawBar(); return; }
    this.idx = i;
    const s = this.queue[i];
    const my = (this.loadToken = (this.loadToken || 0) + 1);
    this.loadingSong = true;
    this.drawBar(); this.drawFull();
    try {
      if (!s.v) s.v = await SongFinder.find(s.a, s.t) || '';
      if (my !== this.loadToken) return;
      if (!s.v) { toast(`Couldn't find ${s.t} on YouTube`); this.loadingSong = false; this.next(); return; }
      await P3.load();
      if (my !== this.loadToken) return;
      if (!P3.bound) {
        P3.bound = true;
        P3.on((st) => {
          if (st === 1) { this.playing = true; this.loadingSong = false; if (P3.wrap().classList.contains('unlock') && !P3.adPlaying()) P3.finishUnlock(); }
          if (st === 2) this.playing = false;
          if (st === 0) { this.playing = false; this.next(true); }
          this.drawBar(); this.drawFull();
        });
        P3.onError(() => { toast(`YouTube won't play ${(this.current() || {}).t || 'that song'} here; skipping`); this.next(true); });
      }
      if (typeof Game !== 'undefined' && Game.stopAll) Game.stopAll();
      P3.yt.loadVideoById(s.v);
      try { P3.yt.unMute(); P3.yt.setVolume(100); } catch (e) { /* ignore */ }
      // On iPhone the first song needs a tap on the video before it makes a sound
      if (!P3.unlocked) {
        const ok = await P3.waitFor([1], 2500);
        if (ok) P3.unlocked = true; else if (my === this.loadToken) P3.showUnlock();
      }
    } catch (e) {
      this.loadingSong = false;
      if (e instanceof LimitError) toast(e.message); else Errors.show(e.message || String(e), e instanceof ApiError ? '' : e);
    }
    this.drawBar(); this.drawFull();
  },
  toggle() {
    if (!P3.yt || !this.current()) return;
    try { if (this.playing) P3.yt.pauseVideo(); else P3.yt.playVideo(); } catch (e) { /* ignore */ }
  },
  pause() { try { if (P3.yt && this.playing) P3.yt.pauseVideo(); } catch (e) { /* ignore */ } },
  next(auto) {
    if (this.idx + 1 < this.queue.length) this.go(this.idx + 1);
    else { this.playing = false; if (!auto) toast('End of the queue'); this.drawBar(); this.drawFull(); }
  },
  prev() {
    if (P3.time() > 4 || this.idx === 0) { try { P3.yt.seekTo(0, true); } catch (e) { /* ignore */ } return; }
    this.go(this.idx - 1);
  },
  stop() {
    this.loadToken = (this.loadToken || 0) + 1;
    P3.reset();
    P3.bound = false;
    this.queue = []; this.idx = -1; this.playing = false; this.source = null;
    this.drawBar();
  },
  openInYTM() {
    const s = this.current();
    if (this.source && this.source.playlist) window.open(Builder.ytmUrl(this.source.playlist), '_blank');
    else if (s) openYTMusic(s.v, `${s.a} ${s.t}`);
  },
  thumb(v) { return v ? `https://i.ytimg.com/vi/${encodeURIComponent(v)}/mqdefault.jpg` : ''; },
  fmt(sec) { sec = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; },

  /* ---- the mini bar ---- */
  bar() {
    let b = document.getElementById('mini-player');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mini-player';
      b.addEventListener('click', (e) => {
        const k = e.target.closest('[data-mp]');
        if (!k) { this.openFull(); return; }
        e.stopPropagation();
        if (k.dataset.mp === 'toggle') this.toggle();
        if (k.dataset.mp === 'next') this.next();
        if (k.dataset.mp === 'close') this.stop();
      });
      document.body.appendChild(b);
    }
    return b;
  },
  drawBar() {
    const s = this.current();
    const onGame = (location.hash || '').startsWith('#game');
    const show = !!s && !onGame;
    document.body.classList.toggle('has-mini', show);
    const b = this.bar();
    b.hidden = !show;
    if (!show) return;
    b.innerHTML = `<span class="mp-art">${s.v ? `<img src="${this.thumb(s.v)}" alt="">` : ''}</span>
      <span class="mp-text"><span class="mp-t">${esc(s.t)}</span><span class="mp-a">${esc(this.loadingSong ? 'Loading…' : s.a)}${P3.wrap().classList.contains('unlock') ? ' · tap the video for sound' : ''}</span></span>
      <button class="icon-btn" data-mp="toggle" aria-label="${this.playing ? 'Pause' : 'Play'}">${this.playing ? ICON.pause : ICON.play}</button>
      <button class="icon-btn" data-mp="next" aria-label="Next">${ICON.next || '⏭'}</button>
      <button class="icon-btn sm" data-mp="close" aria-label="Stop and close the player">${ICON.close}</button>`;
  },

  /* ---- the full player ---- */
  openFull() {
    if (!this.current() || this.open) return;
    const close = Sheets.open({
      title: 'Now playing',
      html: '<div data-fp="body"></div>',
      onMount: (body) => {
        this.open = body;
        this.drawFull();
        body.addEventListener('input', (e) => { if (e.target.dataset.fp === 'scrub' && P3.yt) { this.scrubbing = true; body.querySelector('[data-fp=now]').textContent = this.fmt(+e.target.value); } });
        body.addEventListener('change', (e) => { if (e.target.dataset.fp === 'scrub' && P3.yt) { try { P3.yt.seekTo(+e.target.value, true); } catch (x) { /* ignore */ } this.scrubbing = false; } });
        body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-fp]');
          if (!b || b.tagName === 'INPUT') return;
          const k = b.dataset.fp;
          if (k === 'toggle') this.toggle();
          if (k === 'next') this.next();
          if (k === 'prev') this.prev();
          if (k === 'shuffle') { this.shuffle = !this.shuffle; if (this.shuffle && this.queue.length > 1) { const cur = this.current(); const rest = shuffle(this.queue.filter((x) => x !== cur)); this.queue = [cur].concat(rest); this.idx = 0; } this.drawFull(); }
          if (k === 'ytm') this.openInYTM();
          if (k === 'jump') this.go(+b.dataset.i);
          if (k === 'rm') { const i = +b.dataset.i; this.queue.splice(i, 1); if (i < this.idx) this.idx--; this.drawFull(); this.drawBar(); }
          if (k === 'card') { const s = this.current(); close(); setTimeout(() => Cards.open('song', { artist: s.a, title: s.t, v: s.v }), 330); }
          if (k === 'save') { const list = this.queue.slice(); Builder.chooseMix((mix) => { const n = Builder.addTo(mix, list); toast(`Added ${n} song${n === 1 ? '' : 's'} to ${mix.name}`); }); }
          if (k === 'stop') { close(); this.stop(); }
        });
        clearInterval(this.ticker);
        this.ticker = setInterval(() => this.tick(), 500);
      },
      onClose: () => { this.open = null; clearInterval(this.ticker); },
    });
  },
  tick() {
    if (!this.open || this.scrubbing) return;
    const r = this.open.querySelector('[data-fp=scrub]');
    if (!r) return;
    const d = P3.duration(), t = P3.time();
    r.max = String(Math.max(1, Math.floor(d)));
    r.value = String(Math.floor(t));
    this.open.querySelector('[data-fp=now]').textContent = this.fmt(t);
    this.open.querySelector('[data-fp=dur]').textContent = this.fmt(d);
  },
  drawFull() {
    const body = this.open;
    if (!body) return;
    const s = this.current();
    if (!s) { body.innerHTML = '<p class="muted">Nothing playing.</p>'; return; }
    const shown = this.queue.map((x, i) => ({ x, i })).slice(Math.max(0, this.idx - 2), this.idx + 60);
    body.innerHTML = `<div class="fp-art">${s.v ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(s.v)}/hqdefault.jpg" alt="">` : ''}</div>
      <button class="fp-title" data-fp="card"><span class="t">${esc(s.t)}</span><span class="a">${esc(s.a)}</span></button>
      <div class="fp-scrub"><input type="range" min="0" max="1" value="0" step="1" data-fp="scrub" aria-label="Position in the song"><div class="row" style="justify-content:space-between"><span class="muted small" data-fp="now">0:00</span><span class="muted small" data-fp="dur">0:00</span></div></div>
      <div class="fp-controls">
        <button class="icon-btn ${this.shuffle ? 'on' : ''}" data-fp="shuffle" aria-label="Shuffle" aria-pressed="${this.shuffle}">⤮</button>
        <button class="icon-btn big" data-fp="prev" aria-label="Previous">⏮</button>
        <button class="btn primary fp-play" data-fp="toggle" aria-label="${this.playing ? 'Pause' : 'Play'}">${this.loadingSong ? '…' : this.playing ? ICON.pause : ICON.play}</button>
        <button class="icon-btn big" data-fp="next" aria-label="Next">⏭</button>
        <button class="icon-btn" data-fp="stop" aria-label="Stop">■</button>
      </div>
      ${P3.wrap().classList.contains('unlock') ? '<p class="small" style="color:var(--accent); text-align:center">Tap the video on screen once to turn on sound.</p>' : ''}
      <div class="card-actions" style="justify-content:center">
        <button class="btn small" data-fp="ytm">${ICON.out} ${this.source && this.source.playlist ? 'Open the playlist in YouTube Music' : 'Open in YouTube Music'}</button>
        <button class="btn small" data-fp="save">+ Playlist</button>
      </div>
      <h3>Queue${this.source && this.source.name ? ` · ${esc(this.source.name)}` : ''} <span class="muted small">(${this.queue.length})</span></h3>
      <div class="rows">${shown.map(({ x, i }) => `<div class="rowbtn ${i === this.idx ? 'now' : ''}"><button class="tap" style="flex:1; min-width:0; text-align:left; background:none; border:none; color:inherit; padding:0" data-fp="jump" data-i="${i}"><span class="num">${i + 1}</span>${esc(x.t)}<span class="muted small" style="display:block">${esc(x.a)}</span></button>
        ${i === this.idx ? '<span class="small" style="color:var(--accent)">playing</span>' : `<button class="icon-btn sm" data-fp="rm" data-i="${i}" aria-label="Remove ${esc(x.t)}">${ICON.close}</button>`}</div>`).join('')}</div>
      <p class="muted small">Plays while Mixtape is open and the phone is unlocked. For a speaker group or the car, use Open in YouTube Music and cast from there.</p>`;
    this.tick();
  },
};
// Pause for the game, hide the bar there, show it everywhere else
window.addEventListener('hashchange', () => { if ((location.hash || '').startsWith('#game')) Music.pause(); Music.drawBar(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  e.stopPropagation();
  Music.playNow({ a: b.dataset.artist, t: b.dataset.title, v: b.dataset.v || '' });
}, true);
