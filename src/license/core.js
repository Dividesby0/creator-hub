'use strict';
/*
 * Creator Hub licensing core.
 *
 * License key  = Crockford-base32( payload(16 bytes) || Ed25519-signature(64 bytes) ), grouped, prefixed "CH1-".
 *                Signed with the vendor LICENSE private key (never shipped). Verifiable offline with the embedded public key.
 * Activation   = base64url(JSON) "." base64url(Ed25519 signature), signed with a separate ACTIVATION private key
 *                (held by the activation server / vendor CLI). Binds one license serial to one device fingerprint.
 *
 * Two keypairs mean a leak of the activation server's key cannot be used to mint new license keys.
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const KEY_PREFIX = 'CH1';
const LIC_DOMAIN = Buffer.from('CREATORHUB-LICENSE-V1\0');
const ACT_DOMAIN = Buffer.from('CREATORHUB-ACTIVATION-V1\0');
const EPOCH = Date.UTC(2026, 0, 1);            // day 0 for compact dates
const NEVER = 0xFFFF;

const TIERS = {
  1: { code: 1, id: 'personal',   name: 'Personal',   defaultDevices: 1 },
  2: { code: 2, id: 'pro',        name: 'Pro',        defaultDevices: 3 },
  3: { code: 3, id: 'team',       name: 'Team',       defaultDevices: 5 },
  4: { code: 4, id: 'business',   name: 'Business',   defaultDevices: 25 },
  5: { code: 5, id: 'enterprise', name: 'Enterprise', defaultDevices: 100 },
  9: { code: 9, id: 'founder',    name: 'Founder / Early Access', defaultDevices: 1 }
};
const tierById = id => Object.values(TIERS).find(t => t.id === id);

// ---------- Crockford base32 ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const clean = str.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('Invalid character in license key');
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const toDay = d => d ? Math.floor((new Date(d).getTime() - EPOCH) / 864e5) : NEVER;
const fromDay = n => n === NEVER ? null : new Date(EPOCH + n * 864e5).toISOString().slice(0, 10);

// ---------- keys ----------
function publicKeyFromRawB64(b64) {
  // wrap a raw 32-byte Ed25519 public key in SPKI DER
  const raw = Buffer.from(b64, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}
function rawPublicKeyB64(keyObj) {
  const der = keyObj.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

// ---------- license keys ----------
function encodePayload({ tier, maxDevices, serial, issued, updatesUntil, expires }) {
  const b = Buffer.alloc(16);
  b[0] = 1;
  b[1] = tier;
  b.writeUInt16BE(maxDevices, 2);
  b.writeUInt32BE(serial >>> 0, 4);
  b.writeUInt16BE(toDay(issued || new Date()), 8);
  b.writeUInt16BE(updatesUntil ? toDay(updatesUntil) : NEVER, 10);
  b.writeUInt16BE(expires ? toDay(expires) : NEVER, 12);
  crypto.randomFillSync(b, 14, 2);
  return b;
}

function signLicense(fields, privateKey) {
  const payload = encodePayload(fields);
  const sig = crypto.sign(null, Buffer.concat([LIC_DOMAIN, payload]), privateKey);
  const body = b32encode(Buffer.concat([payload, sig]));
  return `${KEY_PREFIX}-` + body.match(/.{1,8}/g).join('-');
}

function parseLicense(key, publicKey, now = Date.now()) {
  const trimmed = String(key || '').trim();
  if (!trimmed.toUpperCase().startsWith(KEY_PREFIX + '-')) throw new Error('This is not a Creator Hub license key.');
  const buf = b32decode(trimmed.slice(KEY_PREFIX.length + 1));
  if (buf.length !== 80) throw new Error('License key is incomplete or mistyped.');
  const payload = buf.subarray(0, 16), sig = buf.subarray(16, 80);
  if (!crypto.verify(null, Buffer.concat([LIC_DOMAIN, payload]), publicKey, sig)) throw new Error('License key signature is invalid.');
  if (payload[0] !== 1) throw new Error('Unsupported license key version.');
  const tier = TIERS[payload[1]];
  if (!tier) throw new Error('Unknown license tier.');
  const lic = {
    serial: payload.readUInt32BE(4),
    tier: tier.id, tierName: tier.name,
    maxDevices: payload.readUInt16BE(2),
    issued: fromDay(payload.readUInt16BE(8)),
    updatesUntil: fromDay(payload.readUInt16BE(10)),
    expires: fromDay(payload.readUInt16BE(12))
  };
  if (lic.expires && now > new Date(lic.expires).getTime() + 864e5) throw new Error(`This license expired on ${lic.expires}.`);
  return lic;
}

const normalizeKey = key => {
  const body = b32encode(b32decode(String(key).trim().slice(KEY_PREFIX.length + 1)));
  return `${KEY_PREFIX}-` + body.match(/.{1,8}/g).join('-');
};

// ---------- device fingerprint ----------
function machineId() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return 'mac:' + m[1];
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) return 'win:' + m[1].toLowerCase();
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return 'linux:' + v; } catch (_) {}
      }
    }
  } catch (_) {}
  // weak fallback
  const macs = Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal && i.mac !== '00:00:00:00:00:00').map(i => i.mac).sort();
  return 'fallback:' + os.hostname() + ':' + (macs[0] || '');
}

function deviceFingerprint(id = machineId()) {
  return crypto.createHash('sha256').update('creator-hub-device-v1\0' + id).digest('hex').slice(0, 32);
}

// ---------- activations ----------
const b64u = b => Buffer.from(b).toString('base64url');

function signActivation(claims, activationPrivateKey) {
  const body = Buffer.from(JSON.stringify(claims));
  const sig = crypto.sign(null, Buffer.concat([ACT_DOMAIN, body]), activationPrivateKey);
  return b64u(body) + '.' + b64u(sig);
}

function verifyActivation(token, { activationPublicKey, licensePublicKey, device, key, revoked = [] }) {
  const [bodyB64, sigB64] = String(token || '').replace(/\s+/g, '').split('.');
  if (!bodyB64 || !sigB64) throw new Error('Activation code is malformed.');
  const body = Buffer.from(bodyB64, 'base64url');
  if (!crypto.verify(null, Buffer.concat([ACT_DOMAIN, body]), activationPublicKey, Buffer.from(sigB64, 'base64url'))) {
    throw new Error('Activation code signature is invalid.');
  }
  const claims = JSON.parse(body.toString('utf8'));
  if (claims.v !== 1) throw new Error('Unsupported activation version.');
  const lic = parseLicense(key, licensePublicKey);
  if (claims.serial !== lic.serial) throw new Error('Activation belongs to a different license.');
  if (claims.device !== device) throw new Error('This activation is for a different computer. Activate this device or transfer your license.');
  if (revoked.includes(lic.serial)) throw new Error('This license has been revoked. Contact support.');
  return { ...lic, activationId: claims.activationId, activatedAt: claims.activatedAt, licensee: claims.licensee || '' };
}

// Offline activation: user sends this request code to the vendor; vendor CLI returns an activation code.
function makeRequestCode({ key, device, deviceName }) {
  return 'REQ-' + b64u(JSON.stringify({ v: 1, key: normalizeKey(key), device, deviceName: deviceName || os.hostname(), at: new Date().toISOString() }));
}
function readRequestCode(code) {
  const s = String(code).trim();
  if (!s.startsWith('REQ-')) throw new Error('Not an activation request code.');
  return JSON.parse(Buffer.from(s.slice(4), 'base64url').toString('utf8'));
}

module.exports = {
  TIERS, tierById, KEY_PREFIX, b32encode, b32decode,
  publicKeyFromRawB64, rawPublicKeyB64,
  signLicense, parseLicense, normalizeKey,
  machineId, deviceFingerprint,
  signActivation, verifyActivation, makeRequestCode, readRequestCode
};
