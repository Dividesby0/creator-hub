// One-click sign-in relay (Cloudflare Worker routes) with mocked upstream platforms.
import test from 'node:test';
import assert from 'node:assert';
import worker from '../vendor/activation-server/worker.js';

const env = { TIKTOK_CLIENT_KEY: 'tk', TIKTOK_CLIENT_SECRET: 'ts', INSTAGRAM_APP_ID: 'ig', INSTAGRAM_APP_SECRET: 'igs', FACEBOOK_APP_ID: 'fb', FACEBOOK_APP_SECRET: 'fbs', THREADS_APP_ID: 'th', THREADS_APP_SECRET: 'ths' };
const R = 'https://relay.example';

test('callback forwards code+state only to this computer\'s loopback port', async () => {
  const r = await worker.fetch(new Request(`${R}/v1/oauth/cb/tiktok?code=C1&state=53123.abc`), env);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), 'http://127.0.0.1:53123/callback/?state=53123.abc&code=C1');
  const bad = await worker.fetch(new Request(`${R}/v1/oauth/cb/tiktok?code=C1&state=evil.com`), env);
  assert.strictEqual(bad.status, 400);
  const unknown = await worker.fetch(new Request(`${R}/v1/oauth/cb/myspace?code=C1&state=5000.a`), env);
  assert.strictEqual(unknown.status, 404);
});

test('TikTok token exchange adds the secret server-side and rejects a foreign redirect', async () => {
  const seen = [];
  globalThis.fetch = async (u, init) => { seen.push({ u: String(u), body: String(init?.body || '') }); return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 }); };
  const ok = await worker.fetch(new Request(`${R}/v1/oauth/token/tiktok`, { method: 'POST', body: JSON.stringify({ code: 'C1', redirect_uri: `${R}/v1/oauth/cb/tiktok` }) }), env);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).access_token, 'AT');
  assert.match(seen[0].body, /client_secret=ts/);
  assert.match(seen[0].body, /redirect_uri=https%3A%2F%2Frelay.example%2Fv1%2Foauth%2Fcb%2Ftiktok/);
  const bad = await worker.fetch(new Request(`${R}/v1/oauth/token/tiktok`, { method: 'POST', body: JSON.stringify({ code: 'C1', redirect_uri: 'https://attacker/cb' }) }), env);
  assert.strictEqual(bad.status, 400);
});

test('Instagram: short-lived code exchange then 60-day token, secret never returned', async () => {
  globalThis.fetch = async (u) => String(u).includes('api.instagram.com') ? Response.json({ access_token: 'short', user_id: 42 }) : Response.json({ access_token: 'long', expires_in: 5184000 });
  const r = await worker.fetch(new Request(`${R}/v1/oauth/token/instagram`, { method: 'POST', body: JSON.stringify({ code: 'C' }) }), env);
  const body = await r.json();
  assert.deepStrictEqual(body, { access_token: 'long', expires_in: 5184000, user_id: 42 });
  assert.ok(!JSON.stringify(body).includes('igs'));
});

test('platforms without secrets report not configured', async () => {
  const r = await worker.fetch(new Request(`${R}/v1/oauth/token/threads`, { method: 'POST', body: '{}' }), {});
  assert.strictEqual(r.status, 503);
});
