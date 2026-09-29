// Creator Hub activation server — Cloudflare Worker + D1 (both on Cloudflare's free tier).
// Enforces seat limits per license and issues device-bound, Ed25519-signed activations.
//
// Secrets (wrangler secret put ...):
//   ACTIVATION_PRIVATE_KEY  base64 PKCS8 from `node vendor/keygen.js --worker-secret`
//   LICENSE_PUBLIC_KEY      "licensePublicKey" value from src/license/keys.json
//   ADMIN_TOKEN             long random string for admin endpoints
// Binding: DB (D1 database, schema in schema.sql)

const LIC_DOMAIN = new TextEncoder().encode('CREATORHUB-LICENSE-V1\0');
const ACT_DOMAIN = new TextEncoder().encode('CREATORHUB-ACTIVATION-V1\0');
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIERS = { 1: 'personal', 2: 'pro', 3: 'team', 4: 'business', 5: 'enterprise', 9: 'founder' };
const EPOCH = Date.UTC(2026, 0, 1);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b32decode(str) {
  const clean = str.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch); if (v < 0) throw new Error('bad key');
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

let keyCache;
async function keys(env) {
  if (keyCache) return keyCache;
  keyCache = {
    licPub: await crypto.subtle.importKey('raw', b64(env.LICENSE_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']),
    actPriv: await crypto.subtle.importKey('pkcs8', b64(env.ACTIVATION_PRIVATE_KEY), { name: 'Ed25519' }, false, ['sign'])
  };
  return keyCache;
}

async function parseLicense(key, env) {
  const s = String(key || '').trim();
  if (!s.toUpperCase().startsWith('CH1-')) throw new Error('Not a Creator Hub license key.');
  const buf = b32decode(s.slice(4));
  if (buf.length !== 80) throw new Error('License key is incomplete or mistyped.');
  const payload = buf.slice(0, 16), sig = buf.slice(16);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, (await keys(env)).licPub, sig, concat(LIC_DOMAIN, payload));
  if (!ok) throw new Error('License key signature is invalid.');
  const dv = new DataView(payload.buffer);
  const expiresDay = dv.getUint16(12);
  const lic = { serial: dv.getUint32(4), tier: TIERS[payload[1]], maxDevices: dv.getUint16(2) };
  if (!lic.tier) throw new Error('Unknown license tier.');
  if (expiresDay !== 0xFFFF && Date.now() > EPOCH + (expiresDay + 1) * 864e5) throw new Error('This license has expired.');
  return lic;
}

async function sign(claims, env) {
  const body = new TextEncoder().encode(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, (await keys(env)).actPriv, concat(ACT_DOMAIN, body)));
  return b64u(body) + '.' + b64u(sig);
}

async function activate(req, env) {
  const { key, device, deviceName = '', platform = '' } = await req.json();
  if (!/^[0-9a-f]{32}$/.test(device || '')) return json({ error: 'Invalid device id.' }, 400);
  let lic;
  try { lic = await parseLicense(key, env); } catch (e) { return json({ error: e.message }, 400); }

  await env.DB.prepare('INSERT OR IGNORE INTO licenses (serial, tier, max_devices, status) VALUES (?1, ?2, ?3, ?4)')
    .bind(lic.serial, lic.tier, lic.maxDevices, 'active').run();
  const row = await env.DB.prepare('SELECT status FROM licenses WHERE serial = ?1').bind(lic.serial).first();
  if (row?.status === 'revoked') return json({ error: 'This license has been revoked. Contact support.' }, 403);

  let act = await env.DB.prepare('SELECT activation_id, activated_at FROM activations WHERE serial = ?1 AND device = ?2')
    .bind(lic.serial, device).first();
  if (!act) {
    const id = crypto.randomUUID(), at = new Date().toISOString();
    // Atomic seat check + insert: only inserts while seats remain.
    const res = await env.DB.prepare(
      `INSERT INTO activations (serial, device, device_name, platform, activation_id, activated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT COUNT(*) FROM activations WHERE serial = ?1) < ?7`
    ).bind(lic.serial, device, String(deviceName).slice(0, 80), String(platform).slice(0, 20), id, at, lic.maxDevices).run();
    if (!res.meta.changes) {
      return json({ error: `This license is already active on ${lic.maxDevices} device(s). Deactivate one from inside the app (Settings → License) or contact support to transfer.` }, 409);
    }
    act = { activation_id: id, activated_at: at };
  }
  const activation = await sign({ v: 1, serial: lic.serial, tier: lic.tier, device, activationId: act.activation_id, activatedAt: act.activated_at }, env);
  return json({ activation });
}

async function deactivate(req, env) {
  const { key, device } = await req.json();
  let lic;
  try { lic = await parseLicense(key, env); } catch (e) { return json({ error: e.message }, 400); }
  await env.DB.prepare('DELETE FROM activations WHERE serial = ?1 AND device = ?2').bind(lic.serial, device).run();
  return json({ ok: true });
}

async function validate(req, env) {
  const { key, device } = await req.json();
  let lic;
  try { lic = await parseLicense(key, env); } catch (e) { return json({ valid: false, error: e.message }); }
  const row = await env.DB.prepare('SELECT status FROM licenses WHERE serial = ?1').bind(lic.serial).first();
  if (row?.status === 'revoked') return json({ valid: false, error: 'revoked' });
  const act = await env.DB.prepare('SELECT 1 FROM activations WHERE serial = ?1 AND device = ?2').bind(lic.serial, device).first();
  return json({ valid: !!act });
}

async function admin(req, env, path) {
  const auth = req.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  const serial = Number(path.split('/').pop());
  if (req.method === 'GET') {
    const lic = await env.DB.prepare('SELECT * FROM licenses WHERE serial = ?1').bind(serial).first();
    const acts = await env.DB.prepare('SELECT device, device_name, platform, activated_at FROM activations WHERE serial = ?1').bind(serial).all();
    return json({ license: lic, activations: acts.results });
  }
  if (path.startsWith('/v1/admin/revoke/')) {
    await env.DB.prepare(`INSERT INTO licenses (serial, tier, max_devices, status) VALUES (?1, '', 0, 'revoked')
      ON CONFLICT(serial) DO UPDATE SET status = 'revoked'`).bind(serial).run();
    return json({ ok: true, revoked: serial });
  }
  if (path.startsWith('/v1/admin/release/')) {
    await env.DB.prepare('DELETE FROM activations WHERE serial = ?1').bind(serial).run();
    return json({ ok: true, released: serial });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === 'POST' && pathname === '/v1/activate') return await activate(req, env);
      if (req.method === 'POST' && pathname === '/v1/deactivate') return await deactivate(req, env);
      if (req.method === 'POST' && pathname === '/v1/validate') return await validate(req, env);
      if (pathname.startsWith('/v1/admin/')) return await admin(req, env, pathname);
      if (pathname === '/health') return json({ ok: true });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  }
};
