'use strict';
// v2.1: built-in Google sign-in (customers never enter keys) + one sign-in shared by YouTube and Insights.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const builtinMod = require('../src/oauth/builtin');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { InsightsService } = require('../src/insights/service');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch21-'));
const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
const BUILTIN = { google: { clientId: 'builtin-id.apps.googleusercontent.com', clientSecret: 'builtin-secret' } };

// Simulates the user's browser: approve the consent screen by hitting the loopback callback.
const approve = url => {
  const u = new URL(url);
  const state = u.searchParams.get('state');
  const cb = u.searchParams.get('redirect_uri');
  setTimeout(() => http.get(`${cb}?code=CODE1&state=${state}`, { agent: false }, r => r.resume()), 20);
};

function mockGoogle(record) {
  const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'creator@gmail.com' })).toString('base64url') + '.s';
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    record.push({ url, body: opts.body ? String(opts.body) : '' });
    if (url.includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: idToken,
        scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/analytics.readonly' });
    }
    if (url.includes('/channels?part=snippet')) return Response.json({ items: [{ id: 'UC1', snippet: { title: 'Decrypt443' } }] });
    throw new Error('unmocked ' + url);
  };
}

test('googleClient: own keys win, else built-in; a saved token pins the client that issued it', () => {
  builtinMod._reset(BUILTIN);
  assert.strictEqual(builtinMod.googleClient({}).source, 'builtin');
  assert.strictEqual(builtinMod.googleClient({ own: { clientId: 'mine', clientSecret: 's' } }).clientId, 'mine');
  const pinned = builtinMod.googleClient({ own: { clientId: 'mine', clientSecret: 's' }, tokenClientId: BUILTIN.google.clientId });
  assert.strictEqual(pinned.source, 'builtin');
  builtinMod._reset({});
  assert.strictEqual(builtinMod.googleClient({}), null);
  builtinMod._reset(null);
});

test('YouTube one-click: connects with the built-in app and no saved account config', async () => {
  builtinMod._reset(BUILTIN);
  const calls = [];
  mockGoogle(calls);
  const store = new Store(tmp());
  const engine = new Engine({ store, box, openExternal: approve });
  const view = engine.accountsView().find(a => a.id === 'youtube');
  assert.strictEqual(view.oneClick, true);
  assert.ok(view.configFields.every(f => f.advanced));
  let hooked = null;
  engine.onConnected = (pid, secret) => { hooked = { pid, secret }; };
  const profile = await engine.connect('youtube');
  assert.strictEqual(profile.name, 'Decrypt443');
  const tokenCall = calls.find(c => c.url.includes('/token'));
  assert.match(tokenCall.body, /client_id=builtin-id/);
  assert.match(tokenCall.body, /code_verifier=/);
  assert.strictEqual(hooked.pid, 'youtube');
  assert.strictEqual(hooked.secret.clientId, BUILTIN.google.clientId);
  assert.strictEqual(hooked.secret.email, 'creator@gmail.com');
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('RT'), 'refresh token stored encrypted');
  builtinMod._reset(null);
});

test('YouTube one-click asks for posting + every Insights permission in a single consent', async () => {
  builtinMod._reset(BUILTIN);
  mockGoogle([]);
  let authUrl = '';
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: u => { authUrl = u; approve(u); } });
  await engine.connect('youtube');
  const scope = new URL(authUrl).searchParams.get('scope');
  for (const s of ['youtube.upload', 'yt-analytics.readonly', 'analytics.readonly', 'webmasters.readonly', 'business.manage']) assert.ok(scope.includes(s), s);
  builtinMod._reset(null);
});

test('Insights adopts the YouTube Google sign-in and refreshes with the same client', async () => {
  builtinMod._reset(BUILTIN);
  const store = new Store(tmp());
  const svc = new InsightsService({ store, box, openExternal: () => {} });
  assert.strictEqual(svc.view().oneClick, true);
  assert.strictEqual(svc.adoptGoogle({ refreshToken: 'RT', accessToken: 'AT', expiresAt: 1, scope: 'youtube.upload' }), false, 'needs analytics scope');
  assert.strictEqual(svc.adoptGoogle({ refreshToken: 'RT', accessToken: 'AT', expiresAt: 1, email: 'c@g.com',
    scope: 'https://www.googleapis.com/auth/analytics.readonly', clientId: BUILTIN.google.clientId }), true);
  const v = svc.view();
  assert.strictEqual(v.connected, true);
  assert.strictEqual(v.email, 'c@g.com');
  assert.strictEqual(svc.config().clientId, BUILTIN.google.clientId);
  const calls = [];
  global.fetch = async (url, opts = {}) => { calls.push(String(opts.body || '')); return Response.json({ access_token: 'AT2', expires_in: 3600 }); };
  assert.strictEqual(await svc.google.token(), 'AT2');
  assert.match(calls[0], /client_id=builtin-id/);
  builtinMod._reset(null);
});

