// Runs the activation server against an in-memory SQLite database that mimics Cloudflare D1.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../vendor/activation-server/worker.js';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const core = require('../src/license/core.js');

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../vendor/activation-server/schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const conv = sql.replace(/\?(\d+)/g, (_, n) => `?${n}`);
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async run() { const r = db.prepare(conv).run(...args); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(conv).get(...args) ?? null; },
        async all() { return { results: db.prepare(conv).all(...args) }; }
      };
    }
  };
}

const lic = crypto.generateKeyPairSync('ed25519');
const act = crypto.generateKeyPairSync('ed25519');
const env = {
  DB: d1(),
  LICENSE_PUBLIC_KEY: core.rawPublicKeyB64(lic.publicKey),
  ACTIVATION_PRIVATE_KEY: act.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  ADMIN_TOKEN: 'admin-secret'
};
const call = async (path, body, headers = {}) => {
  const res = await worker.fetch(new Request('https://act.example' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
};
const dev = n => core.deviceFingerprint('machine-' + n);

test('worker enforces seats and issues activations the app accepts', async () => {
  const key = core.signLicense({ tier: 2, maxDevices: 2, serial: 555 }, lic.privateKey);
  const a1 = await call('/v1/activate', { key, device: dev(1), deviceName: 'Mac' });
  assert.strictEqual(a1.status, 200);
  const verified = core.verifyActivation(a1.body.activation, { activationPublicKey: act.publicKey, licensePublicKey: lic.publicKey, device: dev(1), key });
  assert.strictEqual(verified.serial, 555);

  // same device again = same seat, not a new one
  assert.strictEqual((await call('/v1/activate', { key, device: dev(1) })).status, 200);
  assert.strictEqual((await call('/v1/activate', { key, device: dev(2) })).status, 200);
  const third = await call('/v1/activate', { key, device: dev(3) });
  assert.strictEqual(third.status, 409);

  // deactivate frees a seat
  await call('/v1/deactivate', { key, device: dev(2) });
  assert.strictEqual((await call('/v1/validate', { key, device: dev(2) })).body.valid, false);
  assert.strictEqual((await call('/v1/activate', { key, device: dev(3) })).status, 200);
});

test('concurrent activations cannot exceed the seat limit', async () => {
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 556 }, lic.privateKey);
  const results = await Promise.all([1, 2, 3, 4, 5].map(i => call('/v1/activate', { key, device: dev(100 + i) })));
  assert.strictEqual(results.filter(r => r.status === 200).length, 1);
});

test('forged keys, bad devices and revoked licenses are refused', async () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const forged = core.signLicense({ tier: 5, maxDevices: 999, serial: 557 }, other.privateKey);
  assert.strictEqual((await call('/v1/activate', { key: forged, device: dev(1) })).status, 400);
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 558 }, lic.privateKey);
  assert.strictEqual((await call('/v1/activate', { key, device: 'not-a-hash' })).status, 400);
  assert.strictEqual((await call('/v1/admin/revoke/558', {}, { authorization: 'Bearer wrong' })).status, 401);
  assert.strictEqual((await call('/v1/admin/revoke/558', {}, { authorization: 'Bearer admin-secret' })).status, 200);
  assert.strictEqual((await call('/v1/activate', { key, device: dev(1) })).status, 403);
  assert.strictEqual((await call('/v1/validate', { key, device: dev(1) })).body.valid, false);
});
