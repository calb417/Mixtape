'use strict';
/* Guess the Intro + DJ Mode. Needs app.js loaded first. */

/* ---------------- The YouTube player ---------------- */
const Player = {
  yt: null,
  loading: null,
  state: -1,
  listeners: new Set(),
  errorListeners: new Set(),
  load() {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The YouTube player took too long to load. Check the connection and try again.')), 20000);
      window.onYouTubeIframeAPIReady = () => {
        this.yt = new YT.Player('yt-player', {
          width: 300,
          height: 170,
          playerVars: { playsinline: 1, controls: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => { clearTimeout(timer); resolve(); },
            onStateChange: (e) => {
              this.state = e.data;
              if (e.data === 1 && $('#yt-wrap').classList.contains('unlock')) this.finishUnlock();
              this.listeners.forEach((fn) => fn(e.data));
            },
            onError: (e) => this.errorListeners.forEach((fn) => fn(e.data)),
          },
        });
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { clearTimeout(timer); reject(new Error('Could not load the YouTube player. Check the connection.')); };
      document.head.appendChild(s);
    });
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  },
  waitFor(states, ms) {
    return new Promise((resolve) => {
      if (states.includes(this.state)) { resolve(true); return; }
      const off = this.on((s) => { if (states.includes(s)) { off(); clearTimeout(t); resolve(true); } });
      const t = setTimeout(() => { off(); resolve(false); }, ms);
    });
  },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  onError(fn) { this.errorListeners.add(fn); return () => this.errorListeners.delete(fn); },
  // iPhone sometimes wants one real tap on the video before it allows sound.
  showUnlock() { $('#yt-wrap').classList.add('unlock'); },
  finishUnlock() {
    $('#yt-wrap').classList.remove('unlock');
    try { this.yt.pauseVideo(); } catch (e) { /* ignore */ }
    Game.unlocked = true;
    toast('Sound is on. Tap Play clip.');
  },
  stop() { try { if (this.yt) this.yt.pauseVideo(); } catch (e) { /* ignore */ } },
};