test('Without a built-in app, YouTube explains how to use your own keys', async () => {
  builtinMod._reset({});
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: () => {} });
  assert.strictEqual(engine.accountsView().find(a => a.id === 'youtube').oneClick, false);
  await assert.rejects(engine.connect('youtube'), /own developer keys/);
  builtinMod._reset(null);
});

test('first-run wizard flag defaults to not onboarded', () => {
  const store = new Store(tmp());
  assert.strictEqual(store.data.settings.onboarded, false);
  store.updateSettings({ onboarded: true });
  assert.strictEqual(new Store(path.dirname(store.file)).data.settings.onboarded, true);
});

test('built-in client ID is in code; CI only injects the secret', () => {
  const fs2 = require('fs'), p2 = require('path');
  const f = p2.join(__dirname, '..', 'src', 'oauth', 'builtin.json');
  const had = fs2.existsSync(f) ? fs2.readFileSync(f) : null;
  try {
    fs2.writeFileSync(f, JSON.stringify({ google: { clientSecret: 'S' } }));
    builtinMod._reset(null);
    const g = builtinMod.builtin('google');
    assert.match(g.clientId, /^563271142019-.*\.apps\.googleusercontent\.com$/);
    assert.strictEqual(g.clientSecret, 'S');
  } finally { had ? fs2.writeFileSync(f, had) : fs2.rmSync(f, { force: true }); builtinMod._reset(null); }
});

test('a second Connect click cancels the first sign-in instead of failing with "port in use"', async () => {
  const { loopbackSignIn } = require('../src/util');
  const first = loopbackSignIn({ port: 8765, state: 'a', buildUrl: r => r, openExternal: () => {} });
  await new Promise(r => setTimeout(r, 30));
  let opened = '';
  const second = loopbackSignIn({ port: 8765, state: 'b', buildUrl: r => r, openExternal: u => { opened = u; } });
  await assert.rejects(first, /restarted/);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(opened, 'http://127.0.0.1:8765/callback/');
  http.get(`${opened}?code=C2&state=b`, { agent: false }, r => r.resume());
  assert.deepStrictEqual(await second, { code: 'C2', redirectUri: 'http://127.0.0.1:8765/callback/' });
});

test('Google sign-in uses any free loopback port and sends the same redirect to the token exchange', async () => {
  builtinMod._reset(BUILTIN);
  const calls = [];
  mockGoogle(calls);
  let authUrl = '';
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: u => { authUrl = u; approve(u); } });
  await engine.connect('youtube');
  const redirect = new URL(authUrl).searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback\/$/);
  assert.ok(calls.find(c => c.url.includes('/token')).body.includes('redirect_uri=' + encodeURIComponent(redirect)));
  builtinMod._reset(null);
});

test('one-click for other platforms turns on only when the app ID (and relay, if needed) is set', () => {
  const oc = require('../src/oauth/oneclick');
  builtinMod._reset(null, {});
  for (const p of ['x', 'tiktok', 'instagram', 'threads', 'facebook']) assert.strictEqual(oc.available(p), false, p);
  builtinMod._reset(null, { x: { clientId: 'X1' }, tiktok: { clientKey: 'T1' } });
  assert.strictEqual(oc.available('x'), true, 'X is a public PKCE client: no relay needed');
  assert.strictEqual(oc.available('tiktok'), false, 'TikTok needs the relay for its secret');
  builtinMod._reset(null, { tiktok: { clientKey: 'T1' }, relay: { url: 'https://relay.example' } });
  assert.strictEqual(oc.available('tiktok'), true);
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: () => {} });
  assert.strictEqual(engine.accountsView().find(a => a.id === 'tiktok').oneClick, true);
  builtinMod._reset(null, null);
});

test('TikTok one-click: relay redirect carries the local port in state; tokens come back via the relay', async () => {
  builtinMod._reset(null, { tiktok: { clientKey: 'T1' }, relay: { url: 'https://relay.example' } });
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: String(opts.body || '') });
    if (String(url).includes('/v1/oauth/token/tiktok')) return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 });
    if (String(url).includes('/user/info/')) return Response.json({ data: { user: { display_name: 'decrypt443', open_id: 'O1' } } });
    throw new Error('unmocked ' + url);
  };
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: url => {
    const u = new URL(url);
    assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://relay.example/v1/oauth/cb/tiktok');
    assert.strictEqual(u.searchParams.get('client_key'), 'T1');
    const state = u.searchParams.get('state');
    const port = state.split('.')[0];
    // what the relay does: bounce to this computer
    setTimeout(() => http.get(`http://127.0.0.1:${port}/callback/?code=C9&state=${state}`, { agent: false }, r => r.resume()), 20);
  } });
  const profile = await engine.connect('tiktok');
  assert.strictEqual(profile.name, 'decrypt443');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { grant_type: 'authorization_code', code: 'C9', redirect_uri: 'https://relay.example/v1/oauth/cb/tiktok' });
  builtinMod._reset(null, null);
});

