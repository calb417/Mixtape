// Mixtape relay — a small free Cloudflare Worker.
// 1) Saves each household's Mixtape data under a sync code (Cloudflare KV), so two phones share it.
// 2) Calls Last.fm, setlist.fm, Ticketmaster and YouTube with keys kept here, out of the public app code
//    (setlist.fm also refuses calls straight from web pages).
// 3) Google sign-in: keeps the long-lived Google "refresh token" here and hands the app a fresh one-hour
//    pass whenever it asks, so the app stays signed in to YouTube Music.
//
// Settings in Cloudflare (Worker → Settings → Variables and Secrets / Bindings):
//   KV namespace binding  MIXTAPE            (required for sync and Google sign-in)
//   Variable  ALLOWED_ORIGIN  = https://calb417.github.io
//   Variable  GOOGLE_CLIENT_ID     (from Google Cloud → Credentials → OAuth client)
//   Secrets   GOOGLE_CLIENT_SECRET, LASTFM_KEY, YOUTUBE_KEY, SETLISTFM_KEY, TICKETMASTER_KEY
//             (each optional until that part is used)

const CODE_RE = /^[a-z]+-[a-z]+-\d{2,3}$/;
const MAX_BODY = 5 * 1024 * 1024;
const STATE_RE = /^[a-f0-9]{32,64}$/;
const SCOPES = 'openid email https://www.googleapis.com/auth/youtube';
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// The page Google sends the phone back to after signing in
function page(title, text, ok) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mixtape</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121014;color:#F4EFE6;
font:17px/1.45 -apple-system,system-ui,sans-serif;text-align:center;padding:28px;box-sizing:border-box}h1{font-size:26px;margin:0 0 12px;color:${ok ? '#F28C38' : '#FF8A7A'}}
p{margin:0 auto 10px;max-width:340px;color:#D8D0C4}</style></head><body><div><h1>${title}</h1>${text}</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
// Reads the email out of Google's sign-in ticket (it comes straight from Google, so no signature check is needed)
function emailOf(idToken) {
  try { const b = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))).email || ''; }
  catch (e) { return ''; }
}

