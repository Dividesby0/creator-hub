'use strict';
// Plans end to end: real `php -S` licensing server, fake Creem license API, real LicenseManager.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const core = require('../src/license/core');
const { LicenseManager } = require('../src/license/manager');
const hasPhp = spawnSync('php', ['-v']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const get = url => new Promise((res, rej) => http.get(url, { agent: false }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej));
const dev = n => crypto.createHash('md5').update('dev' + n).digest('hex');

test('core: plan activation stops working at its until date', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const claims = { v: 2, kind: 'plan', plan: 'studio', keyHash: core.planKeyHash('K-123456789'), maxDevices: 5, device: dev(1), activationId: 'abcdef0123', activatedAt: '2026-10-01T00:00:00Z', until: '2026-10-20T00:00:00Z' };
  const tok = core.signActivation(claims, privateKey);
  const opts = { activationPublicKeys: [publicKey], device: dev(1), key: 'K-123456789' };
  assert.strictEqual(core.verifyActivation(tok, { ...opts, now: Date.parse('2026-10-19T00:00:00Z') }).tierName, 'Studio');
  assert.throws(() => core.verifyActivation(tok, { ...opts, now: Date.parse('2026-10-21T00:00:00Z') }), e => e.code === 'PLAN_UNCONFIRMED');
  assert.throws(() => core.verifyActivation(tok, { ...opts, key: 'OTHER-KEY-99', now: Date.parse('2026-10-19T00:00:00Z') }), /different key/);
  assert.throws(() => core.verifyActivation(tok, { ...opts, device: dev(2), now: Date.parse('2026-10-19T00:00:00Z') }), /different computer/);
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => core.verifyActivation(tok, { ...opts, activationPublicKeys: [other] }), /signature/);
});

