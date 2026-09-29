#!/usr/bin/env node
'use strict';
// Manual (offline) activation desk — use until the activation server is deployed, or for air-gapped customers.
//   node vendor/activate.js --request REQ-xxxx            issue an activation code for a customer's request code
//   node vendor/activate.js --release 100001 [--device <fingerprint>]   free a seat (device transfer)
//   node vendor/activate.js --revoke 100001               revoke a license (ships in next app update's revoked list)
//   node vendor/activate.js --show 100001
const fs = require('fs');
const crypto = require('crypto');
const { arg, passphrase, loadPrivate, ledger, saveLedger, PUBLIC_KEYS } = require('./lib');
const core = require('../src/license/core');

(async () => {
  const L = ledger();
  const keys = JSON.parse(fs.readFileSync(PUBLIC_KEYS, 'utf8'));

  if (arg('show')) { console.log(JSON.stringify(L.licenses[arg('show')] || null, null, 2)); return; }

  if (arg('revoke')) {
    const serial = Number(arg('revoke'));
    if (L.licenses[serial]) L.licenses[serial].status = 'revoked';
    keys.revoked = [...new Set([...(keys.revoked || []), serial])];
    fs.writeFileSync(PUBLIC_KEYS, JSON.stringify(keys, null, 2));
    saveLedger(L);
    console.log(`Revoked ${serial}. Also revoke it on the activation server (POST /v1/admin/revoke) and ship an app update.`);
    return;
  }

  if (arg('release')) {
    const rec = L.licenses[arg('release')];
    if (!rec) throw new Error('Unknown serial');
    const dev = arg('device');
    rec.activations = typeof dev === 'string' ? rec.activations.filter(a => a.device !== dev) : [];
    saveLedger(L);
    console.log(`Released ${typeof dev === 'string' ? 'device ' + dev : 'all devices'} for ${arg('release')}.`);
    return;
  }

  const reqCode = arg('request');
  if (typeof reqCode !== 'string') throw new Error('Pass --request REQ-..., --release, --revoke or --show.');
  const req = core.readRequestCode(reqCode);
  const lic = core.parseLicense(req.key, core.publicKeyFromRawB64(keys.licensePublicKey));
  const rec = L.licenses[lic.serial] ||= { tier: lic.tier, maxDevices: lic.maxDevices, status: 'sold', activations: [] };
  if (rec.status === 'revoked' || (keys.revoked || []).includes(lic.serial)) throw new Error('License is revoked.');
  let act = rec.activations.find(a => a.device === req.device);
  if (!act) {
    if (rec.activations.length >= lic.maxDevices) {
      throw new Error(`Seat limit reached (${lic.maxDevices}). Release a device first:\n  node vendor/activate.js --release ${lic.serial} --device <fingerprint>\nCurrent devices: ${rec.activations.map(a => `${a.device} (${a.deviceName})`).join(', ')}`);
    }
    act = { device: req.device, deviceName: req.deviceName, activationId: crypto.randomUUID(), activatedAt: new Date().toISOString() };
    rec.activations.push(act);
    rec.status = 'active';
  }
  const privateKey = loadPrivate('activation', await passphrase());
  const code = core.signActivation({ v: 1, serial: lic.serial, tier: lic.tier, device: act.device, activationId: act.activationId, activatedAt: act.activatedAt }, privateKey);
  saveLedger(L);
  console.log(`\nLicense ${lic.serial} (${lic.tierName}) — seat ${rec.activations.length}/${lic.maxDevices} for "${act.deviceName}".\nSend this activation code to the customer:\n\n${code}\n`);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
