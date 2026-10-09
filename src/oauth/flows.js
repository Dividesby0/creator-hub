'use strict';
// One-click connect flows per platform (used when the user has not entered their own app keys).
const crypto = require('crypto');
const { request, randomVerifier, challengeBase64Url, challengeHex, loopbackSignIn, toForm, REDIRECT_URI } = require('../util');
const { builtinSecret } = require('./builtin');
const oc = require('./oneclick');

const FB = 'https://graph.facebook.com/v23.0';
const enc = encodeURIComponent;

const TT_SCOPE = 'user.info.basic,user.info.stats,video.upload,video.publish,video.list';
const TT_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
async function tiktokProfile(secret) {
  const me = await request('TikTok', 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: { Authorization: `Bearer ${secret.accessToken}` } });
  return { name: me.body.data?.user?.display_name || 'TikTok account', id: me.body.data?.user?.open_id };
}
function ttTokens(body) {
  if (body.error) throw new Error(`TikTok sign-in failed: ${body.error_description || body.error}`);
  return body;
}
// Sign-in pages that work inside Spektly open in an in-app window. Google is the exception: it blocks
// sign-in from embedded windows, so Google always opens in the default browser.
const inApp = (ctx, name) => ctx.openSignIn ? url => ctx.openSignIn(url, { title: `Sign in to ${name}` }) : ctx.openExternal;

async function tiktok(ctx) {
  const clientKey = oc.appId('tiktok');
  if (builtinSecret('tiktok')) {
    // Spektly's TikTok desktop app: any free local port (registered as http://127.0.0.1:*/callback/), PKCE with a hex challenge.
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const { code, redirectUri } = await loopbackSignIn({ port: 0, state, openExternal: inApp(ctx, 'TikTok'),
      buildUrl: redirectUri => 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({ client_key: clientKey, scope: TT_SCOPE, response_type: 'code', redirect_uri: redirectUri, state, code_challenge: challengeHex(verifier), code_challenge_method: 'S256' }) });
    const { body } = await request('TikTok', TT_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toForm({ client_key: clientKey, client_secret: builtinSecret('tiktok'), code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier }) });
    const t = ttTokens(body);
    const secret = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, via: 'builtin' };
    return { secret, profile: await tiktokProfile(secret) };
  }
  const { code, redirectUri } = await oc.relaySignIn('tiktok', { openExternal: inApp(ctx, 'TikTok'),
    buildUrl: ({ redirectUri, state }) => 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({ client_key: clientKey, scope: TT_SCOPE, response_type: 'code', redirect_uri: redirectUri, state }) });
  const t = await oc.relayToken('tiktok', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const secret = { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, via: 'relay' };
  return { secret, profile: await tiktokProfile(secret) };
}
async function tiktokRefresh(s) {
  const t = s.via === 'builtin'
    ? ttTokens((await request('TikTok', TT_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: toForm({ client_key: oc.appId('tiktok'), client_secret: builtinSecret('tiktok'), grant_type: 'refresh_token', refresh_token: s.refreshToken }) })).body)
    : await oc.relayToken('tiktok', { grant_type: 'refresh_token', refresh_token: s.refreshToken });
  return { ...s, accessToken: t.access_token, refreshToken: t.refresh_token || s.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
}

async function instagram(ctx) {
  const scope = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights';
  const { code, redirectUri } = await oc.relaySignIn('instagram', { openExternal: ctx.openExternal,
    buildUrl: ({ redirectUri, state }) => 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({ client_id: oc.appId('instagram'), redirect_uri: redirectUri, response_type: 'code', scope, state }) });
  const t = await oc.relayToken('instagram', { code, redirect_uri: redirectUri }); // relay returns the 60-day token
  const { body } = await request('Instagram', `https://graph.instagram.com/me?fields=user_id,username&access_token=${enc(t.access_token)}`);
  return { secret: { accessToken: t.access_token, refreshedAt: Date.now(), via: 'relay' }, profile: { name: '@' + body.username, id: String(body.user_id || body.id) } };
}

async function threads(ctx) {
  const scope = 'threads_basic,threads_content_publish,threads_manage_insights';
  const { code, redirectUri } = await oc.relaySignIn('threads', { openExternal: ctx.openExternal,
    buildUrl: ({ redirectUri, state }) => 'https://threads.net/oauth/authorize?' + new URLSearchParams({ client_id: oc.appId('threads'), redirect_uri: redirectUri, scope, response_type: 'code', state }) });
  const t = await oc.relayToken('threads', { code, redirect_uri: redirectUri });
  const { body } = await request('Threads', `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${enc(t.access_token)}`);
  return { secret: { accessToken: t.access_token, refreshedAt: Date.now(), via: 'relay' }, profile: { name: '@' + body.username, id: body.id } };
}

async function facebook(ctx) {
  const scope = 'pages_show_list,pages_manage_posts,pages_read_engagement,read_insights';
  const { code, redirectUri } = await oc.relaySignIn('facebook', { openExternal: ctx.openExternal,
    buildUrl: ({ redirectUri, state }) => 'https://www.facebook.com/v23.0/dialog/oauth?' + new URLSearchParams({ client_id: oc.appId('facebook'), redirect_uri: redirectUri, state, scope, response_type: 'code' }) });
  const t = await oc.relayToken('facebook', { code, redirect_uri: redirectUri }); // long-lived user token
  const { body } = await request('Facebook', `${FB}/me/accounts?fields=id,name,access_token&access_token=${enc(t.access_token)}`);
  const pages = body.data || [];
  if (!pages.length) throw new Error('This Facebook account does not manage any Pages. Create a Page first, then connect again.');
  const page = pages.find(p => p.id === ctx.account.config.pageId) || pages[0]; // Page tokens from a long-lived user token do not expire
  return { secret: { accessToken: page.access_token, via: 'relay' }, profile: { name: page.name, id: page.id, pages: pages.map(p => ({ id: p.id, name: p.name })) } };
}

// X: PKCE public client, no secret and no relay. The built-in app registers the standard redirect.
async function x(ctx, scopes) {
  const clientId = oc.appId('x');
  const verifier = randomVerifier();
  const state = crypto.randomUUID();
  const { code } = await loopbackSignIn({ state, openExternal: ctx.openExternal,
    buildUrl: () => 'https://x.com/i/oauth2/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, scope: scopes.join(' '), state, code_challenge: challengeBase64Url(verifier), code_challenge_method: 'S256' }) });
  const { body } = await request('X', 'https://api.x.com/2/oauth2/token', { method: 'POST', body: toForm({ code, grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier }) });
  const secret = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, clientId };
  const me = await request('X', 'https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${secret.accessToken}` } });
  return { secret, profile: { name: '@' + me.body.data.username, id: me.body.data.id } };
}

module.exports = { tiktok, tiktokRefresh, instagram, threads, facebook, x };
