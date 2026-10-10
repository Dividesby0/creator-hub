// Spektly sign-in relay: a tiny Cloudflare Worker (free tier) that holds the platform app secrets
// Meta does not allow inside a downloadable app. It never stores tokens: it bounces the sign-in code
// back to the user's own computer (127.0.0.1) and, when the app asks, does the secret-bearing
// token exchange and returns the result straight to the app.
//
// Settings > Variables and Secrets (add each as a Secret; a platform switches on when its pair is set):
//   INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET   (Instagram API with Instagram Login)
//   THREADS_APP_ID   / THREADS_APP_SECRET
//   FACEBOOK_APP_ID  / FACEBOOK_APP_SECRET
//   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET  (optional; the desktop TikTok app does not need the relay)
// Redirect URI to register in each platform app: https://<this worker>/v1/oauth/cb/<platform>

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

// ---------- one-click sign-in relay ----------
const PROVIDERS = ['tiktok', 'instagram', 'threads', 'facebook'];
const SECRET_OF = { tiktok: 'TIKTOK_CLIENT_SECRET', instagram: 'INSTAGRAM_APP_SECRET', threads: 'THREADS_APP_SECRET', facebook: 'FACEBOOK_APP_SECRET' };
const configured = (env, p) => !!(env[SECRET_OF[p]] && String(env[SECRET_OF[p]]).trim());
const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));

function oauthCallback(url, provider) {
  if (!PROVIDERS.includes(provider)) return json({ error: 'unknown provider' }, 404);
  const p = url.searchParams;
  const state = p.get('state') || '';
  const port = Number(state.split('.')[0]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return new Response('Invalid sign-in state. Go back to Spektly and click Connect again.', { status: 400 });
  const fwd = new URLSearchParams({ state });
  for (const k of ['code', 'error', 'error_description']) if (p.get(k)) fwd.set(k, p.get(k));
  // Only ever redirect to this computer's loopback address.
  return Response.redirect(`http://127.0.0.1:${port}/callback/?${fwd}`, 302);
}

async function upstream(urlStr, init) {
  const r = await fetch(urlStr, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = { error: 'bad_upstream', error_description: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body };
}

async function oauthToken(req, env, provider) {
  if (!PROVIDERS.includes(provider)) return json({ error: 'unknown provider' }, 404);
  const b = await req.json();
  const self = new URL(req.url).origin;
  const redirect_uri = `${self}/v1/oauth/cb/${provider}`;
  if (b.redirect_uri && b.redirect_uri !== redirect_uri) return json({ error: 'redirect_mismatch' }, 400);
  if (provider === 'tiktok') {
    if (!env.TIKTOK_CLIENT_SECRET) return json({ error: 'not_configured' }, 503);
    const params = b.grant_type === 'refresh_token'
      ? { client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: b.refresh_token }
      : { client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: 'authorization_code', code: b.code, redirect_uri };
    const r = await upstream('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(params) });
    return json(r.body, r.ok ? 200 : 400);
  }
  if (provider === 'instagram') {
    if (!env.INSTAGRAM_APP_SECRET) return json({ error: 'not_configured' }, 503);
    const s = await upstream('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form({ client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri, code: b.code }) });
    if (!s.ok) return json(s.body, 400);
    const l = await upstream(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env.INSTAGRAM_APP_SECRET)}&access_token=${encodeURIComponent(s.body.access_token)}`);
    return json(l.ok ? { ...l.body, user_id: s.body.user_id } : l.body, l.ok ? 200 : 400);
  }
  if (provider === 'threads') {
    if (!env.THREADS_APP_SECRET) return json({ error: 'not_configured' }, 503);
    const s = await upstream('https://graph.threads.net/oauth/access_token', { method: 'POST', body: form({ client_id: env.THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET, grant_type: 'authorization_code', redirect_uri, code: b.code }) });
    if (!s.ok) return json(s.body, 400);
    const l = await upstream(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET)}&access_token=${encodeURIComponent(s.body.access_token)}`);
    return json(l.ok ? { ...l.body, user_id: s.body.user_id } : l.body, l.ok ? 200 : 400);
  }
  // facebook: code -> user token -> long-lived user token (Page tokens derived from it do not expire)
  if (!env.FACEBOOK_APP_SECRET) return json({ error: 'not_configured' }, 503);
  const s = await upstream(`https://graph.facebook.com/v23.0/oauth/access_token?${form({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri, code: b.code })}`);
  if (!s.ok) return json(s.body, 400);
  const l = await upstream(`https://graph.facebook.com/v23.0/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, fb_exchange_token: s.body.access_token })}`);
  return json(l.body, l.ok ? 200 : 400);
}

const page = () => new Response(`<!doctype html><meta charset="utf-8"><title>Spektly sign-in</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1624;color:#eef1f5;font:16px -apple-system,Segoe UI,sans-serif"><div style="text-align:center"><div style="font-weight:700;color:#7fa3cc">spektly</div><p>This address only handles sign-ins started from the Spektly app.</p></div>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname.startsWith('/v1/oauth/cb/')) return oauthCallback(url, pathname.split('/').pop());
      if (req.method === 'POST' && pathname.startsWith('/v1/oauth/token/')) return await oauthToken(req, env, pathname.split('/').pop());
      if (pathname === '/health') return json({ ok: true, platforms: PROVIDERS.filter(p => configured(env, p)) });
      if (req.method === 'GET' && pathname === '/') return page();
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server_error', error_description: String(e && e.message || e) }, 500);
    }
  }
};
