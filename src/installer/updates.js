'use strict';
// Finds out whether a newer Spektly is available.
//
// Primary feed is Spektly's own: https://spektly.com/updates/latest.json — the installers are
// served from the same domain, and the feed carries a SHA-256 per file so the app can verify
// what it downloaded. The GitHub release API is kept as a fallback so older builds, and builds
// running before the site feed exists, still find updates.
const { cmpVersion } = require('./cleanup');

const KEY = (platform, arch) => platform === 'darwin' ? `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`
  : platform === 'win32' ? 'win32-x64' : null;

async function fromSiteFeed(feed, { currentVersion, platform, arch }) {
  const latest = String(feed.version || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest) || cmpVersion(latest, currentVersion) <= 0) return null;
  const f = (feed.files || {})[KEY(platform, arch)];
  if (!f || !/^https:\/\//i.test(String(f.url || ''))) return null;
  return {
    version: latest, url: f.url, name: f.name, size: f.size || 0, sha256: f.sha256 || '',
    notes: String(feed.notes || '').slice(0, 2000), page: feed.page || '', source: 'site'
  };
}

async function fromGithub(rel, { currentVersion, platform, arch }) {
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest) || cmpVersion(latest, currentVersion) <= 0) return null;
  const assets = rel.assets || [];
  const pick = platform === 'darwin'
    ? assets.find(a => a.name.endsWith('.dmg') && (arch === 'arm64' ? a.name.includes('arm64') : !a.name.includes('arm64')))
    : platform === 'win32' ? assets.find(a => a.name.endsWith('.exe')) : null;
  if (!pick) return null;
  return {
    version: latest, url: pick.browser_download_url, name: pick.name, size: pick.size || 0, sha256: '',
    notes: String(rel.body || '').slice(0, 2000), page: rel.html_url, source: 'github'
  };
}

async function checkForUpdate({ feedUrl, fallbackFeedUrl, currentVersion, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch }) {
  const get = async (url, accept) => {
    if (!url) return null;
    try {
      const res = await fetchImpl(url, { headers: { Accept: accept, 'User-Agent': 'Spektly' }, cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch (_) { return null; }
  };
  const opts = { currentVersion, platform, arch };
  // Either feed may be pointed at either shape, so go by what comes back, not by which URL it came from.
  const read = body => body && (body.tag_name ? fromGithub(body, opts) : fromSiteFeed(body, opts));
  const first = await get(feedUrl, 'application/json');
  const hit = await read(first);
  if (hit) return hit;
  if (first) return null;            // the feed answered; it just has nothing newer for us
  return (await read(await get(fallbackFeedUrl, 'application/vnd.github+json'))) || null;
}

module.exports = { checkForUpdate };
