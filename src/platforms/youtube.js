'use strict';
// YouTube Data API v3 — OAuth (installed app, loopback + PKCE), resumable upload, stats.
const { request, toForm, randomVerifier, challengeBase64Url, waitForAuthCode, REDIRECT_URI,
  fileInfo, readChunk, captionFor, ApiError } = require('../util');
const crypto = require('crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB as required

async function refresh(ctx) {
  const s = ctx.account.secret;
  if (s.expiresAt && Date.now() < s.expiresAt - 60_000) return s.accessToken;
  const { body } = await request('YouTube', TOKEN, {
    method: 'POST',
    body: toForm({
      client_id: ctx.account.config.clientId,
      client_secret: ctx.account.config.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const next = { ...s, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  await ctx.saveSecret(next);
  return next.accessToken;
}

module.exports = {
  id: 'youtube',
  name: 'YouTube',
  auth: 'oauth',
  supports: { text: false, image: false, video: true },
  configFields: [
    { key: 'clientId', label: 'OAuth Client ID (Desktop app)' },
    { key: 'clientSecret', label: 'OAuth Client Secret', secret: true }
  ],
  postOptions: [
    { key: 'title', label: 'Video title (max 100)', type: 'text' },
    { key: 'privacy', label: 'Privacy', type: 'select', options: ['public', 'unlisted', 'private'], default: 'public' },
    { key: 'tags', label: 'Tags (comma separated)', type: 'text' }
  ],

  async connect(ctx) {
    const { clientId, clientSecret } = ctx.account.config;
    if (!clientId || !clientSecret) throw new Error('Enter the Client ID and Client Secret first.');
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const url = `${AUTH}?` + new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', state,
      code_challenge: challengeBase64Url(verifier), code_challenge_method: 'S256'
    });
    const code = await waitForAuthCode({ authUrl: url, state, openExternal: ctx.openExternal });
    const { body } = await request('YouTube', TOKEN, {
      method: 'POST',
      body: toForm({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
        grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
    });
    if (!body.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
    const secret = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
    const ch = await request('YouTube', `${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${secret.accessToken}` } });
    const c = ch.body.items?.[0];
    return { secret, profile: { name: c?.snippet?.title || 'YouTube channel', id: c?.id } };
  },

  async publish(post, ctx) {
    if (post.mediaType !== 'video' || !post.mediaPath) throw new Error('YouTube needs a video file.');
    const token = await refresh(ctx);
    const o = post.overrides?.youtube || {};
    const title = (o.title || post.title || post.caption.split('\n')[0] || 'Untitled').slice(0, 100);
    const description = captionFor(post, 'youtube', ctx.settings, 5000);
    const info = fileInfo(post.mediaPath);
    const meta = {
      snippet: {
        title, description, categoryId: '28', // Science & Technology
        tags: (o.tags || '').split(',').map(t => t.trim()).filter(Boolean)
      },
      status: {
        privacyStatus: o.privacy || 'public',
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: !!post.aiGenerated
      }
    };
    const init = await request('YouTube', `${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(info.size),
        'X-Upload-Content-Type': info.mime
      },
      body: JSON.stringify(meta)
    });
    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('YouTube did not return an upload URL.');

    let offset = 0, result = null;
    while (offset < info.size) {
      const end = Math.min(offset + CHUNK, info.size);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(end - offset),
          'Content-Range': `bytes ${offset}-${end - 1}/${info.size}` },
        body: readChunk(post.mediaPath, offset, end)
      });
      if (res.status === 308) {
        const range = res.headers.get('range'); // e.g. bytes=0-8388607
        offset = range ? Number(range.split('-')[1]) + 1 : end;
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new ApiError('YouTube', res.status, text);
      result = JSON.parse(text);
      break;
    }
    if (!result?.id) throw new Error('Upload finished without a video id.');
    return { remoteId: result.id, url: `https://www.youtube.com/watch?v=${result.id}` };
  },

  async fetchAccountStats(ctx) {
    const token = await refresh(ctx);
    const { body } = await request('YouTube', `${API}/channels?part=statistics&mine=true`, { headers: { Authorization: `Bearer ${token}` } });
    const s = body.items?.[0]?.statistics || {};
    return { followers: Number(s.subscriberCount || 0), views: Number(s.viewCount || 0), posts: Number(s.videoCount || 0) };
  },

  async fetchPostStats(ids, ctx) {
    if (!ids.length) return {};
    const token = await refresh(ctx);
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const { body } = await request('YouTube', `${API}/videos?part=statistics&id=${ids.slice(i, i + 50).join(',')}`, { headers: { Authorization: `Bearer ${token}` } });
      for (const v of body.items || []) {
        out[v.id] = { views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0 };
      }
    }
    return out;
  }
};
