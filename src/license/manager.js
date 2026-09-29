'use strict';
// In-app license gate: verifies stored activation on every launch, runs online/offline activation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./core');

function loadKeys() {
  const p = path.join(__dirname, 'keys.json');
  if (!fs.existsSync(p)) throw new Error('License keys are not configured for this build (run vendor/keygen.js).');
  const k = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    licensePublicKey: core.publicKeyFromRawB64(k.licensePublicKey),
    activationPublicKey: core.publicKeyFromRawB64(k.activationPublicKey),
    activationServer: (k.activationServer || '').replace(/\/$/, ''),
    revoked: k.revoked || []
  };
}

class LicenseManager {
  constructor({ dir, box, legacyBox, fetchImpl = globalThis.fetch, device }) {
    this.file = path.join(dir, 'license.dat');
    // The license file needs no keychain: activations are signed and device-bound already.
    // `box` should be device-local encryption; `legacyBox` (keychain) is only used to migrate old files once.
    this.box = box;
    this.legacyBox = legacyBox;
    this.fetch = fetchImpl;
    this.keys = loadKeys();
    this.device = device || core.deviceFingerprint();
  }

  _read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (_) { return null; }
    try { return JSON.parse(this.box.decrypt(raw)); } catch (_) {}
    if (this.legacyBox) {
      try {
        const obj = JSON.parse(this.legacyBox.decrypt(raw));
        this._write(obj); // migrate off the keychain
        return obj;
      } catch (_) {}
    }
    return null;
  }
  _write(obj) {
    if (!obj) { try { fs.unlinkSync(this.file); } catch (_) {} return; }
    fs.writeFileSync(this.file, this.box.encrypt(JSON.stringify(obj)));
  }

  status() {
    const s = this._read();
    if (!s) return { active: false, device: this.device, server: !!this.keys.activationServer };
    try {
      const lic = core.verifyActivation(s.activation, { ...this.keys, device: this.device, key: s.key });
      return { active: true, device: this.device, server: !!this.keys.activationServer, eulaAcceptedAt: s.eulaAcceptedAt, license: { ...lic, key: maskKey(s.key) } };
    } catch (e) {
      return { active: false, device: this.device, server: !!this.keys.activationServer, error: e.message };
    }
  }

  check(key) { return core.parseLicense(key, this.keys.licensePublicKey); }

  async activateOnline(key, { eulaAccepted }) {
    if (!eulaAccepted) throw new Error('You must accept the License Agreement to activate.');
    const lic = this.check(key);
    if (this.keys.revoked.includes(lic.serial)) throw new Error('This license has been revoked.');
    if (!this.keys.activationServer) throw new Error('Online activation is not available in this build. Use offline activation.');
    const res = await this.fetch(`${this.keys.activationServer}/v1/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: core.normalizeKey(key), device: this.device, deviceName: os.hostname(), platform: process.platform })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Activation server error (${res.status})`);
    return this._install(key, body.activation);
  }

  requestCode(key) {
    this.check(key);
    return core.makeRequestCode({ key, device: this.device, deviceName: os.hostname() });
  }

  activateOffline(key, activationCode, { eulaAccepted }) {
    if (!eulaAccepted) throw new Error('You must accept the License Agreement to activate.');
    return this._install(key, activationCode);
  }

  _install(key, activation) {
    const lic = core.verifyActivation(activation, { ...this.keys, device: this.device, key });
    this._write({ key: core.normalizeKey(key), activation, eulaAcceptedAt: new Date().toISOString(), checkedAt: Date.now() });
    return lic;
  }

  async deactivate() {
    const s = this._read();
    if (s && this.keys.activationServer) {
      try {
        await this.fetch(`${this.keys.activationServer}/v1/deactivate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: s.key, device: this.device })
        });
      } catch (_) { /* offline: vendor can release the seat manually */ }
    }
    this._write(null);
  }

  // Best-effort periodic check so revoked or remotely-released seats stop working. Never locks out when offline.
  async revalidate(maxAgeDays = 14) {
    const s = this._read();
    if (!s || !this.keys.activationServer || Date.now() - (s.checkedAt || 0) < maxAgeDays * 864e5) return;
    try {
      const res = await this.fetch(`${this.keys.activationServer}/v1/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: s.key, device: this.device })
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.valid === false) this._write(null);
      else if (res.ok) this._write({ ...s, checkedAt: Date.now() });
    } catch (_) {}
  }
}

const maskKey = k => k.slice(0, 12) + '…' + k.slice(-8);

module.exports = { LicenseManager, loadKeys };
