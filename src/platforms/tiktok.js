'use strict';
// TikTok Content Posting API - Login Kit for Desktop (PKCE hex), inbox upload (drafts) or direct post.
const { request, toForm, randomVerifier, challengeHex, waitForAuthCode, REDIRECT_URI,
  fileInfo, readChunk, captionFor, sleep, ApiError } = require('../util');
const crypto = require('crypto');

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'user.info.stats', 'video.upload', 'video.publish', 'video.list'];
const oneclick = require('../oauth/oneclick');
const flows = require('../oauth/flows');
const MIN_CHUNK = 5 * 1024 * 1024, MAX_SINGLE = 64 * 1024 * 1024, CHUNK = 10 * 1024 * 1024;

function tt(body) {
  if (body?.error && body.error.code && body.error.code !== 'ok') throw new ApiError('TikTok', 200, body, `TikTok: ${body.error.code}: ${body.error.message}`);
  return body;
}

async function refresh(ctx) {
  const s = ctx.account.secret;
  if (s.expiresAt && Date.now() < s.expiresAt - 60_000) return s.accessToken;
  if (s.via === 'relay' || s.via === 'builtin') { const next = await require('../oauth/flows').tiktokRefresh(s); await ctx.saveSecret(next); return next.accessToken; }
  const { body } = await request('TikTok', `${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toForm({ client_key: ctx.account.config.clientKey, client_secret: ctx.account.config.clientSecret,
      grant_type: 'refresh_token', refresh_token: s.refreshToken })
  });
  if (body.error) throw new Error(`TikTok token refresh failed: ${body.error_description || body.error}. Reconnect TikTok.`);
  const next = { accessToken: body.access_token, refreshToken: body.refresh_token || s.refreshToken, expiresAt: Date.now() + body.expires_in * 1000 };
  await ctx.saveSecret(next);
  return next.accessToken;
}

// TikTok chunk rules: files <=64MB go up as one chunk; otherwise fixed chunks, last chunk absorbs the remainder.
function chunkPlan(size) {
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const count = Math.floor(size / CHUNK);
  return { chunkSize: CHUNK, count };
}

async function uploadChunks(uploadUrl, filePath, info, plan) {
  for (let i = 0; i < plan.count; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.count - 1 ? info.size : start + plan.chunkSize;
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': info.mime, 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${info.size}` },
      body: readChunk(filePath, start, end)
    });
    if (!res.ok && res.status !== 206) throw new ApiError('TikTok', res.status, await res.text());
  }
}