for (const crypto_ of ['sodium', 'compat'])
test(`licensing server (${crypto_}): buy links, plan keys via Creem, CH1 seats, cancellation locks the app`, { skip: !hasPhp && 'php not installed' }, async () => {
  // fake Creem
  const lic = { key: 'PLAN-KEY-CREATOR-0001', product_id: 'prod_creator', status: 'active', activation_limit: 2, expires_at: null, instances: [] };
  const creemSeen = [];
  const creem = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); creemSeen.push({ url: req.url, key: req.headers['x-api-key'], body });
      res.setHeader('content-type', 'application/json');
      const send = (st, o) => { res.statusCode = st; res.end(JSON.stringify(o)); };
      if (body.key !== lic.key) return send(404, { error: 'not found' });
      const view = inst => ({ id: 'lk_1', mode: 'test', object: 'license', product_id: lic.product_id, status: lic.status, key: lic.key, activation: lic.instances.filter(i => i.status === 'active').length, activation_limit: lic.activation_limit, expires_at: lic.expires_at, created_at: '2026-10-01', instance: inst });
      if (req.url === '/v1/licenses/activate') {
        if (lic.instances.filter(i => i.status === 'active').length >= lic.activation_limit) return send(403, { error: 'limit' });
        const inst = { id: 'ins_' + lic.instances.length, name: body.instance_name, status: 'active', object: 'license-instance', mode: 'test', created_at: '2026-10-10' };
        lic.instances.push(inst); return send(200, view([inst]));
      }
      const inst = lic.instances.find(i => i.id === body.instance_id);
      if (!inst) return send(404, { error: 'no instance' });
      if (req.url === '/v1/licenses/validate') return send(200, view(inst));
      if (req.url === '/v1/licenses/deactivate') { inst.status = 'deactivated'; return send(200, view(inst)); }
      send(404, {});
    });
  });
  const cport = await listen(creem);
  // CH1 keys signed with a throwaway license key
  const L = crypto.generateKeyPairSync('ed25519');
  const ch1 = core.signLicense({ tier: 10, maxDevices: 1, serial: 4242 }, L.privateKey);
  const dir = tmp(), secrets = path.join(dir, 'secrets.php'), data = path.join(dir, 'data');
  fs.writeFileSync(secrets, `<?php return ['FORCE_HTTPS' => false, 'DATA_DIR' => '${data}', 'LICENSE_PUBLIC_KEY' => '${core.rawPublicKeyB64(L.publicKey)}', 'CREEM_API_KEY' => 'creem_test_key',
    'CREEM_PRODUCTS' => ['prod_creator' => 'creator'], 'BUY_URLS' => ['solo' => 'https://www.creem.io/test/payment/prod_solo'], 'UPSTREAM' => ['api.creem.io' => 'http://127.0.0.1:${cport}']];`);
  const portSrv = http.createServer(); const pport = await listen(portSrv); portSrv.close();
  const docroot = path.join(__dirname, '..', 'vendor', 'signin-relay-php', 'public');
  const noSodium = crypto_ === 'compat' ? ['-d', 'disable_functions=sodium_crypto_sign_detached,sodium_crypto_sign_keypair,sodium_crypto_sign_publickey,sodium_crypto_sign_secretkey,sodium_crypto_sign_verify_detached'] : [];
  const php = spawn('php', [...noSodium, '-S', `127.0.0.1:${pport}`, '-t', docroot, path.join(docroot, 'index.php')], { env: { ...process.env, SPEKTLY_SECRETS_FILE: secrets }, stdio: 'ignore' });
  const S = `http://127.0.0.1:${pport}`;
  try {
    for (let i = 0; i < 50; i++) { try { await get(S + '/health'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
    const health = JSON.parse((await get(S + '/health')).body);
    assert.deepStrictEqual({ ...health.licensing, php: undefined }, { crypto: crypto_, sqlite: true, php: undefined, keys: true, plans: true, checkout: ['solo'] });
    assert.strictEqual((await get(S + '/license.php')).status, 404);
    // buy links
    const b1 = await get(S + '/buy/solo'); assert.strictEqual(b1.status, 302); assert.strictEqual(b1.headers.location, 'https://www.creem.io/test/payment/prod_solo');
    const b2 = await get(S + '/buy/agency'); assert.strictEqual(b2.status, 503); assert.match(b2.body, /Agency plan opens soon/);
    assert.strictEqual((await get(S + '/buy/nope')).headers.location, 'https://spektly.com/#plans');
    // server-generated activation key, stable across calls, private half stays in the data folder
    const k1 = JSON.parse((await get(S + '/v1/activation-key')).body).activationPublicKey;
    assert.strictEqual(JSON.parse((await get(S + '/v1/activation-key')).body).activationPublicKey, k1);
    assert.strictEqual(fs.statSync(path.join(data, 'activation-key.bin')).mode & 0o077, 0);
    const keys = { licensePublicKey: L.publicKey, activationPublicKey: null, activationPublicKeys: [core.publicKeyFromRawB64(k1)], activationServer: S, revoked: [] };
    const mgr = n => new LicenseManager({ dir: tmp(), box, device: dev(n), keys });

    // plan key: activate, Creem saw our API key and the device as the instance name
    const a = mgr(1);
    assert.deepStrictEqual(a.check(lic.key), { plan: true, tierName: 'Spektly plan' });
    assert.throws(() => a.check('short'), /does not look like/);
    await assert.rejects(a.activateOnline(lic.key, { eulaAccepted: false }), /accept the License Agreement/);
    const got = await a.activateOnline(lic.key, { eulaAccepted: true });
    assert.strictEqual(got.tierName, 'Creator'); assert.strictEqual(got.subscription, true);
    assert.strictEqual(creemSeen.at(-1).key, 'creem_test_key'); assert.strictEqual(creemSeen.at(-1).body.instance_name, dev(1));
    const st = a.status(); assert.strictEqual(st.active, true); assert.strictEqual(st.license.plan, 'creator');
    assert.ok(Date.parse(st.license.until) > Date.now() + 9 * 864e5);
    // reactivating the same computer does not use another seat
    await a.activateOnline(lic.key, { eulaAccepted: true });
    assert.strictEqual(lic.instances.length, 1);
    // seat limit comes from Creem
    await mgr(2).activateOnline(lic.key, { eulaAccepted: true });
    await assert.rejects(mgr(3).activateOnline(lic.key, { eulaAccepted: true }), /maximum number of computers/);
    await assert.rejects(mgr(3).activateOnline('WRONG-KEY-0000', { eulaAccepted: true }), /not found/);
    // offline activation is CH1-only
    assert.throws(() => a.requestCode(lic.key), /activate online only/);

    // periodic check refreshes the activation; cancellation locks the app
    const raw = () => JSON.parse(box.decrypt(fs.readFileSync(a.file, 'utf8')));
    fs.writeFileSync(a.file, box.encrypt(JSON.stringify({ ...raw(), checkedAt: 0 })));
    const before = raw().activation;
    await new Promise(r => setTimeout(r, 1100));
    await a.revalidate();
    assert.notStrictEqual(raw().activation, before); assert.strictEqual(a.status().active, true);
    lic.status = 'expired';
    fs.writeFileSync(a.file, box.encrypt(JSON.stringify({ ...raw(), checkedAt: 0 })));
    await a.revalidate();
    const ended = a.status(); assert.strictEqual(ended.active, false); assert.match(ended.error, /plan has ended/);
    // server down: the app keeps working until the activation's until date
    lic.status = 'active';
    const c = mgr(4); lic.activation_limit = 5; await c.activateOnline(lic.key, { eulaAccepted: true });
    fs.writeFileSync(c.file, box.encrypt(JSON.stringify({ ...JSON.parse(box.decrypt(fs.readFileSync(c.file, 'utf8'))), checkedAt: 0 })));
    const down = new LicenseManager({ dir: path.dirname(c.file), box, device: dev(4), keys: { ...keys, activationServer: 'http://127.0.0.1:9' } });
    await down.revalidate(); assert.strictEqual(down.status().active, true);
    // deactivate releases the Creem instance
    await c.deactivate(); assert.strictEqual(c.status().active, false);
    assert.strictEqual(lic.instances.find(i => i.name === dev(4)).status, 'deactivated');

    // account sign-up from the website form (plain form POST, no JavaScript needed)
    const post = async form => { const r = await fetch(S + '/v1/account/signup', { method: 'POST', body: new URLSearchParams(form), redirect: 'manual' }); return r.headers.get('location'); };
    assert.strictEqual(await post({ email: 'nope' }), 'https://spektly.com/account/?error=email');
    assert.strictEqual(await post({ email: 'Fan@Example.com', name: 'Fan', key: lic.key, giveaways: '1', ref: 'ord_123' }), 'https://spektly.com/account/?joined=1');
    assert.strictEqual(await post({ email: 'fan@example.com', key: ch1, updates: '1' }), 'https://spektly.com/account/?joined=1');
    const rows = JSON.parse(spawnSync('php', ['-r', `$p=new PDO('sqlite:${data}/licenses.sqlite'); echo json_encode([$p->query('SELECT email,name,giveaways,updates,ref FROM customers')->fetchAll(PDO::FETCH_ASSOC), $p->query('SELECT lic FROM customer_keys ORDER BY lic')->fetchAll(PDO::FETCH_COLUMN)]);`]).stdout.toString());
    assert.deepStrictEqual(rows[0], [{ email: 'fan@example.com', name: 'Fan', giveaways: 0, updates: 1, ref: 'ord_123' }]);
    assert.deepStrictEqual(rows[1], ['ch1:4242', 'creem:' + core.planKeyHash(lic.key)]);

    // CH1 key: one seat, deactivate frees it
    const x = mgr(10), y = mgr(11);
    assert.strictEqual((await x.activateOnline(ch1, { eulaAccepted: true })).tierName, 'Solo');
    await assert.rejects(y.activateOnline(ch1, { eulaAccepted: true }), /already active on 1 computer/);
    await x.deactivate();
    assert.strictEqual((await y.activateOnline(ch1, { eulaAccepted: true })).serial, 4242);
    const forged = ch1.slice(0, -3) + (ch1.endsWith('A') ? 'BBB' : 'AAA');
    await assert.rejects(mgr(12).activateOnline(forged, { eulaAccepted: true }), /signature|mistyped/);
  } finally { php.kill(); creem.close(); }
});
