'use strict';
// The site update feed, the GitHub fallback, and the in-app downloader (size + SHA-256 checks).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { checkForUpdate } = require('../src/installer/updates');
const { downloadUpdate } = require('../src/installer/download');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));

const SITE = {
  version: '2.6.0', notes: 'What changed', page: 'https://spektly.com/download/',
  files: {
    'darwin-arm64': { url: 'https://spektly.com/download/Spektly-mac-arm64.dmg', name: 'Spektly-mac-arm64.dmg', size: 10, sha256: 'aa' },
    'darwin-x64': { url: 'https://spektly.com/download/Spektly-mac-x64.dmg', name: 'Spektly-mac-x64.dmg', size: 11, sha256: 'bb' },
    'win32-x64': { url: 'https://spektly.com/download/Spektly-Setup.exe', name: 'Spektly-Setup.exe', size: 12, sha256: 'cc' }
  }
};
const GH = { tag_name: 'v2.6.0', html_url: 'https://gh/rel', body: 'notes', assets: [
  { name: 'Spektly-mac-arm64.dmg', browser_download_url: 'https://gh/arm.dmg', size: 1 },
  { name: 'Spektly-mac-x64.dmg', browser_download_url: 'https://gh/intel.dmg', size: 2 },
  { name: 'Spektly-Setup.exe', browser_download_url: 'https://gh/win.exe', size: 3 }] };
const serve = map => async url => map[url] ? new Response(JSON.stringify(map[url])) : new Response('no', { status: 404 });

test('update feed: prefers spektly.com, carries a checksum, and matches the platform', async () => {
  const f = serve({ 'https://site/f.json': SITE });
  const go = (platform, arch) => checkForUpdate({ feedUrl: 'https://site/f.json', fallbackFeedUrl: 'https://gh/api', currentVersion: '2.5.0', platform, arch, fetchImpl: f });
  const mac = await go('darwin', 'arm64');
  assert.strictEqual(mac.url, 'https://spektly.com/download/Spektly-mac-arm64.dmg');
  assert.strictEqual(mac.sha256, 'aa'); assert.strictEqual(mac.source, 'site');
  assert.strictEqual((await go('darwin', 'x64')).url, SITE.files['darwin-x64'].url);
  assert.strictEqual((await go('win32', 'x64')).url, SITE.files['win32-x64'].url);
  assert.strictEqual(await go('linux', 'x64'), null);
  // nothing newer
  assert.strictEqual(await checkForUpdate({ feedUrl: 'https://site/f.json', currentVersion: '2.6.0', platform: 'darwin', arch: 'arm64', fetchImpl: f }), null);
});

test('update feed: falls back to GitHub only when the site feed is unreachable', async () => {
  const both = serve({ 'https://site/f.json': SITE, 'https://gh/api': GH });
  const r1 = await checkForUpdate({ feedUrl: 'https://site/f.json', fallbackFeedUrl: 'https://gh/api', currentVersion: '2.5.0', platform: 'darwin', arch: 'arm64', fetchImpl: both });
  assert.strictEqual(r1.source, 'site');
  const ghOnly = serve({ 'https://gh/api': GH });
  const r2 = await checkForUpdate({ feedUrl: 'https://site/f.json', fallbackFeedUrl: 'https://gh/api', currentVersion: '2.5.0', platform: 'darwin', arch: 'arm64', fetchImpl: ghOnly });
  assert.strictEqual(r2.source, 'github');
  assert.strictEqual(r2.url, 'https://gh/arm.dmg');
  // offline: no crash, no update
  assert.strictEqual(await checkForUpdate({ feedUrl: 'https://site/f.json', fallbackFeedUrl: 'https://gh/api', currentVersion: '2.5.0', platform: 'darwin', arch: 'arm64', fetchImpl: async () => { throw new Error('offline'); } }), null);
});

test('downloader: writes the file, reports progress, and verifies size and checksum', async () => {
  const body = Buffer.from('spektly installer bytes');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const ok = async () => new Response(body, { headers: { 'content-length': String(body.length) } });
  const dir = tmp(); const seen = [];
  const r = await downloadUpdate({ url: 'https://spektly.com/download/Spektly-mac-arm64.dmg', dir, name: 'Spektly-mac-arm64.dmg', size: body.length, sha256: sha, onProgress: p => seen.push(p), fetchImpl: ok });
  assert.strictEqual(fs.readFileSync(r.file).toString(), body.toString());
  assert.strictEqual(r.verified, true);
  assert.ok(seen.length >= 1 && seen.at(-1).done === body.length);

  // a tampered or truncated file is deleted, never handed to the user
  const dir2 = tmp();
  await assert.rejects(
    downloadUpdate({ url: 'https://spektly.com/download/x.dmg', dir: dir2, name: 'x.dmg', size: body.length, sha256: 'deadbeef', fetchImpl: ok }),
    /integrity check/);
  assert.deepStrictEqual(fs.readdirSync(dir2), []);

  // refuses plain http, odd file names, and a short read
  await assert.rejects(downloadUpdate({ url: 'http://spektly.com/x.dmg', dir: tmp(), name: 'x.dmg', fetchImpl: ok }), /secure address/);
  await assert.rejects(downloadUpdate({ url: 'https://spektly.com/x', dir: tmp(), name: '../evil.sh', fetchImpl: ok }), /not valid/);
  await assert.rejects(downloadUpdate({ url: 'https://spektly.com/x.dmg', dir: tmp(), name: 'x.dmg', size: 999, fetchImpl: ok }), /different size|did not download/);
  await assert.rejects(downloadUpdate({ url: 'https://spektly.com/x.dmg', dir: tmp(), name: 'x.dmg', fetchImpl: async () => new Response('no', { status: 500 }) }), /Could not download/);
});