test('saved "own" keys that reuse the built-in client ID never override the built-in secret', () => {
  builtinMod._reset({ google: { clientId: 'builtin-id', clientSecret: 'right' } });
  const c = builtinMod.googleClient({ own: { clientId: 'builtin-id', clientSecret: 'mistyped' } });
  assert.strictEqual(c.clientSecret, 'right');
  assert.strictEqual(c.source, 'builtin');
  builtinMod._reset(null);
});

test('TikTok one-click with Spektly\'s built-in desktop app: free loopback port, hex PKCE, secret exchange, no relay', async () => {
  builtinMod._reset({ tiktok: { clientSecret: 'TT-SECRET' } }, { tiktok: { clientKey: 'TTKEY' } });
  const oc = require('../src/oauth/oneclick');
  assert.strictEqual(oc.available('tiktok'), true, 'no relay needed when the built-in secret is present');
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: String(opts.body || '') });
    if (String(url).includes('/v2/oauth/token/')) return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 });
    if (String(url).includes('/user/info/')) return Response.json({ data: { user: { display_name: 'decrypt443', open_id: 'O1' } } });
    throw new Error('unmocked ' + url);
  };
  let auth;
  const engine = new Engine({ store: new Store(tmp()), box, openExternal: url => {
    auth = new URL(url);
    const cb = auth.searchParams.get('redirect_uri');
    setTimeout(() => http.get(`${cb}?code=C7&state=${auth.searchParams.get('state')}`, { agent: false }, r => r.resume()), 20);
  } });
  const profile = await engine.connect('tiktok');
  assert.strictEqual(profile.name, 'decrypt443');
  assert.strictEqual(auth.searchParams.get('client_key'), 'TTKEY');
  assert.match(auth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback\/$/);
  assert.match(auth.searchParams.get('code_challenge'), /^[0-9a-f]{64}$/, 'TikTok desktop wants a hex SHA-256 challenge');
  const tok = new URLSearchParams(calls.find(c => c.url.includes('/oauth/token/')).body);
  assert.strictEqual(tok.get('client_secret'), 'TT-SECRET');
  assert.strictEqual(tok.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
  assert.ok(tok.get('code_verifier') && tok.get('code_verifier').length >= 43);
  assert.ok(!calls.some(c => c.url.includes('relay')), 'never touches the relay');
  builtinMod._reset(null, null);
});

test('a half-filled TikTok key form (e.g. a username in the Client key box) never overrides the built-in app', async () => {
  builtinMod._reset({ tiktok: { clientSecret: 'TT-SECRET' } }, { tiktok: { clientKey: 'TTKEY' } });
  global.fetch = async url => String(url).includes('/oauth/token/') ? Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 })
    : Response.json({ data: { user: { display_name: 'decrypt443', open_id: 'O1' } } });
  const store = new Store(tmp());
  store.setAccount('tiktok', { config: { clientKey: 'decrypt443', clientSecret: '' } });
  let key;
  const engine = new Engine({ store, box, openExternal: url => {
    const u = new URL(url); key = u.searchParams.get('client_key');
    setTimeout(() => http.get(`${u.searchParams.get('redirect_uri')}?code=C1&state=${u.searchParams.get('state')}`, { agent: false }, r => r.resume()), 20);
  } });
  await engine.connect('tiktok');
  assert.strictEqual(key, 'TTKEY');
  builtinMod._reset(null, null);
});

test('a non-key in the TikTok form (even with a secret) never overrides the built-in app; sign-in opens in the app window', async () => {
  builtinMod._reset({ tiktok: { clientSecret: 'TT-SECRET' } }, { tiktok: { clientKey: 'sbawTESTKEY12345' } });
  global.fetch = async url => String(url).includes('/oauth/token/') ? Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 })
    : Response.json({ data: { user: { display_name: 'decrypt443', open_id: 'O1' } } });
  const store = new Store(tmp());
  store.setAccount('tiktok', { config: { clientKey: 'decrypt443', clientSecret: 'whatever-was-typed' } });
  let key, external = 0, title;
  const engine = new Engine({ store, box, openExternal: () => { external++; }, openSignIn: (url, o) => {
    const u = new URL(url); key = u.searchParams.get('client_key'); title = o.title;
    setTimeout(() => http.get(`${u.searchParams.get('redirect_uri')}?code=C1&state=${u.searchParams.get('state')}`, { agent: false }, r => r.resume()), 20);
  } });
  await engine.connect('tiktok');
  assert.strictEqual(key, 'sbawTESTKEY12345');
  assert.strictEqual(external, 0, 'TikTok sign-in does not leave the app');
  assert.strictEqual(title, 'Sign in to TikTok');
  builtinMod._reset(null, null);
});

test('closing the sign-in window cancels the pending sign-in with a clear message', async () => {
  const util = require('../src/util');
  const p = util.loopbackSignIn({ port: 0, state: 's', openExternal: () => setTimeout(() => util.cancelPendingSignIn('The sign-in window was closed before you finished. Click Connect to try again.'), 10), buildUrl: r => 'https://example.com/?r=' + r });
  await assert.rejects(p, /window was closed/);
});
