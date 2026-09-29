'use strict';
// Vendor-only helpers. The vendor/ folder is NEVER packaged into the app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const KEYS_DIR = path.join(__dirname, 'keys');
const LEDGER = path.join(__dirname, 'ledger.json');
const PUBLIC_KEYS = path.join(ROOT, 'src', 'license', 'keys.json');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function passphrase(confirm = false) {
  if (process.env.CH_VENDOR_PASSPHRASE) return process.env.CH_VENDOR_PASSPHRASE;
  const ask = q => new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a); });
  });
  const p = await ask('Vendor key passphrase: ');
  if (confirm) {
    if (p.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
    if (await ask('Confirm passphrase: ') !== p) throw new Error('Passphrases do not match.');
  }
  return p;
}

// Private keys are sealed with scrypt (N=2^17, r=8, p=1) + AES-256-GCM — far stronger than the
// 2048-iteration PBKDF2 that default encrypted-PEM export uses.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };

function sealPrivateKey(keyObj, pass) {
  const der = keyObj.export({ format: 'der', type: 'pkcs8' });
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const k = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(der), c.final()]);
  return JSON.stringify({ kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'),
    cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') }, null, 2);
}

function loadPrivate(name, pass) {
  const s = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${name}-private.key.json`), 'utf8'));
  try {
    const k = crypto.scryptSync(pass, Buffer.from(s.salt, 'base64'), 32, { N: s.N, r: s.r, p: s.p, maxmem: SCRYPT.maxmem });
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    const der = Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]);
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch (_) { throw new Error('Wrong passphrase (or corrupted key file).'); }
}

function ledger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch (_) { return { nextSerial: 100001, licenses: {} }; }
}
function saveLedger(l) {
  const tmp = LEDGER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, LEDGER);
}

module.exports = { ROOT, KEYS_DIR, LEDGER, PUBLIC_KEYS, arg, passphrase, loadPrivate, sealPrivateKey, ledger, saveLedger };
