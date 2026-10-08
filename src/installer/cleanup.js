'use strict';
// Finds and removes stale copies of Spektly (and of Creator Hub, its old name) so only the installed version remains.
// Pure logic with injected fs/trash so it can be unit-tested on any OS.
const nodeFs = require('fs');
const path = require('path');

const BUNDLE_ID = 'com.spektly.desktop';
// Before the rename the app was "Creator Hub". Any copy of it is always stale.
const LEGACY_BUNDLE_IDS = ['com.creatorhub.desktop'];
const APP_NAME_RE = /^(?:spektly|creator hub).*\.app$/i;
const INSTALLER_RE = /^(spektly|creator[ .]hub)[- .](?:setup[ .])?(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?\.(dmg|zip|exe)$/i;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

function readBundleInfo(appPath, fs = nodeFs) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const get = key => (plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)) || [])[1] || null;
    return { bundleId: get('CFBundleIdentifier'), version: get('CFBundleShortVersionString') };
  } catch (_) { return null; }
}

// The .app bundle that contains the running executable (macOS), e.g. /Applications/Spektly.app
function appBundleOf(exePath) {
  const i = exePath.indexOf('.app/Contents/');
  return i < 0 ? null : exePath.slice(0, i + 4);
}

/**
 * @returns {{ apps: {path, version}[], installers: {path, version}[] }}
 */
function findStale({ currentAppPath, currentVersion, dirs, knownPaths = [], fs = nodeFs, bundleId = BUNDLE_ID, legacyBundleIds = LEGACY_BUNDLE_IDS }) {
  const current = currentAppPath ? path.resolve(currentAppPath) : null;
  const seen = new Set();
  const apps = [], installers = [];

  const consider = p => {
    const abs = path.resolve(p);
    if (seen.has(abs) || abs === current || abs.startsWith('/Volumes/')) return;
    seen.add(abs);
    const info = readBundleInfo(abs, fs);
    if (info && (info.bundleId === bundleId || legacyBundleIds.includes(info.bundleId))) apps.push({ path: abs, version: info.version });
  };

  for (const p of knownPaths) if (p && fs.existsSync(p)) consider(p);
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; } // folder missing or permission denied
    for (const name of entries) {
      const full = path.join(dir, name);
      if (APP_NAME_RE.test(name)) consider(full);
      const m = name.match(INSTALLER_RE);
      const legacy = m && !/^spektly$/i.test(m[1]);
      if (m && (legacy || (currentVersion && cmpVersion(m[2], currentVersion) < 0))) installers.push({ path: full, version: m[2] });
    }
  }
  return { apps, installers };
}

/**
 * Moves stale copies to the Trash (recoverable). `trash` must return a Promise.
 */
async function cleanup(opts) {
  const { trash, log = () => {} } = opts;
  const { apps, installers } = findStale(opts);
  const removed = [], failed = [];
  for (const item of [...apps, ...installers]) {
    try { await trash(item.path); removed.push(item); log(`Moved old copy to Trash: ${item.path}`); }
    catch (e) { failed.push({ ...item, error: e.message }); log(`Could not remove ${item.path}: ${e.message}`); }
  }
  return { removed, failed };
}

module.exports = { BUNDLE_ID, LEGACY_BUNDLE_IDS, cmpVersion, readBundleInfo, appBundleOf, findStale, cleanup, INSTALLER_RE };
