'use strict';
// Facebook Page - Graph API with a Page access token. Videos and photos upload directly from disk.
const { request, toForm, fileInfo, readChunk, captionFor } = require('../util');

const VERSION = 'v23.0';
const G = `https://graph.facebook.com/${VERSION}`;
const GV = `https://graph-video.facebook.com/${VERSION}`;

function fileBlob(p) {
  const info = fileInfo(p);
  return { blob: new Blob([readChunk(p, 0, info.size)], { type: info.mime }), name: info.name };
}

module.exports = {
  id: 'facebook',
  name: 'Facebook Page',
  auth: 'token',
  supports: { text: true, image: true, video: true },
  configFields: [
    { key: 'pageId', label: 'Page ID' },
    { key: 'accessToken', label: 'Page access token (long-lived)', secret: true, isToken: true }
  ],
  postOptions: [
    { key: 'title', label: 'Video title', type: 'text' },
    { key: 'link', label: 'Link (text posts)', type: 'text' }
  ],

  oneClick: () => require('../oauth/oneclick').available('facebook'),

  async connect(ctx) {
    const { pageId, accessToken } = ctx.account.config;
    if (!accessToken && require('../oauth/oneclick').available('facebook')) return require('../oauth/flows').facebook(ctx);
    if (!pageId || !accessToken) throw new Error('Enter the Page ID and a Page access token first.');
    const { body } = await request('Facebook', `${G}/${pageId}?fields=name&access_token=${encodeURIComponent(accessToken)}`);
    return { secret: { accessToken }, profile: { name: body.name, id: pageId } };
  },

  async publish(post, ctx) {
    const pageId = ctx.account.config.pageId || ctx.account.profile?.id;
    const token = ctx.account.secret.accessToken;
    const text = captionFor(post, 'facebook', ctx.settings, 63206);
    const o = post.overrides?.facebook || {};

    if (post.mediaType === 'video') {
      const { blob, name } = fileBlob(post.mediaPath);
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('description', text);
      if (o.title || post.title) fd.append('title', o.title || post.title);
      fd.append('source', blob, name);
      const { body } = await request('Facebook', `${GV}/${pageId}/videos`, { method: 'POST', body: fd });
      return { remoteId: body.id, url: `https://www.facebook.com/${pageId}/videos/${body.id}` };
    }
    if (post.mediaType === 'image') {
      const { blob, name } = fileBlob(post.mediaPath);
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('caption', text);
      fd.append('source', blob, name);
      const { body } = await request('Facebook', `${G}/${pageId}/photos`, { method: 'POST', body: fd });
      const id = body.post_id || body.id;
      return { remoteId: id, url: `https://www.facebook.com/${id}` };
    }
    const { body } = await request('Facebook', `${G}/${pageId}/feed`, {
      method: 'POST', body: toForm({ message: text, link: o.link || undefined, access_token: token })
    });
    return { remoteId: body.id, url: `https://www.facebook.com/${body.id}` };
  },

  async fetchAccountStats(ctx) {
    const pageId = ctx.account.config.pageId || ctx.account.profile?.id;
    const { body } = await request('Facebook', `${G}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(ctx.account.secret.accessToken)}`);
    return { followers: body.followers_count ?? body.fan_count ?? 0 };
  },

  async fetchPostStats(ids, ctx) {
    const token = encodeURIComponent(ctx.account.secret.accessToken);
    const out = {};
    for (const id of ids) {
      try {
        if (!id.includes('_')) { // video id
          const { body } = await request('Facebook', `${G}/${id}?fields=likes.summary(true),comments.summary(true)&access_token=${token}`);
          const row = { likes: body.likes?.summary?.total_count || 0, comments: body.comments?.summary?.total_count || 0 };
          try {
            const ins = await request('Facebook', `${G}/${id}/video_insights?metric=total_video_views&access_token=${token}`);
            row.views = ins.body.data?.[0]?.values?.[0]?.value || 0;
          } catch (_) {}
          out[id] = row;
        } else {
          const { body } = await request('Facebook', `${G}/${id}?fields=reactions.summary(true),comments.summary(true),shares&access_token=${token}`);
          out[id] = { likes: body.reactions?.summary?.total_count || 0, comments: body.comments?.summary?.total_count || 0, shares: body.shares?.count || 0 };
        }
      } catch (_) {}
    }
    return out;
  }
};
