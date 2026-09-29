'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');

const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ch-'));

function fakePlatform(id, behavior) {
  let calls = 0;
  return {
    id, name: id.toUpperCase(), auth: 'token', supports: { text: true, image: true, video: true }, configFields: [{ key: 'accessToken', secret: true }],
    async connect(ctx) { return { secret: { accessToken: ctx.account.config.accessToken }, profile: { name: '@me', id: '1' } }; },
    async publish(post, ctx) { calls++; return behavior(calls, post, ctx); },
    async fetchAccountStats() { return { followers: 10 }; },
    async fetchPostStats(ids) { return Object.fromEntries(ids.map(i => [i, { views: 5, likes: 1 }])); },
    get calls() { return calls; }
  };
}

async function setup(platformMap, settings = {}) {
  const store = new Store(tmp());
  store.updateSettings({ requireApproval: false, ...settings });
  const engine = new Engine({ store, box, openExternal: () => {}, platformMap });
  for (const pid of Object.keys(platformMap)) {
    engine.saveAccountConfig(pid, { accessToken: 'tok-' + pid });
    await engine.connect(pid);
  }
  return { store, engine };
}

test('secrets are stored encrypted, never in plain config', async () => {
  const { store } = await setup({ a: fakePlatform('a', () => ({ remoteId: '1' })) });
  const raw = fs.readFileSync(store.file, 'utf8');
  assert.ok(!raw.includes('tok-a'), 'token must not appear in plaintext');
});

test('due approved post publishes to every platform', async () => {
  const a = fakePlatform('a', () => ({ remoteId: 'A1', url: 'https://a/1' }));
  const b = fakePlatform('b', () => ({ remoteId: 'B1' }));
  const { store, engine } = await setup({ a, b });
  const p = store.createPost({ caption: 'hi', platforms: ['a', 'b'], scheduledAt: new Date(Date.now() - 1000).toISOString() });
  const future = store.createPost({ caption: 'later', platforms: ['a'], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  await engine.tick();
  assert.strictEqual(store.getPost(p.id).status, 'published');
  assert.strictEqual(store.getPost(p.id).results.a.url, 'https://a/1');
  assert.strictEqual(store.getPost(future.id).status, 'approved');
  assert.strictEqual(a.calls, 1);
});

test('approval gate: pending posts never publish', async () => {
  const a = fakePlatform('a', () => ({ remoteId: '1' }));
  const { store, engine } = await setup({ a }, { requireApproval: true });
  const p = store.createPost({ caption: 'x', platforms: ['a'], scheduledAt: new Date(0).toISOString() });
  assert.strictEqual(p.status, 'pending_approval');
  await engine.tick();
  assert.strictEqual(a.calls, 0);
});

test('partial failure retries only the failed platform, then gives up', async () => {
  const good = fakePlatform('good', () => ({ remoteId: 'G' }));
  const bad = fakePlatform('bad', () => { throw new Error('boom'); });
  const { store, engine } = await setup({ good, bad }, { maxAttempts: 2 });
  const p = store.createPost({ caption: 'x', platforms: ['good', 'bad'], scheduledAt: new Date(0).toISOString() });
  await engine.tick();
  let post = store.getPost(p.id);
  assert.strictEqual(post.status, 'retrying');
  assert.strictEqual(post.results.bad.error, 'boom');
  await engine.tick(Date.now() + 11 * 60e3); // after retry delay
  post = store.getPost(p.id);
  assert.strictEqual(post.status, 'partial_failed');
  assert.strictEqual(good.calls, 1, 'successful platform is not re-posted');
  assert.strictEqual(bad.calls, 2);
  engine.retry(p.id);
  assert.strictEqual(store.getPost(p.id).status, 'approved');
});

test('analytics snapshots are stored per post and account', async () => {
  const a = fakePlatform('a', () => ({ remoteId: 'R1' }));
  const { store, engine } = await setup({ a });
  const p = store.createPost({ caption: 'x', platforms: ['a'], scheduledAt: new Date(0).toISOString() });
  await engine.tick();
  await engine.refreshAnalytics();
  assert.strictEqual(store.data.analytics.posts[p.id].a.views, 5);
  assert.strictEqual(store.data.analytics.account.a.at(-1).followers, 10);
});

test('batch import resolves relative media paths and validates', async () => {
  const a = fakePlatform('a', () => ({ remoteId: '1' }));
  const { store, engine } = await setup({ a });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'x');
  const created = engine.importBatch({ posts: [{ caption: 'c', media: 'clip.mp4', platforms: ['a'], scheduledAt: '2030-01-01T09:00:00-08:00' }] }, dir);
  assert.strictEqual(created[0].mediaPath, path.join(dir, 'clip.mp4'));
  assert.strictEqual(created[0].mediaType, 'video');
  assert.deepStrictEqual(engine.validatePost(created[0]), []);
  assert.ok(engine.validatePost({ ...created[0], platforms: ['nope'] }).length);
  assert.strictEqual(store.listPosts().length, 1);
});
