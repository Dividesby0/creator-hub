#!/usr/bin/env node
'use strict';
// Issue license keys.
//   node vendor/issue.js --tier personal --count 2000 [--devices 1] [--updates-months 12] [--expires 2027-12-31]
//                        [--licensee "Acme Inc"] [--out licenses.csv]
// Tiers: personal, pro, team, business, enterprise, founder
const fs = require('fs');
const path = require('path');
const { arg, passphrase, loadPrivate, ledger, saveLedger } = require('./lib');
const { signLicense, tierById } = require('../src/license/core');

(async () => {
  const tier = tierById(arg('tier', 'personal'));
  if (!tier) throw new Error('Unknown --tier. Use personal, pro, team, business, enterprise or founder.');
  const count = Number(arg('count', 1));
  const devices = Number(arg('devices', tier.defaultDevices));
  const months = arg('updates-months', '12');
  const expires = arg('expires', '');
  const licensee = arg('licensee', '');
  if (!(count > 0 && count <= 100000)) throw new Error('--count must be 1..100000');
  if (!(devices >= 1 && devices <= 65000)) throw new Error('--devices must be 1..65000');

  const key = loadPrivate('license', await passphrase());
  const L = ledger();
  const issued = new Date();
  const updatesUntil = months === 'lifetime' ? null : new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth() + Number(months), issued.getUTCDate()));
  const batch = `${tier.id}-${issued.toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const rows = [['serial', 'tier', 'max_devices', 'updates_until', 'expires', 'licensee', 'license_key']];

  for (let i = 0; i < count; i++) {
    const serial = L.nextSerial++;
    const k = signLicense({ tier: tier.code, maxDevices: devices, serial, issued, updatesUntil, expires: expires || null }, key);
    L.licenses[serial] = { tier: tier.id, maxDevices: devices, batch, licensee, issuedAt: issued.toISOString(), status: 'unsold', activations: [] };
    rows.push([serial, tier.name, devices, updatesUntil ? updatesUntil.toISOString().slice(0, 10) : 'lifetime', expires || 'perpetual', licensee, k]);
  }
  saveLedger(L);
  const out = arg('out', path.join(__dirname, 'issued', `${batch}.csv`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n', { mode: 0o600 });
  console.log(`Issued ${count} ${tier.name} license(s), ${devices} device(s) each → ${out}`);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
