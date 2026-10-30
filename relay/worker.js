// Mixtape relay — a small free Cloudflare Worker.
// 1) Saves each household's Mixtape data under a sync code (Cloudflare KV), so two phones share it.
// 2) Calls Last.fm, setlist.fm, Ticketmaster and YouTube with keys kept here, out of the public app code
//    (setlist.fm also refuses calls straight from web pages).
//
// Settings in Cloudflare (Worker → Settings → Variables and Secrets / Bindings):
//   KV namespace binding  MIXTAPE            (required for sync)
//   Variable  ALLOWED_ORIGIN  = https://calb417.github.io
//   Secrets   LASTFM_KEY, YOUTUBE_KEY, SETLISTFM_KEY, TICKETMASTER_KEY   (each optional until that section is used)

const CODE_RE = /^[a-z]+-[a-z]+-\d{2,3}$/;
const MAX_BODY = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://calb417.github.io';
    const cors = {
      'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Only Mixtape's own page may use the relay
    if (origin !== allowed) return json({ error: 'not allowed' }, 403);

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'ping') return json({ ok: true, sync: !!env.MIXTAPE, keys: { lastfm: !!env.LASTFM_KEY, youtube: !!env.YOUTUBE_KEY, setlistfm: !!env.SETLISTFM_KEY, ticketmaster: !!env.TICKETMASTER_KEY } });

      /* ---------- sync ---------- */
      if (parts[0] === 'sync') {
        if (!env.MIXTAPE) return json({ error: 'The relay has no MIXTAPE storage binding yet.' }, 500);
        const code = (parts[1] || '').toLowerCase();
        if (!CODE_RE.test(code)) return json({ error: 'bad code' }, 400);
        const key = 'sync:' + code;
        if (request.method === 'GET') {
          const doc = await env.MIXTAPE.get(key, 'json');
          return doc ? json(doc) : json({ error: 'no such code' }, 404);
        }
        if (request.method === 'PUT') {
          const text = await request.text();
          if (text.length > MAX_BODY) return json({ error: 'too big' }, 413);
          const body = JSON.parse(text);
          const cur = await env.MIXTAPE.get(key, 'json');
          const rev = cur ? cur.rev : 0;
          if ((body.baseRev || 0) !== rev) return json({ error: 'changed', current: cur }, 409);
          const doc = { rev: rev + 1, savedAt: new Date().toISOString(), items: body.items || {} };
          await env.MIXTAPE.put(key, JSON.stringify(doc));
          return json({ rev: doc.rev, savedAt: doc.savedAt });
        }
        return json({ error: 'method' }, 405);
      }

      /* ---------- key-hiding proxies (GET only) ---------- */
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      const q = new URLSearchParams(url.search);
      let target, headers = {};
      if (parts[0] === 'lastfm') {
        if (!env.LASTFM_KEY) return json({ error: 'no Last.fm key in the relay' }, 500);
        q.set('api_key', env.LASTFM_KEY);
        q.set('format', 'json');
        target = 'https://ws.audioscrobbler.com/2.0/?' + q;
      } else if (parts[0] === 'youtube') {
        if (!env.YOUTUBE_KEY) return json({ error: 'no YouTube key in the relay' }, 500);
        const path = parts.slice(1).join('/');
        if (!/^(search|videos|playlists|playlistItems|channels)$/.test(path)) return json({ error: 'not allowed' }, 400);
        q.set('key', env.YOUTUBE_KEY);
        target = `https://www.googleapis.com/youtube/v3/${path}?` + q;
      } else if (parts[0] === 'setlistfm') {
        if (!env.SETLISTFM_KEY) return json({ error: 'no setlist.fm key in the relay' }, 500);
        target = 'https://api.setlist.fm/rest/1.0/' + parts.slice(1).map(encodeURIComponent).join('/') + (url.search || '');
        headers = { 'x-api-key': env.SETLISTFM_KEY, Accept: 'application/json', 'Accept-Language': 'en' };
      } else if (parts[0] === 'ticketmaster') {
        if (!env.TICKETMASTER_KEY) return json({ error: 'no Ticketmaster key in the relay' }, 500);
        q.set('apikey', env.TICKETMASTER_KEY);
        target = 'https://app.ticketmaster.com/discovery/v2/' + parts.slice(1).map(encodeURIComponent).join('/') + '?' + q;
      } else {
        return json({ error: 'unknown' }, 404);
      }
      const r = await fetch(target, { headers });
      const body = await r.text();
      return new Response(body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'application/json' } });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
