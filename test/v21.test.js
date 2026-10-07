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
  setTimeout(() => http.get(`http://127.0.0.1:8765/callback/?code=CODE1&state=${state}`, { agent: false }, r => r.resume()), 20);
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
