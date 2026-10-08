'use strict';
// Checks the release feed for a newer version. Fails silently (offline, private repo, rate-limited).
const { cmpVersion } = require('./cleanup');

async function checkForUpdate({ feedUrl, currentVersion, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch }) {
  if (!feedUrl) return null;
  try {
    const res = await fetchImpl(feedUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Spektly' } });
    if (!res.ok) return null;
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest) || cmpVersion(latest, currentVersion) <= 0) return null;
    const assets = rel.assets || [];
    const pick = platform === 'darwin'
      ? assets.find(a => a.name.endsWith('.dmg') && (arch === 'arm64' ? a.name.includes('arm64') : !a.name.includes('arm64')))
      : platform === 'win32' ? assets.find(a => a.name.endsWith('.exe')) : null;
    return { version: latest, url: pick?.browser_download_url || rel.html_url, notes: String(rel.body || '').slice(0, 2000), page: rel.html_url };
  } catch (_) { return null; }
}

module.exports = { checkForUpdate };
