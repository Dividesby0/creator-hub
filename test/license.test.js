'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const core = require('../src/license/core');

const lic = crypto.generateKeyPairSync('ed25519');
const act = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');

test('license key round-trips and carries its fields', () => {
  const key = core.signLicense({ tier: 3, maxDevices: 5, serial: 100123, issued: new Date(), updatesUntil: '2027-10-01' }, lic.privateKey);
  assert.match(key, /^CH1-[0-9A-Z]{8}(-[0-9A-Z]{1,8})+$/);
  const l = core.parseLicense(key, lic.publicKey);
  assert.strictEqual(l.serial, 100123);
  assert.strictEqual(l.tier, 'team');
  assert.strictEqual(l.maxDevices, 5);
  assert.strictEqual(l.updatesUntil, '2027-10-01');
  assert.strictEqual(l.expires, null);
  // case/spacing tolerant
  assert.strictEqual(core.parseLicense(' ' + key.toLowerCase() + ' ', lic.publicKey).serial, 100123);
});

test('tampered or foreign keys are rejected', () => {
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 5 }, lic.privateKey);
  // flip one payload character (tier/devices) — signature must fail
  const chars = key.split('');
  const i = 6; chars[i] = chars[i] === 'A' ? 'B' : 'A';
  assert.throws(() => core.parseLicense(chars.join(''), lic.publicKey), /signature|incomplete/i);
  const forged = core.signLicense({ tier: 5, maxDevices: 999, serial: 5 }, other.privateKey);
  assert.throws(() => core.parseLicense(forged, lic.publicKey), /signature/);
  assert.throws(() => core.parseLicense('XYZ-123', lic.publicKey), /not a Spektly/);
});

test('expired subscription keys are rejected', () => {
  const key = core.signLicense({ tier: 2, maxDevices: 3, serial: 9, issued: '2026-01-10', expires: '2026-02-01' }, lic.privateKey);
  assert.throws(() => core.parseLicense(key, lic.publicKey, Date.parse('2026-03-01')), /expired/);
  assert.ok(core.parseLicense(key, lic.publicKey, Date.parse('2026-01-15')));
});

test('activation is bound to device and license', () => {
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 77 }, lic.privateKey);
  const device = core.deviceFingerprint('test-machine');
  const token = core.signActivation({ v: 1, serial: 77, tier: 'personal', device, activationId: 'a1', activatedAt: 'now' }, act.privateKey);
  const opts = { activationPublicKey: act.publicKey, licensePublicKey: lic.publicKey, key };
  assert.strictEqual(core.verifyActivation(token, { ...opts, device }).serial, 77);
  assert.throws(() => core.verifyActivation(token, { ...opts, device: core.deviceFingerprint('other-machine') }), /different computer/);
  const key2 = core.signLicense({ tier: 1, maxDevices: 1, serial: 78 }, lic.privateKey);
  assert.throws(() => core.verifyActivation(token, { ...opts, key: key2, device }), /different license/);
  assert.throws(() => core.verifyActivation(token, { ...opts, device, revoked: [77] }), /revoked/);
  // activation signed with the LICENSE key (wrong keypair) must fail
  const wrong = core.signActivation({ v: 1, serial: 77, device }, lic.privateKey);
  assert.throws(() => core.verifyActivation(wrong, { ...opts, device }), /signature/);
  // tampered claims
  const [b, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  claims.serial = 78;
  assert.throws(() => core.verifyActivation(Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + s, { ...opts, key: key2, device }), /signature/);
});

test('offline request code round-trips', () => {
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 3 }, lic.privateKey);
  const code = core.makeRequestCode({ key, device: 'ab'.repeat(16), deviceName: 'Laptop' });
  const r = core.readRequestCode(code);
  assert.strictEqual(r.key, key);
  assert.strictEqual(r.deviceName, 'Laptop');
});

test('device fingerprint is stable and 128-bit hex', () => {
  const a = core.deviceFingerprint(), b = core.deviceFingerprint();
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('activation codes survive pasted whitespace and line breaks', () => {
  const key = core.signLicense({ tier: 1, maxDevices: 1, serial: 91 }, lic.privateKey);
  const device = core.deviceFingerprint('ws-machine');
  const token = core.signActivation({ v: 1, serial: 91, device }, act.privateKey);
  const messy = '  ' + token.slice(0, 50) + '\n' + token.slice(50, 120) + ' \r\n' + token.slice(120) + '\n';
  assert.strictEqual(core.verifyActivation(messy, { activationPublicKey: act.publicKey, licensePublicKey: lic.publicKey, device, key }).serial, 91);
});
