'use strict';
// Threads API (graph.threads.net). Text posts work directly; images/videos must be at a public URL (Meta fetches them).
const { request, toForm, captionFor, sleep } = require('../util');

const B = 'https://graph.threads.net/v1.0';
const enc = encodeURIComponent;

async function waitReady(id, token) {
  for (let i = 0; i < 60; i++) {
    const { body } = await request('Threads', `${B}/${id}?fields=status,error_message&access_token=${enc(token)}`);
    if (body.status === 'FINISHED') return;
    if (body.status === 'ERROR' || body.status === 'EXPIRED') throw new Error(`Threads processing failed: ${body.error_message || body.status}`);
    await sleep(5000);
  }
  throw new Error('Threads is still processing after 5 minutes; it will retry.');
}

module.exports = {
  id: 'threads',
  name: 'Threads',
  auth: 'token',
  supports: { text: true, image: true, video: true },
  configFields: [
    { key: 'accessToken', label: 'Long-lived Threads access token', secret: true, isToken: true }
  ],
  postOptions: [],

  oneClick: () => require('../oauth/oneclick').available('threads'),

  async connect(ctx) {
    const token = ctx.account.config.accessToken;
    if (!token && require('../oauth/oneclick').available('threads')) return require('../oauth/flows').threads(ctx);
    if (!token) throw new Error('Paste a long-lived Threads access token first.');
    const { body } = await request('Threads', `${B}/me?fields=id,username&access_token=${enc(token)}`);
    return { secret: { accessToken: token, refreshedAt: Date.now() }, profile: { name: '@' + body.username, id: body.id } };
  },

  async maintain(ctx) {
    const s = ctx.account.secret;
    if (s.refreshedAt && Date.now() - s.refreshedAt < 7 * 864e5) return;
    const { body } = await request('Threads', `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${enc(s.accessToken)}`);
    await ctx.saveSecret({ ...s, accessToken: body.access_token, refreshedAt: Date.now() });
  },

  async publish(post, ctx) {
    const token = ctx.account.secret.accessToken;
    const text = captionFor(post, 'threads', ctx.settings, 500);
    const params = { text, access_token: token };
    if (post.mediaType === 'none' || !post.mediaPath) {
      params.media_type = 'TEXT';
    } else {
      if (!post.publicMediaUrl) throw new Error('Threads media must be at a public URL (Meta downloads it). Add a "Public media URL", or post text-only here.');
      params.media_type = post.mediaType === 'video' ? 'VIDEO' : 'IMAGE';
      params[post.mediaType === 'video' ? 'video_url' : 'image_url'] = post.publicMediaUrl;
    }
    const c = await request('Threads', `${B}/me/threads`, { method: 'POST', body: toForm(params) });
    if (params.media_type !== 'TEXT') await waitReady(c.body.id, token);
    else await sleep(1000);
    const p = await request('Threads', `${B}/me/threads_publish`, { method: 'POST', body: toForm({ creation_id: c.body.id, access_token: token }) });
    let url = '';
    try { url = (await request('Threads', `${B}/${p.body.id}?fields=permalink&access_token=${enc(token)}`)).body.permalink || ''; } catch (_) {}
    return { remoteId: p.body.id, url };
  },

  async fetchAccountStats(ctx) {
    const token = ctx.account.secret.accessToken;
    const { body } = await request('Threads', `${B}/me/threads_insights?metric=followers_count&access_token=${enc(token)}`);
    const f = body.data?.find(m => m.name === 'followers_count');
    return { followers: f?.total_value?.value ?? f?.values?.[0]?.value ?? 0 };
  },

  async fetchPostStats(ids, ctx) {
    const token = ctx.account.secret.accessToken;
    const out = {};
    for (const id of ids) {
      try {
        const { body } = await request('Threads', `${B}/${id}/insights?metric=views,likes,replies,reposts&access_token=${enc(token)}`);
        const row = {};
        for (const m of body.data || []) row[m.name === 'replies' ? 'comments' : m.name === 'reposts' ? 'shares' : m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
        out[id] = row;
      } catch (_) {}
    }
    return out;
  }
};