async function google(parts, request, env, url, json) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim(), secret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirect = url.origin + '/google/callback';
  const step = parts[1];

  // 1) The app opens this in the browser; it sends the phone on to Google's sign-in page
  if (step === 'start') {
    const s = url.searchParams.get('s') || '';
    if (!clientId || !secret) return page('Not set up yet', '<p>The relay needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Cloudflare first.</p>', false);
    if (!STATE_RE.test(s)) return page('Something is off', '<p>Go back to Mixtape and tap Sign in again.</p>', false);
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state: s });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
  }

  // 2) Google sends the phone back here with a one-time code
  if (step === 'callback') {
    const s = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '', err = url.searchParams.get('error') || '';
    if (err) return page('Not signed in', `<p>Google said: ${err.replace(/[^a-z_ ]/gi, '')}.</p><p>Close this page and go back to Mixtape to try again.</p>`, false);
    if (!STATE_RE.test(s) || !code) return page('Something is off', '<p>Close this page, go back to Mixtape and tap Sign in again.</p>', false);
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) return page('Not signed in', `<p>Google turned the sign-in down (${String(t.error_description || t.error || r.status).replace(/[<>&]/g, '')}).</p><p>Close this page and send Claude a screenshot.</p>`, false);
    if (!/auth\/youtube(\s|$)/.test(t.scope || '')) return page('One more box to tick', '<p>Mixtape needs the YouTube box ticked to save playlists.</p><p>Close this page, go back to Mixtape, tap Sign in again and tick every box.</p>', false);
    if (!t.refresh_token) return page('Almost', '<p>Google didn\'t send a lasting sign-in. Close this page, go back to Mixtape and tap Sign in again.</p>', false);
    const email = emailOf(t.id_token || '');
    const session = hex(32);
    await env.MIXTAPE.put('gauth:' + session, JSON.stringify({ refresh: t.refresh_token, email, at: new Date().toISOString() }));
    await env.MIXTAPE.put('glogin:' + s, JSON.stringify({ session, email }), { expirationTtl: 900 });
    return page('Signed in', `<p>Mixtape can now save playlists to ${email ? '<b>' + email.replace(/[<>&]/g, '') + '</b>\'s' : 'your'} YouTube Music.</p><p>Close this page (<b>Done</b> or <b>×</b> at the top) and go back to Mixtape. It finishes by itself.</p>`, true);
  }

  // The rest are called by the app
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const body = await request.json().catch(() => ({}));

  // 3) The app asks "has my sign-in finished?" and gets its own sign-in key, once
  if (step === 'claim') {
    if (!STATE_RE.test(body.state || '')) return json({ error: 'bad state' }, 400);
    const got = await env.MIXTAPE.get('glogin:' + body.state, 'json');
    if (!got) return json({ pending: true }, 404);
    await env.MIXTAPE.delete('glogin:' + body.state);
    return json(got);
  }
  const session = String(body.session || '');
  if (!/^[a-f0-9]{64}$/.test(session)) return json({ error: 'bad session' }, 400);
  const saved = await env.MIXTAPE.get('gauth:' + session, 'json');

  // 4) A fresh one-hour pass for YouTube
  if (step === 'token') {
    if (!saved) return json({ error: 'signed out' }, 401);
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, refresh_token: saved.refresh, grant_type: 'refresh_token' }) });
    const t = await r.json().catch(() => ({}));
    if (t.error === 'invalid_grant') { await env.MIXTAPE.delete('gauth:' + session); return json({ error: 'signed out' }, 401); }
    if (!r.ok || !t.access_token) return json({ error: 'Google: ' + (t.error_description || t.error || r.status) }, 502);
    return json({ access_token: t.access_token, expires_in: t.expires_in || 3600, email: saved.email || '' });
  }

  // 5) Sign out: Google forgets the permission and so does the relay
  if (step === 'signout') {
    if (saved) {
      await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refresh }) }).catch(() => {});
      await env.MIXTAPE.delete('gauth:' + session);
    }
    return json({ ok: true });
  }
  return json({ error: 'unknown' }, 404);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    // forgiving about how the setting was typed: "calb417.github.io/Mixtape/" still means https://calb417.github.io
    const clean = (o) => { o = String(o || '').trim().toLowerCase(); if (o && !/^https?:\/\//.test(o)) o = 'https://' + o; const m = o.match(/^https?:\/\/[^/]+/); return m ? m[0] : ''; };
    const allowed = clean(env.ALLOWED_ORIGIN) || 'https://calb417.github.io';
    const ok = clean(origin) === allowed;
    const cors = {
      'Access-Control-Allow-Origin': origin || allowed,   // answers are readable so the app can show the real reason
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // The two Google sign-in pages are opened in the browser itself, so they carry no Origin
    const page2 = parts[0] === 'google' && (parts[1] === 'start' || parts[1] === 'callback');
    // Only Mixtape's own page may use the rest of the relay
    if (!ok && !page2) return json({ error: 'not allowed' }, 403);

    try {
      if (parts[0] === 'ping') return json({ ok: true, sync: !!env.MIXTAPE, keys: { lastfm: !!env.LASTFM_KEY, youtube: !!env.YOUTUBE_KEY, setlistfm: !!env.SETLISTFM_KEY, ticketmaster: !!env.TICKETMASTER_KEY, google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) } });

      /* ---------- Google sign-in ---------- */
      if (parts[0] === 'google') {
        if (!env.MIXTAPE) return page2 ? page('Not set up yet', '<p>The relay has no MIXTAPE storage binding.</p>', false) : json({ error: 'The relay has no MIXTAPE storage binding yet.' }, 500);
        return await google(parts, request, env, url, json);
      }

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
