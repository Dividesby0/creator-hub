#!/usr/bin/env node
'use strict';
// One-time: create the LICENSE and ACTIVATION Ed25519 keypairs.
// Private keys are sealed with scrypt + AES-256-GCM under your passphrase in vendor/keys/.
// Public keys are embedded in the app at src/license/keys.json.
//
//   node vendor/keygen.js [--server https://activate.yourdomain.com] [--force]
//   node vendor/keygen.js --worker-secret      (prints activation private key for the activation server)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KEYS_DIR, PUBLIC_KEYS, arg, passphrase, loadPrivate, sealPrivateKey } = require('./lib');
const { rawPublicKeyB64 } = require('../src/license/core');

(async () => {
  if (arg('worker-secret')) {
    const key = loadPrivate('activation', await passphrase());
    const der = key.export({ format: 'der', type: 'pkcs8' });
    console.log('\nACTIVATION_PRIVATE_KEY (paste into: wrangler secret put ACTIVATION_PRIVATE_KEY):\n');
    console.log(der.toString('base64'));
    return;
  }

  if (arg('server') && !arg('force') && fs.existsSync(path.join(KEYS_DIR, 'license-private.key.json'))) {
    // just update the server URL
    const k = JSON.parse(fs.readFileSync(PUBLIC_KEYS, 'utf8'));
    k.activationServer = arg('server');
    fs.writeFileSync(PUBLIC_KEYS, JSON.stringify(k, null, 2));
    console.log('Updated activation server URL to', k.activationServer);
    return;
  }

  if (fs.existsSync(path.join(KEYS_DIR, 'license-private.key.json')) && !arg('force')) {
    console.error('Keys already exist. Re-running would invalidate every license you have issued.\nPass --force only if you truly mean to rotate keys.');
    process.exit(1);
  }
  const pass = await passphrase(true);
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  const pub = {};
  for (const name of ['license', 'activation']) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(KEYS_DIR, `${name}-private.key.json`), sealPrivateKey(privateKey, pass), { mode: 0o600 });
    pub[name] = rawPublicKeyB64(publicKey);
  }
  let revoked = [];
  try { revoked = JSON.parse(fs.readFileSync(PUBLIC_KEYS, 'utf8')).revoked || []; } catch (_) {}
  fs.writeFileSync(PUBLIC_KEYS, JSON.stringify({
    licensePublicKey: pub.license,
    activationPublicKey: pub.activation,
    activationServer: typeof arg('server') === 'string' ? arg('server') : '',
    revoked
  }, null, 2));
  console.log('Created vendor/keys/license-private.key.json and activation-private.key.json (sealed with your passphrase).');
  console.log('Wrote public keys to src/license/keys.json.');
  console.log('BACK UP vendor/keys/ and your passphrase offline. Losing them means you cannot issue or activate licenses.');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
