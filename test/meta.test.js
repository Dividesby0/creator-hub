'use strict';
// Meta (Instagram, Threads, Facebook) one-click sign-in through the Spektly relay + in-app window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const builtinMod = require('../src/oauth/builtin');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meta-'));
const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
const RELAY = 'https://relay.example';
const relayWorker = () => import('../vendor/signin-relay/worker.js').then(m => m.default);

// Simulates the whole round trip: platform redirects to the relay, relay bounces to 127.0.0.1.
function fakeSignIn(seen) {
  return async (url, opts) => {
    const u = new URL(url); seen.push({ host: u.host, clientId: u.searchParams.get('client_id'), title: opts && opts.title, redirect: u.searchParams.get('redirect_uri') });
    const worker = await relayWorker();
    const cb = new URL(u.searchParams.get('redirect_uri')); cb.searchParams.set('code', 'CODE1'); cb.searchParams.set('state', u.searchParams.get('state'));
    const res = await worker.fetch(new Request(cb.toString()), {});
    const loc = res.headers.get('location');
    assert.match(loc, /^http:\/\/127\.0\.0\.1:\d+\/callback\/\?/);
    setTimeout(() => http.get(loc, { agent: false }, r => r.resume()), 10);
  };
}

for (const [pid, host, profileBody] of [
  ['instagram', 'www.instagram.com', { user_id: '17', username: 'decrypt443' }],
  ['threads', 'threads.net', { id: '18', username: 'decrypt443' }],
  ['facebook', 'www.facebook.com', { data: [{ id: 'P1', name: 'Decrypt443', access_token: 'PAGE' }] }]
]) {
  test(`${pid}: Connect button signs in through the relay in the in-app window, even with a stale pasted token`, async () => {
    builtinMod._reset({}, { relay: { url: RELAY }, [pid]: { appId: 'APP-' + pid } });
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url));
      if (String(url).startsWith(RELAY + '/v1/oauth/token/')) { assert.strictEqual(JSON.parse(init.body).code, 'CODE1'); return Response.json({ access_token: 'LONG', expires_in: 5184000 }); }
      return Response.json(profileBody);
    };
    const store = new Store(tmp());
    store.setAccount(pid, { config: { accessToken: 'stale-token' }, lastError: 'Invalid OAuth access token' });
    const seen = [];
    const engine = new Engine({ store, box, openExternal: () => { throw new Error('must not open the browser'); }, openSignIn: fakeSignIn(seen) });
    const profile = await engine.connect(pid, { mode: 'oneclick' });
    assert.strictEqual(seen[0].host, host);
    assert.strictEqual(seen[0].clientId, 'APP-' + pid);
    assert.strictEqual(seen[0].redirect, `${RELAY}/v1/oauth/cb/${pid}`);
    assert.match(seen[0].title, /^Sign in to /);
    assert.ok(calls.some(c => c === `${RELAY}/v1/oauth/token/${pid}`));
    assert.match(profile.name, /decrypt443|Decrypt443/i);
    assert.strictEqual(store.getAccount(pid).lastError, null);
    builtinMod._reset(null, null);
  });
}

test('relay only ever redirects to this computer and refuses bad state', async () => {
  const w = await relayWorker();
  const bad = await w.fetch(new Request('https://r/v1/oauth/cb/instagram?code=x&state=evil.com'), {});
  assert.strictEqual(bad.status, 400);
  const ok = await w.fetch(new Request('https://r/v1/oauth/cb/threads?code=x&state=51234.abc'), {});
  assert.strictEqual(ok.headers.get('location'), 'http://127.0.0.1:51234/callback/?state=51234.abc&code=x');
  const unknown = await w.fetch(new Request('https://r/v1/oauth/cb/evil?code=x&state=51234.a'), {});
  assert.strictEqual(unknown.status, 404);
});

test('relay token exchange uses the secret server-side and reports which platforms are configured', async () => {
  const w = await relayWorker();
  const env = { INSTAGRAM_APP_ID: 'IG', INSTAGRAM_APP_SECRET: 'IGSECRET' };
  const realFetch = global.fetch; const sent = [];
  global.fetch = async (url, init) => { sent.push({ url: String(url), body: init && String(init.body || '') });
    return String(url).includes('api.instagram.com') ? Response.json({ access_token: 'SHORT', user_id: 17 }) : Response.json({ access_token: 'LONG', expires_in: 5184000 }); };
  const r = await w.fetch(new Request('https://r/v1/oauth/token/instagram', { method: 'POST', body: JSON.stringify({ code: 'C', redirect_uri: 'https://r/v1/oauth/cb/instagram' }) }), env);
  const body = await r.json();
  assert.deepStrictEqual([r.status, body.access_token, body.user_id], [200, 'LONG', 17]);
  assert.ok(sent[0].body.includes('client_secret=IGSECRET'), 'secret added by the relay');
  const mismatch = await w.fetch(new Request('https://r/v1/oauth/token/instagram', { method: 'POST', body: JSON.stringify({ code: 'C', redirect_uri: 'https://other/cb' }) }), env);
  assert.strictEqual(mismatch.status, 400);
  const off = await w.fetch(new Request('https://r/v1/oauth/token/threads', { method: 'POST', body: '{}' }), env);
  assert.strictEqual(off.status, 503);
  const health = await (await w.fetch(new Request('https://r/health'), env)).json();
  assert.deepStrictEqual(health.platforms, ['instagram']);
  global.fetch = realFetch;
});
