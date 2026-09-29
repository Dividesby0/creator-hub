'use strict';
// Instagram — Instagram API with Instagram Login (graph.instagram.com) or via Facebook Login (graph.facebook.com).
// Reels are uploaded straight from disk (resumable upload). Single images need a public URL (Meta fetches them).
const { request, toForm, fileInfo, readChunk, captionFor, sleep, ApiError } = require('../util');

const VERSION = 'v23.0';

function base(ctx) {
  const host = ctx.account.config.apiHost || 'graph.instagram.com';
  return `https://${host}/${VERSION}`;
}
const tokenOf = ctx => ctx.account.secret.accessToken;

async function waitForContainer(ctx, id) {
  for (let i = 0; i < 60; i++) {
    const { body } = await request('Instagram', `${base(ctx)}/${id}?fields=status_code,status&access_token=${encodeURIComponent(tokenOf(ctx))}`);
    if (body.status_code === 'FINISHED') return;
    if (body.status_code === 'ERROR' || body.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${body.status || body.status_code}`);
    await sleep(5000);
  }
  throw new Error('Instagram is still processing the video after 5 minutes; it will retry.');
}

module.exports = {
  id: 'instagram',
  name: 'Instagram',
  auth: 'token',
  supports: { text: false, image: true, video: true },
  configFields: [
    { key: 'userId', label: 'Instagram account ID (leave blank to auto-detect)' },
    { key: 'apiHost', label: 'API host', type: 'select', options: ['graph.instagram.com', 'graph.facebook.com'], default: 'graph.instagram.com',
      help: 'graph.instagram.com for "Instagram API with Instagram Login" tokens; graph.facebook.com if you connected through a Facebook Page.' },
    { key: 'accessToken', label: 'Long-lived access token', secret: true, isToken: true }
  ],
  postOptions: [],

  async connect(ctx) {
    const token = ctx.account.config.accessToken;
    if (!token) throw new Error('Paste a long-lived access token first.');
    const fields = (ctx.account.config.apiHost || 'graph.instagram.com') === 'graph.instagram.com' ? 'user_id,username' : 'id,username';
    const id = ctx.account.config.userId || 'me';
    const { body } = await request('Instagram', `${base({ account: { config: ctx.account.config } })}/${id}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
    return { secret: { accessToken: token, refreshedAt: Date.now() },
      profile: { name: '@' + body.username, id: String(body.user_id || body.id) } };
  },

  // Instagram-Login long-lived tokens last 60 days and can be refreshed.
  async maintain(ctx) {
    if ((ctx.account.config.apiHost || 'graph.instagram.com') !== 'graph.instagram.com') return;
    const s = ctx.account.secret;
    if (s.refreshedAt && Date.now() - s.refreshedAt < 7 * 864e5) return;
    const { body } = await request('Instagram', `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.accessToken)}`);
    await ctx.saveSecret({ ...s, accessToken: body.access_token, refreshedAt: Date.now() });
  },

  async publish(post, ctx) {
    const igId = ctx.account.profile?.id || ctx.account.config.userId;
    const token = tokenOf(ctx);
    const caption = captionFor(post, 'instagram', ctx.settings, 2200);
    let containerId;

    if (post.mediaType === 'video') {
      const { body } = await request('Instagram', `${base(ctx)}/${igId}/media`, {
        method: 'POST',
        body: toForm({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true, access_token: token })
      });
      containerId = body.id;
      const info = fileInfo(post.mediaPath);
      const uploadUrl = body.uri || `https://rupload.facebook.com/ig-api-upload/${VERSION}/${containerId}`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(info.size) },
        body: readChunk(post.mediaPath, 0, info.size)
      });
      if (!res.ok) throw new ApiError('Instagram', res.status, await res.text());
      await waitForContainer(ctx, containerId);
    } else if (post.mediaType === 'image') {
      if (!post.publicMediaUrl) throw new Error('Instagram images must be at a public URL (Meta downloads them). Add a "Public media URL" to this post, or post a video instead.');
      const { body } = await request('Instagram', `${base(ctx)}/${igId}/media`, {
        method: 'POST', body: toForm({ image_url: post.publicMediaUrl, caption, access_token: token })
      });
      containerId = body.id;
      await waitForContainer(ctx, containerId);
    } else {
      throw new Error('Instagram needs an image or video.');
    }

    const pub = await request('Instagram', `${base(ctx)}/${igId}/media_publish`, {
      method: 'POST', body: toForm({ creation_id: containerId, access_token: token })
    });
    let url = '';
    try {
      const { body } = await request('Instagram', `${base(ctx)}/${pub.body.id}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      url = body.permalink || '';
    } catch (_) {}
    return { remoteId: pub.body.id, url };
  },

  async fetchAccountStats(ctx) {
    const id = ctx.account.profile?.id || 'me';
    const { body } = await request('Instagram', `${base(ctx)}/${id}?fields=followers_count,media_count&access_token=${encodeURIComponent(tokenOf(ctx))}`);
    return { followers: body.followers_count || 0, posts: body.media_count || 0 };
  },

  async fetchPostStats(ids, ctx) {
    const out = {};
    for (const id of ids) {
      try {
        const { body } = await request('Instagram', `${base(ctx)}/${id}?fields=like_count,comments_count&access_token=${encodeURIComponent(tokenOf(ctx))}`);
        const row = { likes: body.like_count || 0, comments: body.comments_count || 0 };
        try {
          const ins = await request('Instagram', `${base(ctx)}/${id}/insights?metric=views,shares&access_token=${encodeURIComponent(tokenOf(ctx))}`);
          for (const m of ins.body.data || []) row[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
        } catch (_) { /* insights need extra permission; skip */ }
        out[id] = row;
      } catch (_) { /* deleted or inaccessible */ }
    }
    return out;
  }
};
