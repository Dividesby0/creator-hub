'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/license/core');
const { LicenseManager } = require('../src/license/manager');

// Uses the real embedded public keys + a real issued activation is not available here, so we only
// test storage behaviour: device-local box, keychain migration, and graceful failure.
const localBox = { encrypt: s => 'L:' + Buffer.from(s).toString('base64'), decrypt: s => { if (!s.startsWith('L:')) throw new Error('x'); return Buffer.from(s.slice(2), 'base64').toString(); } };
const keychainBox = { encrypt: s => 'K:' + Buffer.from(s).toString('base64'), decrypt: s => { if (!s.startsWith('K:')) throw new Error('x'); return Buffer.from(s.slice(2), 'base64').toString(); } };
const deniedKeychain = { encrypt: () => { throw new Error('denied'); }, decrypt: () => { throw new Error('denied'); } };

test('license file migrates from keychain encryption to device-local encryption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
  fs.writeFileSync(path.join(dir, 'license.dat'), keychainBox.encrypt(JSON.stringify({ key: 'k', activation: 'a' })));
  const m = new LicenseManager({ dir, box: localBox, legacyBox: keychainBox, device: 'd' });
  assert.deepStrictEqual(m._read(), { key: 'k', activation: 'a' });
  assert.ok(fs.readFileSync(path.join(dir, 'license.dat'), 'utf8').startsWith('L:'), 'rewritten without keychain');
});

test('a denied keychain never crashes the license check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
  fs.writeFileSync(path.join(dir, 'license.dat'), 'K:garbage');
  const m = new LicenseManager({ dir, box: localBox, legacyBox: deniedKeychain, device: core.deviceFingerprint('x') });
  assert.strictEqual(m.status().active, false);
});
