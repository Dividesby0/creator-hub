'use strict';
// One-click sign-in for TikTok, Instagram, Threads, Facebook and X using Creator Hub's own
// registered apps. X uses PKCE as a public client (no secret). The others need an app secret for
// the token exchange, which stays on the sign-in relay (a small Cloudflare Worker); the relay also
// hosts the https redirect those platforms require and bounces the code back to this computer.
// Tokens are never stored on the relay: they come straight back here and are encrypted locally.
const crypto = require('crypto');
const { loopbackSignIn, request } = require('../util');
const { appValue } = require('./builtin');

const ID_FIELD = { x: 'clientId', tiktok: 'clientKey', instagram: 'appId', threads: 'appId', facebook: 'appId' };
const relayUrl = () => appValue('relay', 'url').replace(/\/+$/, '');
const appId = provider => appValue(provider, ID_FIELD[provider]);

/** Is one-click sign-in available for this platform in this build? */
function available(provider) {
  if (!ID_FIELD[provider] || !appId(provider)) return false;
  return provider === 'x' ? true : !!relayUrl();
}

/**
 * Sign in through the relay's https redirect. The relay reads the local port from `state`
 * ("<port>.<nonce>") and forwards ?code&state to http://127.0.0.1:<port>/callback/.
 */
async function relaySignIn(provider, { buildUrl, openExternal }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${relayUrl()}/v1/oauth/cb/${provider}`;
  let state = '';
  const res = await loopbackSignIn({
    port: 0, openExternal,
    get state() { return state; },
    buildUrl: local => { state = `${new URL(local).port}.${nonce}`; return buildUrl({ redirectUri, state }); }
  });
  return { code: res.code, redirectUri };
}

/** Ask the relay to complete a token exchange that needs the app secret. */
async function relayToken(provider, payload) {
  const { body } = await request(`${provider} sign-in`, `${relayUrl()}/v1/oauth/token/${provider}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (body?.error) throw new Error(`${provider} sign-in failed: ${body.error_description || body.error_message || body.error}`);
  return body;
}

module.exports = { available, relaySignIn, relayToken, appId, relayUrl, ID_FIELD };