/* ---------------- Game ---------------- */
const Game = {
  mode: 'guess',          // 'guess' | 'dj'
  djPicking: true,
  items: [],
  queue: [],
  seen: new Set(),
  round: null,
  count: 0,
  clipTimer: null,
  token: 0,
  unlocked: false,
  offs: [],

  /* ---- pools ---- */
  pools() { return Store.get('pools', []); },
  currentPoolId() { return Store.get('currentPool', ''); },
  poolLabel() {
    const p = this.pools().find((x) => x.id === this.currentPoolId());
    return p ? p.name : 'Pick a playlist';
  },
  loadItems() {
    const id = this.currentPoolId();
    this.items = id ? Store.get('pool.' + id, []) : [];
    this.queue = [];
  },
  nextItem() {
    const never = new Set(Store.get('neverUse', []));
    const blocked = new Set(Store.get('blocked', []));
    const usable = (it) => !never.has(it.v) && !blocked.has(it.v);
    for (let pass = 0; pass < 2; pass++) {
      while (this.queue.length) {
        const it = this.queue.shift();
        if (usable(it) && !this.seen.has(it.v)) return it;
      }
      let fresh = this.items.filter((it) => usable(it) && !this.seen.has(it.v));
      if (!fresh.length) {
        fresh = this.items.filter(usable);
        if (fresh.length && this.seen.size) toast("You've heard every song in this pool. Starting over.");
        this.seen.clear();
      }
      this.queue = shuffle(fresh.slice());
    }
    return null;
  },

  openPools(onDone) {
    const self = this;
    const render = () => {
      const pools = self.pools();
      const cur = self.currentPoolId();
      return `<p class="muted" style="margin-top:0">Pick the playlist the game draws songs from. <button class="link-btn" data-p="how">How to add one</button></p>
        ${pools.map((p) => `<div class="pool-item ${p.id === cur ? 'on' : ''}">
          <button class="main" data-p="use" data-id="${esc(p.id)}"><div class="n">${esc(p.name)}${p.id === cur ? ' ✓' : ''}</div><div class="c">${p.count} songs · updated ${esc((p.updated || '').slice(0, 10))}</div></button>
          <button class="btn small" data-p="refresh" data-id="${esc(p.id)}">Refresh</button>
          <button class="icon-btn" data-p="remove" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${ICON.close}</button>
        </div>`).join('') || '<p>No playlists yet.</p>'}
        <h3>Add a YouTube Music playlist</h3>
        <input class="field" data-p="link" placeholder="Paste the playlist link" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="row" style="margin-top:10px"><button class="btn primary wide" data-p="add">Add</button></div>
        <p class="muted" data-p="status" style="min-height:22px"></p>`;
    };
    Sheets.open({
      title: 'Song pools',
      html: render(),
      onMount(body, close) {
        const status = (t) => { const s = body.querySelector('[data-p=status]'); if (s) s.textContent = t; };
        const refreshUI = () => { body.innerHTML = render(); };
        const fetchPool = async (id, existingName) => {
          status('Reading the playlist…');
          const name = existingName || await YTData.playlistName(id);
          const items = await YTData.playlistItems(id, (n, total) => status(`Reading the playlist… ${n}${total ? ' of ' + total : ''} songs`));
          if (!items.length) throw new ApiError('That playlist has no playable songs.');
          Store.set('pool.' + id, items);
          const pools = self.pools().filter((p) => p.id !== id);
          pools.push({ id, name, count: items.length, updated: new Date().toISOString() });
          Store.set('pools', pools);
          Store.set('currentPool', id);
          self.loadItems();
          return { name, count: items.length };
        };
        body.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-p]');
          if (!b) return;
          const p = b.dataset.p;
          try {
            if (p === 'how') showHelp('pools');
            if (p === 'use') { Store.set('currentPool', b.dataset.id); self.loadItems(); close(); if (onDone) onDone(); }
            if (p === 'remove') {
              const pool = self.pools().find((x) => x.id === b.dataset.id);
              if (pool && confirm(`Remove "${pool.name}" from Mixtape? (It stays in YouTube Music.)`)) {
                Store.set('pools', self.pools().filter((x) => x.id !== pool.id));
                Store.del('pool.' + pool.id);
                if (self.currentPoolId() === pool.id) { Store.set('currentPool', ''); self.loadItems(); }
                refreshUI();
              }
            }
            if (p === 'refresh') {
              b.disabled = true;
              const pool = self.pools().find((x) => x.id === b.dataset.id);
              const r = await fetchPool(b.dataset.id, pool && pool.name);
              refreshUI();
              toast(`${r.name}: ${r.count} songs`);
            }
            if (p === 'add') {
              const link = body.querySelector('[data-p=link]').value;
              const id = YTData.parsePlaylistId(link);
              if (!id) { status("That doesn't look like a playlist link. In YouTube Music: playlist → ⋯ → Share → Copy link."); return; }
              b.disabled = true;
              const r = await fetchPool(id);
              toast(`Added ${r.name}: ${r.count} songs`);
              close();
              if (onDone) onDone();
            }
          } catch (err) {
            b.disabled = false;
            status('');
            Errors.show(err.message || String(err), err instanceof ApiError ? '' : err);
          }
        });
      },
    });
  },

  /* ---- screen ---- */
  html() {
    const dj = this.mode === 'dj';
    const s = Settings.get();
    const idx = Math.max(0, Math.min(STOPS.length - 1, s.clipIndex));
    return `<div class="screen" id="game-root">
      <header class="topbar">
        <button class="icon-btn" data-g="home" aria-label="Back to home">${ICON.back}</button>
        <div class="title"><h1>Guess the Intro</h1><div class="sub" id="g-sub">${dj ? 'DJ mode' : 'Song ' + (this.count || 1)}</div></div>
        <button class="icon-btn" data-g="help" aria-label="Help">?</button>
      </header>
      <div class="mode-switch" role="tablist">
        <button data-g="mode-guess" class="${dj ? '' : 'on'}" role="tab" aria-selected="${!dj}">Guess</button>
        <button data-g="mode-dj" class="${dj ? 'on' : ''}" role="tab" aria-selected="${dj}">DJ</button>
      </div>
      <button class="pool-bar" data-g="pools"><span class="name">Pool: ${esc(this.poolLabel())}</span><span class="chg">Change</span></button>

      <div id="dj-pick" class="dj-pick" ${dj && this.djPicking ? '' : 'hidden'}>
        <input class="search" id="dj-q" placeholder="Search this pool…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn small" data-g="dj-yt" style="align-self:flex-start">Search all of YouTube instead</button>
        <div class="results" id="dj-results"></div>
      </div>

      <div id="play-area" ${dj && this.djPicking ? 'hidden' : ''}>
        <div class="dj-info" id="dj-info" ${dj ? '' : 'hidden'}></div>
        <div class="card-wrap">
          <div class="flip">
            <div class="face front">
              <div class="top"><span>SIDE A</span><span>MIXTAPE</span></div>
              <div class="lines"><i></i><i></i><div class="q">?</div><i></i><i></i></div>
              <div class="cap" id="g-cap">Name that song</div>
            </div>
            <div class="face back" id="g-back"><span class="noart">ALBUM ART</span></div>
          </div>
        </div>

        <div class="stage">
          <div class="layer info">
            <div class="song-title" id="g-title"></div>
            <div class="song-artist" id="g-artist"></div>
            <div class="song-album" id="g-album"></div>
            <div class="song-note" id="g-note"></div>
            <div class="info-actions">
              <button class="btn small" data-g="restart">${ICON.restart} From start</button>
              <button class="btn small" data-g="ytm">${ICON.out} YouTube Music</button>
              <button class="btn small ghost" data-g="never">Never use</button>
            </div>
          </div>
          <div class="layer controls">
            <div class="clip">
              <div class="clip-head"><span class="muted" style="font-size:13px">Clip length</span><span class="v" id="g-len"></span></div>
              <div class="clip-row">
                <button class="icon-btn" data-g="shorter" aria-label="Shorter clip">−</button>
                <input type="range" id="g-slider" min="0" max="${STOPS.length - 1}" step="1" value="${idx}" aria-label="Clip length">
                <button class="icon-btn" data-g="longer" aria-label="Longer clip">+</button>
              </div>
              <div class="clip-scale"><span>0.1</span><span>1</span><span>60 s</span></div>
            </div>
            <div class="pad" style="margin-top:14px">
              <button class="btn big primary wide" data-g="play" id="g-play">${ICON.play} Play clip</button>
            </div>
            <div class="row pad" style="margin-top:10px">
              <button class="btn" style="flex:1" data-g="more" id="g-more">More time</button>
              <button class="btn" style="flex:1" data-g="skip">Skip silence</button>
            </div>
            <div class="start-at" id="g-start"></div>
            <div class="start-tools" id="g-tools" hidden>
              <button class="btn" data-g="undo">Undo</button>
              <button class="btn" data-g="back">−0.25 s</button>
              <button class="btn" data-g="zero">0:00</button>
            </div>
          </div>
        </div>

        <div class="bottom-bar">
          <div class="layer controls">
            <button class="btn ghost" style="width:96px" data-g="pass">Pass</button>
            <button class="btn light" style="flex:1" data-g="reveal" id="g-reveal">Reveal</button>
          </div>
          <div class="layer info">
            ${dj
              ? '<button class="btn" style="flex:1" data-g="dj-again">Pick again</button><button class="btn primary" style="flex:1.4" data-g="dj-pass">Pass the phone</button>'
              : '<button class="btn primary" style="flex:1" data-g="next">Next song</button>'}
          </div>
        </div>
      </div>
    </div>`;
  },

  mount(root) {
    this.root = root.querySelector('#game-root');
    this.loadItems();
    this.bind();
    this.updateClipUI();
    this.offs.push(Player.onError((code) => this.onPlayerError(code)));
    Player.load().catch((e) => Errors.show(e.message));
    if (this.items.length) firstVisit('game');
    if (this.mode === 'dj') {
      if (this.djPicking) this.renderDJResults('');
      else this.renderDJInfo();
      return;
    }
    if (!this.items.length) {
      $('#g-cap').textContent = 'Pick a pool to start';
      this.setEnabled(false);
      setTimeout(() => this.openPools(() => route()), 400);
      return;
    }
    if (!this.round || !this.round.item) this.startRound(this.nextItem());
    else this.restoreRound();
  },
  leave() {
    clearTimeout(this.clipTimer);
    this.token++;
    Player.stop();
    this.offs.forEach((off) => off());
    this.offs = [];
  },

  bind() {
    const r = this.root;
    r.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const a = b.dataset.g;
      const map = {
        home: () => go('#home'),
        help: () => showHelp('game'),
        pools: () => this.openPools(() => { this.round = null; route(); }),
        'mode-guess': () => { if (this.mode !== 'guess') { this.mode = 'guess'; this.round = null; route(); } },
        'mode-dj': () => { if (this.mode !== 'dj') { this.mode = 'dj'; this.djPicking = true; this.round = null; Player.stop(); route(); } },
        play: () => this.playClip(),
        more: () => this.moreTime(),
        skip: () => this.skipSilence(),
        undo: () => this.setStart(this.round.undo.length ? this.round.undo.pop() : 0),
        back: () => this.setStart(Math.max(0, this.round.start - 0.25)),
        zero: () => { this.round.undo.push(this.round.start); this.setStart(0); },
        shorter: () => this.setClipIndex(Settings.get().clipIndex - 1),
        longer: () => this.setClipIndex(Settings.get().clipIndex + 1),
        reveal: () => this.reveal(),
        pass: () => this.next(true),
        next: () => this.next(false),
        restart: () => { try { Player.yt.seekTo(0, true); Player.yt.unMute(); Player.yt.playVideo(); } catch (err) { /* ignore */ } },
        ytm: () => { if (this.round) window.open('https://music.youtube.com/watch?v=' + this.round.item.v, '_blank'); },
        never: () => this.neverUse(),
        'dj-yt': () => this.djSearchYouTube(),
        'dj-again': () => { this.unreveal(); setTimeout(() => this.showDJPick(), 380); },
        'dj-pass': () => this.passPhone(),
      };
      if (map[a]) {
        if (this.round == null && ['undo', 'back', 'zero', 'skip', 'more', 'play', 'reveal'].includes(a)) return;
        map[a]();
      }
    });
    const slider = r.querySelector('#g-slider');
    if (slider) slider.addEventListener('input', () => this.setClipIndex(parseInt(slider.value, 10)));
    const q = r.querySelector('#dj-q');
    if (q) {
      q.addEventListener('input', () => { clearTimeout(this.djTimer); this.djTimer = setTimeout(() => this.renderDJResults(q.value), 120); });
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(this.djTimer); this.renderDJResults(q.value); } });
    }
    const res = r.querySelector('#dj-results');
    if (res) res.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const item = this.djCandidates[parseInt(b.dataset.pick, 10)];
      if (item) this.djChoose(item);
    });
  },

  setEnabled(on) {
    ['g-play', 'g-reveal', 'g-more'].forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = !on; });
  },

  /* ---- clip length ---- */
  setClipIndex(i) {
    i = Math.max(0, Math.min(STOPS.length - 1, i));
    Settings.set({ clipIndex: i });
    if (this.round) { this.round.base = STOPS[i]; this.round.len = STOPS[i]; }
    this.updateClipUI();
  },
  updateClipUI() {
    const i = Settings.get().clipIndex;
    const slider = $('#g-slider');
    if (slider) {
      slider.value = i;
      slider.style.setProperty('--fill', (i / (STOPS.length - 1)) * 100 + '%');
    }
    const base = STOPS[i];
    const len = this.round ? this.round.len : base;
    const lenEl = $('#g-len');
    if (lenEl) lenEl.textContent = fmtSec(len);
    const more = $('#g-more');
    if (more) more.textContent = `More time +${fmtSec(this.round ? this.round.base : base)}`;
    const st = $('#g-start');
    const tools = $('#g-tools');
    if (st && this.round) {
      st.textContent = `starts at ${this.round.start.toFixed(2).replace(/0$/, '')} s`;
      if (tools) tools.hidden = !(this.round.start > 0 || this.round.undo.length);
    } else if (st) st.textContent = 'starts at 0.0 s';
  },

  /* ---- rounds ---- */
  async startRound(item) {
    clearTimeout(this.clipTimer);
    this.token++;
    if (!item) {
      $('#g-cap').textContent = 'No songs left to play in this pool';
      this.setEnabled(false);
      return;
    }
    const base = STOPS[Settings.get().clipIndex];
    this.round = { item, base, len: base, start: 0, undo: [], tries: 0, heard: 0, phase: 'loading', meta: null };
    this.count += 1;
    if (this.mode === 'guess') { const sub = $('#g-sub'); if (sub) sub.textContent = 'Song ' + this.count; }
    this.seen.add(item.v);
    this.root.classList.remove('revealed');
    this.fillInfo();
    this.updateClipUI();
    this.setEnabled(false);
    $('#g-cap').textContent = 'Loading the song…';
    Meta.get(item).then((meta) => { if (this.round && this.round.item === item) { this.round.meta = meta; this.fillInfo(); } });
    try {
      await Player.load();
      await this.preload(item);
    } catch (e) {
      Errors.show(e.message || String(e));
      return;
    }
  },
  async preload(item) {
    const myToken = ++this.token;
    const yt = Player.yt;
    yt.mute();
    yt.loadVideoById({ videoId: item.v, startSeconds: 0 });
    const ok = await Player.waitFor([1], 5000);
    if (myToken !== this.token) return;
    try { yt.pauseVideo(); yt.seekTo(0, true); } catch (e) { /* ignore */ }
    this.round.phase = 'ready';
    this.setEnabled(true);
    $('#g-cap').textContent = ok ? 'Name that song' : 'Name that song (tap Play clip)';
  },
  restoreRound() {
    this.fillInfo();
    this.updateClipUI();
    if (this.round.phase === 'revealed') { this.root.classList.add('revealed'); return; }
    this.round.phase = 'loading';
    this.setEnabled(false);
    $('#g-cap').textContent = 'Loading the song…';
    Player.load().then(() => this.preload(this.round.item)).catch((e) => Errors.show(e.message || String(e)));
  },
  fillInfo() {
    const r = this.round;
    if (!r) return;
    const m = r.meta || {};
    $('#g-title').textContent = r.item.t;
    $('#g-artist').textContent = r.item.a;
    $('#g-album').textContent = [m.album, m.year].filter(Boolean).join(' · ');
    $('#g-note').textContent = r.heard ? `heard at ${fmtSec(r.heard)} · ${r.tries} ${r.tries === 1 ? 'try' : 'tries'}` : 'revealed without a clip';
    const back = $('#g-back');
    if (back) {
      const art = m.art || Meta.fallbackArt(r.item.v);
      if (!back.querySelector('img') || back.querySelector('img').dataset.src !== art) {
        back.innerHTML = `<img alt="Album art" data-src="${esc(art)}" src="${esc(art)}">`;
        const img = back.querySelector('img');
        img.onerror = () => { const fb = Meta.fallbackArt(r.item.v); if (img.src !== fb) img.src = fb; else back.innerHTML = '<div class="noart">NO ALBUM ART</div>'; };
      }
    }
    if (this.mode === 'dj') this.renderDJInfo();
  },

  async playClip() {
    const r = this.round;
    if (!r || r.phase === 'loading' || r.phase === 'revealed') return;
    const yt = Player.yt;
    clearTimeout(this.clipTimer);
    const myToken = ++this.token;
    r.phase = 'playing';
    try {
      yt.seekTo(r.start, true);
      yt.unMute();
      yt.setVolume(100);
      yt.playVideo();
    } catch (e) { Errors.show('Could not play the clip.', e); return; }
    const started = await Player.waitFor([1], 2500);
    if (myToken !== this.token) return;
    if (!started) {
      r.phase = 'ready';
      if (!this.unlocked) Player.showUnlock();
      else toast('The song is still loading. Try Play clip again.');
      return;
    }
    this.unlocked = true;
    r.tries += 1;
    r.heard = r.len;
    this.clipTimer = setTimeout(() => {
      if (myToken !== this.token) return;
      try { yt.pauseVideo(); } catch (e) { /* ignore */ }
      r.phase = 'ready';
    }, r.len * 1000);
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
    this.updateClipUI();
  },

  reveal() {
    const r = this.round;
    if (!r || r.phase === 'revealed') return;
    clearTimeout(this.clipTimer);
    this.token++;
    r.phase = 'revealed';
    this.fillInfo();
    this.root.classList.add('revealed');
    try {
      const yt = Player.yt;
      yt.unMute();
      if (!r.tries) yt.seekTo(r.start, true);
      yt.playVideo();
    } catch (e) { /* ignore */ }
  },
  unreveal() {
    this.root.classList.remove('revealed');
    Player.stop();
  },
  next(isPass) {
    clearTimeout(this.clipTimer);
    this.token++;
    Player.stop();
    const wasRevealed = this.root.classList.contains('revealed');
    this.root.classList.remove('revealed');
    if (this.mode === 'dj') { setTimeout(() => this.showDJPick(), wasRevealed ? 380 : 0); return; }
    setTimeout(() => this.startRound(this.nextItem()), wasRevealed ? 420 : 0);
  },
  neverUse() {
    const r = this.round;
    if (!r) return;
    const list = Store.get('neverUse', []);
    if (!list.includes(r.item.v)) list.push(r.item.v);
    Store.set('neverUse', list);
    toast('This song is kept out of future games');
    this.next(false);
  },
  onPlayerError(code) {
    // 100 = removed, 101/150 = owner blocks playing outside YouTube, 2/5 = bad id/player problem
    const r = this.round;
    if (!r) return;
    if ([100, 101, 150, 2].includes(code)) {
      const list = Store.get('blocked', []);
      if (!list.includes(r.item.v)) list.push(r.item.v);
      Store.set('blocked', list);
      toast("That song can't play inside Mixtape. Skipping it.");
      if (this.mode === 'dj') this.showDJPick();
      else this.startRound(this.nextItem());
    } else {
      Errors.show('The YouTube player reported a problem (code ' + code + ').');
    }
  },

  /* ---- DJ mode ---- */
  djCandidates: [],
  showDJPick() {
    this.djPicking = true;
    this.round = null;
    Player.stop();
    $('#dj-pick').hidden = false;
    $('#play-area').hidden = true;
    const q = $('#dj-q');
    if (q) { q.value = ''; }
    this.renderDJResults('');
  },
  renderDJResults(query) {
    const box = $('#dj-results');
    if (!box) return;
    this.djSeq = (this.djSeq || 0) + 1;
    const never = new Set(Store.get('neverUse', []));
    const blocked = new Set(Store.get('blocked', []));
    const pool = this.items.filter((it) => !never.has(it.v) && !blocked.has(it.v));
    let list;
    if (!pool.length) {
      box.innerHTML = '<p class="muted">Pick a pool with the bar above, or search all of YouTube.</p>';
      this.djCandidates = [];
      return;
    }
    if (query && query.trim()) {
      list = pool.map((it) => ({ it, s: fuzzyScore(query, it.t + ' ' + it.a) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it);
    } else {
      list = shuffle(pool.slice()).slice(0, 30);
    }
    this.djCandidates = list;
    box.innerHTML = list.length
      ? (query ? '' : '<p class="muted" style="margin:4px 0">A few random picks. Type to search.</p>') + list.map((it, i) => resultRow(it, i)).join('')
      : '<p class="muted">No close matches in this pool.</p>';
  },
  async djSearchYouTube() {
    const q = ($('#dj-q') || {}).value || '';
    if (!q.trim()) { toast('Type a song or artist first'); return; }
    const box = $('#dj-results');
    clearTimeout(this.djTimer);
    const seq = this.djSeq = (this.djSeq || 0) + 1;
    box.innerHTML = '<p class="muted">Searching YouTube…</p>';
    try {
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
  renderDJInfo() {
    const box = $('#dj-info');
    if (!box || !this.round) return;
    const m = this.round.meta || {};
    box.innerHTML = `Your pick: <b>${esc(this.round.item.t)}</b> · ${esc(this.round.item.a)}${m.year ? ' · ' + esc(m.year) : ''}`;
  },
  passPhone() {
    Player.stop();
    const blank = document.createElement('div');
    blank.className = 'blank';
    blank.innerHTML = `<div class="big">Pass the phone</div><p class="muted">Hand it to the next DJ.</p><button class="btn big primary" style="min-width:220px">I'm the DJ</button>`;
    document.body.appendChild(blank);
    blank.querySelector('button').onclick = () => { blank.remove(); this.root.classList.remove('revealed'); this.showDJPick(); };
  },
};

function resultRow(it, i) {
  const thumb = it.thumb || `https://i.ytimg.com/vi/${it.v}/default.jpg`;
  return `<button class="result" data-pick="${i}"><img src="${esc(thumb)}" alt="" loading="lazy">
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
