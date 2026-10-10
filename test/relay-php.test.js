'use strict';
// The PHP sign-in relay (Hostinger) end to end: real `php -S` server, fake Meta upstream, real Engine.
// Skipped when PHP is not installed (e.g. some CI runners).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const builtinMod = require('../src/oauth/builtin');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const hasPhp = spawnSync('php', ['-v']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const get = url => new Promise((res, rej) => http.get(url, { agent: false }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej));

test('PHP relay: loopback-only redirect, server-side secret exchange, Engine connects Instagram/Threads/Facebook', { skip: !hasPhp && 'php not installed' }, async () => {
  const seen = [];
  const meta = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen.push({ url: req.url, body: b });
      res.setHeader('content-type', 'application/json');
      if (/oauth\/access_token/.test(req.url) && !/fb_exchange_token/.test(req.url)) return res.end(JSON.stringify({ access_token: 'SHORT', user_id: 17 }));
      res.end(JSON.stringify({ access_token: 'LONG', expires_in: 5184000 }));
    });
  });
  const mport = await listen(meta);
  const dir = tmp(), secrets = path.join(dir, 'secrets.php');
  const up = `http://127.0.0.1:${mport}`;
  fs.writeFileSync(secrets, `<?php return ['FORCE_HTTPS' => false, 'INSTAGRAM_APP_ID' => 'IG', 'INSTAGRAM_APP_SECRET' => 'IGSECRET', 'THREADS_APP_ID' => 'TH', 'THREADS_APP_SECRET' => 'THSECRET', 'FACEBOOK_APP_ID' => 'FB', 'FACEBOOK_APP_SECRET' => 'FBSECRET',
    'UPSTREAM' => ['api.instagram.com' => '${up}', 'graph.instagram.com' => '${up}', 'graph.threads.net' => '${up}', 'graph.facebook.com' => '${up}']];`);
  const portSrv = http.createServer(); const pport = await listen(portSrv); portSrv.close();
  const docroot = path.join(__dirname, '..', 'vendor', 'signin-relay-php', 'public');
  const php = spawn('php', ['-S', `127.0.0.1:${pport}`, '-t', docroot, path.join(docroot, 'index.php')], { env: { ...process.env, SPEKTLY_SECRETS_FILE: secrets }, stdio: 'ignore' });
  const RELAY = `http://127.0.0.1:${pport}`;
  try {
    for (let i = 0; i < 50; i++) { try { await get(RELAY + '/health'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
    const health = JSON.parse((await get(RELAY + '/health')).body);
    assert.deepStrictEqual(health.platforms, ['instagram', 'threads', 'facebook']);
    assert.strictEqual((await get(RELAY + '/v1/oauth/cb/instagram?code=x&state=evil.com')).status, 400);
    assert.strictEqual((await get(RELAY + '/v1/oauth/cb/nope?code=x&state=51234.a')).status, 404);
    assert.strictEqual((await get(RELAY + '/v1/oauth/cb/threads?code=x&state=51234.abc')).headers.location, 'http://127.0.0.1:51234/callback/?state=51234.abc&code=x');

    const realFetch = global.fetch;
    const del = await (await realFetch(RELAY + '/v1/meta/data-deletion', { method: 'POST', body: 'signed_request=x' })).json();
    assert.match(del.confirmation_code, /^[0-9a-f]{16}$/); assert.match(del.url, /^https:\/\/spektly\.com\/privacy/);
    assert.strictEqual((await realFetch(RELAY + '/v1/meta/deauthorize', { method: 'POST', body: 'signed_request=x' })).status, 200);
    for (const [pid, profile] of [['instagram', { user_id: '17', username: 'decrypt443' }], ['threads', { id: '18', username: 'decrypt443' }], ['facebook', { data: [{ id: 'P1', name: 'Decrypt443', access_token: 'PAGE' }] }]]) {
      builtinMod._reset({}, { relay: { url: RELAY }, [pid]: { appId: 'APP' } });
      global.fetch = async (url, init) => String(url).startsWith(RELAY) ? realFetch(url, init) : Response.json(profile);
      const store = new Store(tmp());
      store.setAccount(pid, { config: { accessToken: 'stale' } });
      const engine = new Engine({ store, box, openExternal: () => { throw new Error('no browser'); }, openSignIn: async url => {
        const u = new URL(url); const cb = new URL(u.searchParams.get('redirect_uri'));
        cb.searchParams.set('code', 'CODE1'); cb.searchParams.set('state', u.searchParams.get('state'));
        const r = await get(cb.toString()); assert.strictEqual(r.status, 302);
        setTimeout(() => http.get(r.headers.location, { agent: false }, x => x.resume()), 10);
      } });
      const p = await engine.connect(pid, { mode: 'oneclick' });
      assert.match(p.name, /decrypt443/i, pid);
    }
    global.fetch = realFetch;
    const bodies = seen.map(s => s.url + ' ' + s.body).join('\n');
    for (const s of ['IGSECRET', 'THSECRET', 'FBSECRET']) assert.ok(bodies.includes(s), `relay added ${s} server-side`);
    const mismatch = await realFetch(RELAY + '/v1/oauth/token/instagram', { method: 'POST', body: JSON.stringify({ code: 'c', redirect_uri: 'https://evil/cb' }) });
    assert.strictEqual(mismatch.status, 400);
  } finally { php.kill(); meta.close(); builtinMod._reset(null, null); }
});
