'use strict';
// Creator Hub's own ("built-in") OAuth apps, so customers just click Connect and sign in.
// builtin.json is written at build time from CI secrets (never committed). For local dev, set
// CH_GOOGLE_CLIENT_ID / CH_GOOGLE_CLIENT_SECRET. Installed-app client secrets are not treated as
// confidential by Google (PKCE protects the flow); the user's tokens never leave their computer.
const path = require('path');
const fs = require('fs');

// The Google client ID is public by design (it appears in every sign-in URL), so it lives in code.
// Only the client secret comes from the CH_GOOGLE_CLIENT_SECRET repository secret at build time.
const GOOGLE_CLIENT_ID = '563271142019-a62fnn0eakieb1cq38krpl1e8nsgo0q6.apps.googleusercontent.com';

let cache = null;
function load() {
  if (cache) return cache;
  cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'builtin.json'), 'utf8')) || {}; } catch (_) {}
  if (cache.google && cache.google.clientSecret && !cache.google.clientId) cache.google.clientId = GOOGLE_CLIENT_ID;
  if (process.env.CH_GOOGLE_CLIENT_ID && process.env.CH_GOOGLE_CLIENT_SECRET) {
    cache.google = { clientId: process.env.CH_GOOGLE_CLIENT_ID, clientSecret: process.env.CH_GOOGLE_CLIENT_SECRET };
  }
  return cache;
}

function builtin(provider) {
  const c = load()[provider];
  return c && c.clientId && c.clientSecret ? { clientId: c.clientId, clientSecret: c.clientSecret } : null;
}

// Public app IDs for one-click sign-in on other platforms (src/oauth/apps.json, committed).
let appsCache = null;
function apps() {
  if (appsCache) return appsCache;
  try { appsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.json'), 'utf8')); } catch (_) { appsCache = {}; }
  const env = { x: ['clientId', 'CH_X_CLIENT_ID'], tiktok: ['clientKey', 'CH_TIKTOK_CLIENT_KEY'], instagram: ['appId', 'CH_INSTAGRAM_APP_ID'],
    threads: ['appId', 'CH_THREADS_APP_ID'], facebook: ['appId', 'CH_FACEBOOK_APP_ID'], relay: ['url', 'CH_RELAY_URL'] };
  for (const [k, [field, name]] of Object.entries(env)) if (process.env[name]) appsCache[k] = { ...(appsCache[k] || {}), [field]: process.env[name] };
  return appsCache;
}
const appValue = (provider, field) => String(apps()[provider]?.[field] || '').trim();

const hasOwn = cfg => !!(cfg && cfg.clientId && cfg.clientSecret);

/**
 * Pick the Google OAuth client. Order: the client that issued the saved token (refresh tokens
 * only work with the client that created them), then the user's own keys, then the built-in app.
 */
function googleClient({ own, alt, tokenClientId } = {}) {
  const candidates = [hasOwn(own) && { ...own, source: 'own' }, hasOwn(alt) && { ...alt, source: 'own' }, builtin('google') && { ...builtin('google'), source: 'builtin' }].filter(Boolean);
  if (tokenClientId) { const m = candidates.find(c => c.clientId === tokenClientId); if (m) return m; }
  return candidates[0] || null;
}

function _reset(next, nextApps) { cache = next || null; appsCache = nextApps || null; } // tests

module.exports = { builtin, googleClient, hasOwn, apps, appValue, _reset };
