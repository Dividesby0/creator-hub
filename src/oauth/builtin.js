'use strict';
// Creator Hub's own ("built-in") OAuth apps, so customers just click Connect and sign in.
// builtin.json is written at build time from CI secrets (never committed). For local dev, set
// CH_GOOGLE_CLIENT_ID / CH_GOOGLE_CLIENT_SECRET. Installed-app client secrets are not treated as
// confidential by Google (PKCE protects the flow); the user's tokens never leave their computer.
const path = require('path');
const fs = require('fs');

let cache = null;
function load() {
  if (cache) return cache;
  cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'builtin.json'), 'utf8')) || {}; } catch (_) {}
  if (process.env.CH_GOOGLE_CLIENT_ID && process.env.CH_GOOGLE_CLIENT_SECRET) {
    cache.google = { clientId: process.env.CH_GOOGLE_CLIENT_ID, clientSecret: process.env.CH_GOOGLE_CLIENT_SECRET };
  }
  return cache;
}

function builtin(provider) {
  const c = load()[provider];
  return c && c.clientId && c.clientSecret ? { clientId: c.clientId, clientSecret: c.clientSecret } : null;
}

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

function _reset(next) { cache = next || null; } // tests

module.exports = { builtin, googleClient, hasOwn, _reset };
