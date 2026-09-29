'use strict';
// Adapter flow tests against a mocked fetch that mimics each platform's documented responses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = { appendAiHashtag: true, aiHashtag: '#AIgenerated' };
const tmpFile = (name, bytes) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cha-')), name); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };
const ctxOf = (config, secret) => ({ account: { config, secret: { expiresAt: Date.now() + 3600e3, ...secret }, profile: { name: '@me', id: 'IG1' } }, settings, saveSecret: async () => {} });

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', opts });
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        const r = typeof handler === 'function' ? handler(String(url), opts, calls) : handler;
        return new Response(r.status === 204 ? null : r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
      }
    }
    throw new Error('Unmocked URL ' + url);
  };
  return calls;
}

test('X: chunked media upload then post with media id', async () => {
  const x = require('../src/platforms/x');
  const file = tmpFile('v.mp4', 9 * 1024 * 1024); // 3 chunks of 4MB
  const calls = mockFetch([
    ['/media/upload/initialize', { body: { data: { id: 'M1' } } }],
    ['/append', { status: 204 }],
    ['/finalize', { body: { data: { id: 'M1', processing_info: { state: 'pending', check_after_secs: 0 } } } }],
    ['command=STATUS', { body: { data: { processing_info: { state: 'succeeded' } } } }],
    ['/2/tweets', (u, o) => ({ status: 201, body: { data: { id: 'T9', text: JSON.parse(o.body).text } } })]
  ]);
  const r = await x.publish({ caption: 'Deepfake calls are here https://ex.com', mediaType: 'video', mediaPath: file, aiGenerated: false }, ctxOf({}, { accessToken: 'A' }));
  assert.strictEqual(r.remoteId, 'T9');
  assert.strictEqual(r.cost, 0.20);
  assert.strictEqual(calls.filter(c => c.url.includes('/append')).length, 3);
  const tweet = JSON.parse(calls.find(c => c.url.endsWith('/2/tweets')).opts.body);
  assert.deepStrictEqual(tweet.media.media_ids, ['M1']);
  assert.strictEqual(JSON.parse(calls[0].opts.body).media_category, 'tweet_video');
});

test('X: rejects over-length text before spending money', async () => {
  const x = require('../src/platforms/x');
  mockFetch([]);
  await assert.rejects(x.publish({ caption: 'a'.repeat(281), mediaType: 'none' }, ctxOf({}, { accessToken: 'A' })), /limit here is 280/);
});

test('TikTok: chunk plan follows the documented rules', () => {
  const { chunkPlan } = require('../src/platforms/tiktok');
  assert.deepStrictEqual(chunkPlan(3e6), { chunkSize: 3e6, count: 1 });
  assert.deepStrictEqual(chunkPlan(64 * 1024 * 1024), { chunkSize: 64 * 1024 * 1024, count: 1 });
  const big = 105 * 1024 * 1024;
  const p = chunkPlan(big);
  assert.strictEqual(p.count, Math.floor(big / p.chunkSize));
  assert.ok(big - (p.count - 1) * p.chunkSize <= 128 * 1024 * 1024);
});

test('TikTok: inbox (drafts) upload flow', async () => {
  const tt = require('../src/platforms/tiktok');
  const file = tmpFile('v.mp4', 2000);
  const calls = mockFetch([
    ['/post/publish/inbox/video/init/', { body: { data: { publish_id: 'P1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1' }, error: { code: 'ok' } } }],
    ['open-upload.tiktokapis.com', { status: 201 }],
    ['/post/publish/status/fetch/', { body: { data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } } }]
  ]);
  const r = await tt.publish({ caption: 'hi', mediaType: 'video', mediaPath: file }, ctxOf({ mode: 'drafts' }, { accessToken: 'A' }));
  assert.strictEqual(r.remoteId, 'P1');
  assert.match(r.note, /inbox/);
  const put = calls.find(c => c.method === 'PUT');
  assert.strictEqual(put.opts.headers['Content-Range'], 'bytes 0-1999/2000');
});