module.exports = {
  id: 'tiktok',
  name: 'TikTok',
  auth: 'oauth',
  supports: { text: false, image: false, video: true },
  chunkPlan,
  configFields: [
    { key: 'clientKey', label: 'Client key' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'mode', label: 'Posting mode', type: 'select', options: ['drafts', 'direct'], default: 'drafts',
      help: 'drafts = video lands in your TikTok inbox to finish and post (works before TikTok audits your app). direct = posts immediately (private-only until TikTok approves your app).' }
  ],
  postOptions: [
    { key: 'privacy', label: 'Privacy (direct mode)', type: 'select', options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'], default: 'PUBLIC_TO_EVERYONE' }
  ],

  oneClick: () => oneclick.available('tiktok'),

  async connect(ctx) {
    const { clientKey, clientSecret } = ctx.account.config;
    // Own keys only count when both are filled in; a half-filled form (or a username typed into the
    // key box) must never override Spektly's built-in TikTok app.
    const ownKeys = !!(clientKey && clientKey.trim() && clientSecret && String(clientSecret).trim());
    if (!ownKeys && oneclick.available('tiktok')) return flows.tiktok(ctx);
    if (!clientKey || !clientSecret) throw new Error('Enter the Client key and Client secret first.');
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const url = `${AUTH}?` + new URLSearchParams({
      client_key: clientKey, response_type: 'code', scope: SCOPES.join(','), redirect_uri: REDIRECT_URI,
      state, code_challenge: challengeHex(verifier), code_challenge_method: 'S256'
    });
    const code = await waitForAuthCode({ authUrl: url, state, openExternal: ctx.openExternal });
    const { body } = await request('TikTok', `${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toForm({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI, code_verifier: verifier })
    });
    if (body.error) throw new Error(`TikTok login failed: ${body.error_description || body.error}`);
    const secret = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
    const me = await request('TikTok', `${API}/user/info/?fields=open_id,display_name`, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
    return { secret, profile: { name: me.body.data?.user?.display_name || 'TikTok account', id: me.body.data?.user?.open_id } };
  },

  async publish(post, ctx) {
    if (post.mediaType !== 'video' || !post.mediaPath) throw new Error('TikTok posting here supports video files.');
    const token = await refresh(ctx);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };
    const info = fileInfo(post.mediaPath);
    const plan = chunkPlan(info.size);
    const source_info = { source: 'FILE_UPLOAD', video_size: info.size, chunk_size: plan.chunkSize, total_chunk_count: plan.count };
    const direct = (ctx.account.config.mode || 'drafts') === 'direct';

    let init;
    if (direct) {
      const ci = tt((await request('TikTok', `${API}/post/publish/creator_info/query/`, { method: 'POST', headers: auth, body: '{}' })).body);
      const options = ci.data?.privacy_level_options || [];
      let privacy = post.overrides?.tiktok?.privacy || 'PUBLIC_TO_EVERYONE';
      if (!options.includes(privacy)) privacy = options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
      const title = captionFor(post, 'tiktok', ctx.settings, 2200);
      init = tt((await request('TikTok', `${API}/post/publish/video/init/`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ post_info: { title, privacy_level: privacy, disable_comment: false, disable_duet: false,
          disable_stitch: false, is_aigc: !!post.aiGenerated }, source_info })
      })).body);
    } else {
      init = tt((await request('TikTok', `${API}/post/publish/inbox/video/init/`, {
        method: 'POST', headers: auth, body: JSON.stringify({ source_info })
      })).body);
    }
    await uploadChunks(init.data.upload_url, post.mediaPath, info, plan);

    // Poll status briefly; TikTok keeps processing server-side either way.
    let status = 'PROCESSING_UPLOAD', postId = null;
    for (let i = 0; i < 20; i++) {
      await sleep(i === 0 ? 1000 : 3000);
      const st = tt((await request('TikTok', `${API}/post/publish/status/fetch/`, {
        method: 'POST', headers: auth, body: JSON.stringify({ publish_id: init.data.publish_id })
      })).body);
      status = st.data?.status;
      postId = st.data?.publicaly_available_post_id?.[0] || null;
      if (status === 'FAILED') throw new Error(`TikTok processing failed: ${st.data?.fail_reason || 'unknown reason'}`);
      if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX') break;
    }
    return {
      remoteId: postId ? String(postId) : init.data.publish_id,
      url: postId ? `https://www.tiktok.com/video/${postId}` : '',
      note: direct ? `Status: ${status}` : 'Sent to your TikTok inbox. Open the TikTok app to add sound or a caption and post it.'
    };
  },

  async fetchAccountStats(ctx) {
    const token = await refresh(ctx);
    const { body } = await request('TikTok', `${API}/user/info/?fields=follower_count,likes_count,video_count`, { headers: { Authorization: `Bearer ${token}` } });
    const u = tt(body).data?.user || {};
    return { followers: u.follower_count || 0, likes: u.likes_count || 0, posts: u.video_count || 0 };
  },

  async fetchPostStats(ids, ctx) {
    const numeric = ids.filter(i => /^\d+$/.test(i));
    if (!numeric.length) return {};
    const token = await refresh(ctx);
    const out = {};
    for (let i = 0; i < numeric.length; i += 20) {
      const { body } = await request('TikTok', `${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { video_ids: numeric.slice(i, i + 20) } })
      });
      for (const v of tt(body).data?.videos || []) out[v.id] = { views: v.view_count || 0, likes: v.like_count || 0, comments: v.comment_count || 0, shares: v.share_count || 0 };
    }
    return out;
  }
};
