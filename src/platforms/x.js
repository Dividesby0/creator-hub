'use strict';
// X API v2 — OAuth 2.0 PKCE, v2 chunked media upload, create post. Pay-per-use: ~$0.015/post, $0.20 if it contains a link.
const { request, toForm, randomVerifier, challengeBase64Url, waitForAuthCode, REDIRECT_URI,
  fileInfo, readChunk, captionFor, sleep } = require('../util');
const crypto = require('crypto');

const AUTH = 'https://x.com/i/oauth2/authorize';
const API = 'https://api.x.com/2';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const CHUNK = 4 * 1024 * 1024;
const URL_RE = /https?:\/\/\S+/i;

function tokenHeaders(config) {
  const h = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.clientSecret) h.Authorization = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  return h;
}

async function refresh(ctx) {
  const s = ctx.account.secret;
  if (s.expiresAt && Date.now() < s.expiresAt - 60_000) return s.accessToken;
  const c = ctx.account.config;
  const { body } = await request('X', `${API}/oauth2/token`, {
    method: 'POST', headers: tokenHeaders(c),
    body: toForm({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: c.clientId })
  });
  const next = { accessToken: body.access_token, refreshToken: body.refresh_token || s.refreshToken, expiresAt: Date.now() + body.expires_in * 1000 };
  await ctx.saveSecret(next);
  return next.accessToken;
}

function estimateCost(text) { return URL_RE.test(text) ? 0.20 : 0.015; }

async function uploadMedia(filePath, mediaType, token) {
  const info = fileInfo(filePath);
  const auth = { Authorization: `Bearer ${token}` };
  const category = mediaType === 'video' ? 'tweet_video' : info.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image';
  const init = await request('X', `${API}/media/upload/initialize`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: info.mime, total_bytes: info.size, media_category: category })
  });
  const id = init.body.data.id;
  for (let seg = 0, off = 0; off < info.size; seg++, off += CHUNK) {
    const fd = new FormData();
    fd.append('segment_index', String(seg));
    fd.append('media', new Blob([readChunk(filePath, off, Math.min(off + CHUNK, info.size))]), info.name);
    await request('X', `${API}/media/upload/${id}/append`, { method: 'POST', headers: auth, body: fd });
  }
  const fin = await request('X', `${API}/media/upload/${id}/finalize`, { method: 'POST', headers: auth });
  let pi = fin.body.data?.processing_info;
  while (pi && pi.state !== 'succeeded') {
    if (pi.state === 'failed') throw new Error(`X media processing failed: ${pi.error?.message || ''}`);
    await sleep((pi.check_after_secs || 2) * 1000);
    const st = await request('X', `${API}/media/upload?command=STATUS&media_id=${id}`, { headers: auth });
    pi = st.body.data?.processing_info;
  }
  return id;
}

module.exports = {
  id: 'x',
  name: 'X',
  auth: 'oauth',
  supports: { text: true, image: true, video: true },
  estimateCost,
  configFields: [
    { key: 'clientId', label: 'OAuth 2.0 Client ID' },
    { key: 'clientSecret', label: 'Client Secret (only if your app is "confidential")', secret: true },
    { key: 'premium', label: 'X Premium (long posts)', type: 'select', options: ['no', 'yes'], default: 'no' }
  ],
  postOptions: [],

  async connect(ctx) {
    const c = ctx.account.config;
    if (!c.clientId) throw new Error('Enter the OAuth 2.0 Client ID first.');
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const url = `${AUTH}?` + new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '),
      state, code_challenge: challengeBase64Url(verifier), code_challenge_method: 'S256'
    });
    const code = await waitForAuthCode({ authUrl: url, state, openExternal: ctx.openExternal });
    const { body } = await request('X', `${API}/oauth2/token`, {
      method: 'POST', headers: tokenHeaders(c),
      body: toForm({ code, grant_type: 'authorization_code', client_id: c.clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    });
    const secret = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
    const me = await request('X', `${API}/users/me`, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
    return { secret, profile: { name: '@' + me.body.data.username, id: me.body.data.id } };
  },

  async publish(post, ctx) {
    const token = await refresh(ctx);
    const text = captionFor(post, 'x', ctx.settings, ctx.account.config.premium === 'yes' ? 25000 : 280);
    const payload = { text };
    if (post.mediaType !== 'none' && post.mediaPath) payload.media = { media_ids: [await uploadMedia(post.mediaPath, post.mediaType, token)] };
    const { body } = await request('X', `${API}/tweets`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const handle = (ctx.account.profile?.name || '').replace('@', '') || 'i';
    return { remoteId: body.data.id, url: `https://x.com/${handle}/status/${body.data.id}`, cost: estimateCost(text) };
  },

  async fetchAccountStats(ctx) {
    if (!ctx.settings.xAnalytics) return null; // reads are billed; opt-in
    const token = await refresh(ctx);
    const { body } = await request('X', `${API}/users/me?user.fields=public_metrics`, { headers: { Authorization: `Bearer ${token}` } });
    const m = body.data.public_metrics || {};
    return { followers: m.followers_count || 0, posts: m.tweet_count || 0 };
  },

  async fetchPostStats(ids, ctx) {
    if (!ctx.settings.xAnalytics || !ids.length) return {};
    const token = await refresh(ctx);
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const { body } = await request('X', `${API}/tweets?ids=${ids.slice(i, i + 100).join(',')}&tweet.fields=public_metrics`, { headers: { Authorization: `Bearer ${token}` } });
      for (const t of body.data || []) {
        const m = t.public_metrics || {};
        out[t.id] = { views: m.impression_count || 0, likes: m.like_count || 0, comments: m.reply_count || 0, shares: (m.retweet_count || 0) + (m.quote_count || 0) };
      }
    }
    return out;
  }
};