test('TikTok: direct post falls back to an allowed privacy level and sets AI label', async () => {
  const tt = require('../src/platforms/tiktok');
  const file = tmpFile('v.mp4', 1000);
  const calls = mockFetch([
    ['/creator_info/query/', { body: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } }],
    ['/post/publish/video/init/', { body: { data: { publish_id: 'P2', upload_url: 'https://open-upload.tiktokapis.com/video/?u=2' }, error: { code: 'ok' } } }],
    ['open-upload.tiktokapis.com', { status: 201 }],
    ['/status/fetch/', { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, error: { code: 'ok' } } }]
  ]);
  const r = await tt.publish({ caption: 'hi', mediaType: 'video', mediaPath: file, aiGenerated: true }, ctxOf({ mode: 'direct' }, { accessToken: 'A' }));
  const init = JSON.parse(calls.find(c => c.url.includes('/video/init/')).opts.body);
  assert.strictEqual(init.post_info.privacy_level, 'SELF_ONLY');
  assert.strictEqual(init.post_info.is_aigc, true);
  assert.match(init.post_info.title, /#AIgenerated/);
  assert.strictEqual(r.remoteId, '7123');
});

test('YouTube: resumable upload handles 308 and sets synthetic-media flag', async () => {
  const yt = require('../src/platforms/youtube');
  const size = 10 * 1024 * 1024;
  const file = tmpFile('v.mp4', size);
  let puts = 0;
  const calls = mockFetch([
    ['uploadType=resumable', { headers: { location: 'https://upload.example/session1' } }],
    ['upload.example/session1', () => (++puts === 1 ? { status: 308, headers: { range: `bytes=0-${8 * 1024 * 1024 - 1}` } } : { body: { id: 'VID1' } })]
  ]);
  const r = await yt.publish({ title: 'T', caption: 'desc', mediaType: 'video', mediaPath: file, aiGenerated: true, overrides: {} }, ctxOf({}, { accessToken: 'A' }));
  assert.strictEqual(r.remoteId, 'VID1');
  const meta = JSON.parse(calls[0].opts.body);
  assert.strictEqual(meta.status.containsSyntheticMedia, true);
  assert.strictEqual(calls[2].opts.headers['Content-Range'], `bytes ${8 * 1024 * 1024}-${size - 1}/${size}`);
});

test('Threads: text post creates then publishes', async () => {
  const th = require('../src/platforms/threads');
  const calls = mockFetch([
    ['/me/threads_publish', { body: { id: 'TP1' } }],
    ['/me/threads', { body: { id: 'C1' } }],
    ['/TP1?fields=permalink', { body: { permalink: 'https://threads.net/p/1' } }]
  ]);
  const r = await th.publish({ caption: 'hello', mediaType: 'none' }, ctxOf({}, { accessToken: 'A' }));
  assert.strictEqual(r.url, 'https://threads.net/p/1');
  assert.ok(calls[0].opts.body.toString().includes('media_type=TEXT'));
});

test('Instagram: reel resumable upload → wait → publish', async () => {
  const ig = require('../src/platforms/instagram');
  const file = tmpFile('v.mp4', 5000);
  const calls = mockFetch([
    ['/IG1/media_publish', { body: { id: 'MEDIA9' } }],
    ['/IG1/media', { body: { id: 'CONT1', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/CONT1' } }],
    ['rupload.facebook.com', { body: { success: true } }],
    ['/CONT1?fields=status_code', { body: { status_code: 'FINISHED' } }],
    ['/MEDIA9?fields=permalink', { body: { permalink: 'https://instagram.com/reel/x' } }]
  ]);
  const r = await ig.publish({ caption: 'c', mediaType: 'video', mediaPath: file }, ctxOf({}, { accessToken: 'A' }));
  assert.strictEqual(r.remoteId, 'MEDIA9');
  const up = calls.find(c => c.url.includes('rupload'));
  assert.strictEqual(up.opts.headers.file_size, '5000');
  assert.strictEqual(up.opts.headers.Authorization, 'OAuth A');
});

test('Instagram: images without a public URL fail with a clear message', async () => {
  const ig = require('../src/platforms/instagram');
  mockFetch([]);
  await assert.rejects(ig.publish({ caption: 'c', mediaType: 'image', mediaPath: '/x.jpg' }, ctxOf({}, { accessToken: 'A' })), /public URL/);
});
