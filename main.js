'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { Engine } = require('./src/engine');
const { LicenseManager } = require('./src/license/manager');
const { deviceFingerprint } = require('./src/license/core');
const { InsightsService } = require('./src/insights/service');
const cleanupMod = require('./src/installer/cleanup');
const { checkForUpdate } = require('./src/installer/updates');
const os = require('os');
const pkg = require('./package.json');

// The app used to be called "Creator Hub". Its data folder is named after the app, so on the first
// run of Spektly copy the old folder over (posts, accounts, license, settings, theme). Runs before
// anything else touches the data folder. The old folder is left in place as a backup.
const LEGACY_NAME = 'Creator Hub';
const DATA_FILE = 'creator-hub-data.json'; // internal file name, kept so nothing has to be renamed
function migrateLegacyData() {
  try {
    const oldDir = path.join(app.getPath('appData'), LEGACY_NAME);
    const newDir = app.getPath('userData');
    if (path.resolve(oldDir) === path.resolve(newDir)) return false;
    if (!fs.existsSync(path.join(oldDir, DATA_FILE)) || fs.existsSync(path.join(newDir, DATA_FILE))) return false;
    const skip = /^(Singleton.*|.*Cache.*|Crashpad|blob_storage|logs|DawnGraphiteCache|DawnWebGPUCache)$/i;
    fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false, filter: src => !skip.test(path.basename(src)) });
    fs.writeFileSync(path.join(newDir, '.migrated-from-creator-hub'), new Date().toISOString());
    return true;
  } catch (e) { console.error('Could not copy Creator Hub data:', e); return false; }
}
const migratedFromLegacy = migrateLegacyData();

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray, store, engine, license, insights, quitting = false, blockerId = null, updateInfo = null;

// ---- at-rest encryption: OS keychain (macOS Keychain / Windows DPAPI) via safeStorage ----
// macOS asks for the login password whenever an app's signature changes, and until Spektly is
// signed with an Apple Developer ID every update has a new ad-hoc signature. So on macOS sign-ins are
// encrypted with the device-bound key below instead of the Keychain (no prompts). Set
// "macKeychain": true in package.json once builds are Developer ID signed. Windows (DPAPI) never prompts.
const useOsKeychain = () => process.platform !== 'darwin' || !!pkg.macKeychain;
function makeBox() {
  return {
    encrypt(s) {
      if (useOsKeychain()) { try { if (safeStorage.isEncryptionAvailable()) return 'ss1:' + safeStorage.encryptString(s).toString('base64'); } catch (_) {} }
      return fallback.encrypt(s);
    },
    decrypt(s) {
      // Older versions stored some values in the Keychain. Reading one may ask once; if the user
      // declines, the value is treated as missing (that account just needs to be connected again).
      if (s.startsWith('ss1:')) { try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch (_) { return '{}'; } }
      return fallback.decrypt(s);
    }
  };
}
// Fallback (e.g. Linux without a keyring): AES-256-GCM with a device-derived key.
const fallback = (() => {
  const key = crypto.createHash('sha256').update('creator-hub-local-v1\0' + deviceFingerprint()).digest();
  return {
    encrypt(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return 'gc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    decrypt(s) {
      const b = Buffer.from(s.replace(/^gc1:/, ''), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    }
  };
})();

function openExternal(url) {
  if (/^(https:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
}

function notify(evt, data) {
  if (evt === 'changed') win?.webContents.send('state-changed');
  if (evt === 'toast') {
    win?.webContents.send('toast', data);
    if (Notification.isSupported() && (!win || !win.isVisible())) new Notification({ title: 'Spektly', body: data }).show();
  }
}

function iconPath() { return path.join(__dirname, 'assets', 'icon.png'); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: 'Spektly', icon: iconPath(), show: false,
    backgroundColor: '#0b1624',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu?.();
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  loadForLicenseState();
  // Show as soon as the first frame is ready, and never leave the app running without a window:
  // ready-to-show can be skipped when macOS launches the app in the background (seen after updates).
  const atLogin = process.platform === 'darwin' && (app.getLoginItemSettings().wasOpenedAsHidden || app.getLoginItemSettings().wasOpenedAtLogin);
  const reveal = () => { if (atLogin) return; if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); if (process.platform === 'darwin') app.focus({ steal: true }); } };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 2500);
  win.on('close', e => {
    if (!quitting && store?.data.settings.keepRunningInBackground && license?.status().active) {
      e.preventDefault(); win.hide();
    }
  });
}

function loadForLicenseState() {
  const active = license.status().active;
  win.loadFile(path.join(__dirname, 'renderer', active ? 'index.html' : 'license.html'));
  if (active) startEngine(); else engine?.stop();
}

function startEngine() {
  if (engine?.timer) return;
  engine.start(30_000);
  if (blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  license.revalidate().then(() => { if (!license.status().active) loadForLicenseState(); });
}

function createTray() {
  try {
    // macOS menu bar: a template image (black + transparent) so it adapts to light and dark menu bars.
    const img = process.platform === 'darwin'
      ? (() => { const t = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png')); t.setTemplateImage(true); return t; })()
      : nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    tray = new Tray(img);
    tray.setToolTip('Spektly: scheduler running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Spektly', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: 'Quit (stops scheduled posting)', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => { win.show(); win.focus(); });
  } catch (_) {}
}

// ---------- IPC ----------
function handle(channel, fn, { licensed = true } = {}) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (licensed && !license.status().active) throw new Error('Spektly is not activated.');
    return fn(...args);
  });
}

function state() {
  return {
    version: pkg.version,
    brand: require('./src/brand.json'),
    update: updateInfo,
    insights: insights.view(),
    posts: store.listPosts(),
    accounts: engine.accountsView(),
    settings: store.data.settings,
    analytics: store.data.analytics,
    log: store.data.log.slice(0, 200),
    license: license.status()
  };
}

function registerIpc() {
  // License (available before activation)
  handle('license:status', () => license.status(), { licensed: false });
  handle('license:eula', () => fs.readFileSync(path.join(__dirname, 'legal', 'EULA.md'), 'utf8'), { licensed: false });
  handle('license:check', key => license.check(key), { licensed: false });
  handle('license:activateOnline', async (key, eula) => { const r = await license.activateOnline(key, { eulaAccepted: eula }); setTimeout(loadForLicenseState, 600); return r; }, { licensed: false });
  handle('license:requestCode', key => license.requestCode(key), { licensed: false });
  handle('license:activateOffline', (key, code, eula) => { const r = license.activateOffline(key, code, { eulaAccepted: eula }); setTimeout(loadForLicenseState, 600); return r; }, { licensed: false });
  handle('license:deactivate', async () => { await license.deactivate(); loadForLicenseState(); });

  handle('app:state', state);
  handle('app:openUrl', url => openExternal(url));

  handle('posts:create', input => {
    const post = store.createPost(input);
    return { post, problems: engine.validatePost(post) };
  });
  handle('posts:update', (id, patch) => {
    const post = store.updatePost(id, patch);
    return { post, problems: engine.validatePost(post) };
  });
  handle('posts:delete', id => store.deletePost(id));
  handle('posts:approve', ids => { for (const id of [].concat(ids)) store.updatePost(id, { status: 'approved' }); });
  handle('posts:reject', id => store.updatePost(id, { status: 'draft' }));
  handle('posts:submit', id => store.updatePost(id, { status: store.data.settings.requireApproval ? 'pending_approval' : 'approved' }));
  handle('posts:publishNow', async id => { store.updatePost(id, { status: 'approved', scheduledAt: new Date().toISOString() }); await engine.publishPost(id); });
  handle('posts:retry', id => engine.retry(id));
  handle('posts:duplicate', id => {
    const p = store.getPost(id);
    return store.createPost({ ...p, scheduledAt: new Date(Date.now() + 864e5).toISOString() });
  });
  handle('posts:validate', id => engine.validatePost(store.getPost(id)));

  handle('media:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('batch:import', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Spektly batch', extensions: ['json'] }] });
    if (r.canceled) return null;
    const file = r.filePaths[0];
    const created = engine.importBatch(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file));
    return created.map(p => ({ id: p.id, title: p.title, problems: engine.validatePost(p) }));
  });

  handle('accounts:save', (pid, values) => engine.saveAccountConfig(pid, values));
  handle('accounts:connect', pid => engine.connect(pid));
  handle('accounts:disconnect', pid => engine.disconnect(pid));

  handle('settings:update', patch => {
    const s = store.updateSettings(patch);
    if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: true });
    return s;
  });
  handle('analytics:refresh', () => engine.refreshAnalytics());

  // ---------- Insights ----------
  handle('insights:saveConfig', cfg => insights.saveConfig(cfg));
  // One Google sign-in: unless the user set their own Insights-only keys, connect through YouTube
  // (which requests every Insights scope) and share the token.
  handle('insights:connect', async () => {
    if (insights.hasOwnClient()) return insights.connect();
    const profile = await engine.connect('youtube');
    await insights.refreshResources().catch(e => { insights.s.lastError = e.message; });
    return { email: profile.email || profile.name };
  });
  handle('onboarding:finish', () => { store.updateSettings({ onboarded: true }); return true; });
  handle('onboarding:restart', () => { store.updateSettings({ onboarded: false }); return true; });
  handle('insights:disconnect', () => insights.disconnect());
  handle('insights:resources', () => insights.refreshResources());
  handle('insights:select', patch => insights.select(patch));
  handle('insights:report', days => insights.report(days));
  handle('insights:refresh', async (days, force) => { await engine.refreshAnalytics().catch(() => {}); return insights.refresh(days, { force }); });
  handle('insights:exportPdf', async (html, suggested) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), suggested || 'Spektly report.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled) return null;
    const off = new BrowserWindow({ show: false, width: 1100, height: 1400, webPreferences: { sandbox: true, javascript: false } });
    try {
      await off.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await off.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { marginType: 'default' } });
      fs.writeFileSync(r.filePath, pdf);
    } finally { off.destroy(); }
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('insights:exportCsv', async (csv, suggested) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), suggested || 'Spektly data.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, csv);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('app:checkUpdate', () => runUpdateCheck());
}

// ---------- Installation hygiene: one copy only ----------
// macOS: offer to move into /Applications on first run (replacing any older copy there),
// then - once per new version - move every other Spektly copy and older installer files to the Trash.
async function ensureSingleInstall() {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Move to Applications', 'Not now'], defaultId: 0, cancelId: 1,
      message: 'Move Spektly to your Applications folder?',
      detail: 'This keeps one copy of Spektly installed and replaces any older version. Your license, posts and settings are kept.'
    });
    if (response === 0) {
      try { if (app.moveToApplicationsFolder({ conflictHandler: () => true })) return true; } // app relaunches from /Applications
      catch (e) { dialog.showErrorBox('Could not move Spektly', e.message); }
    }
  }
  return false;
}

async function cleanupOldCopies() {
  if (!app.isPackaged) return;
  const meta = store.data.install ||= { knownPaths: [], cleanedFor: null };
  const current = process.platform === 'darwin' ? cleanupMod.appBundleOf(process.execPath) : path.dirname(process.execPath);
  if (current && !cleanupMod.isTranslocated(current) && !meta.knownPaths.includes(current)) meta.knownPaths.push(current);
  meta.knownPaths = meta.knownPaths.slice(-20);
  if (meta.cleanedFor === pkg.version) { store.save(); return; }
  const home = os.homedir();
  const dirs = process.platform === 'darwin'
    ? ['/Applications', path.join(home, 'Applications'), path.join(home, 'Downloads'), path.join(home, 'Desktop')]
    : [path.join(home, 'Downloads'), path.join(home, 'Desktop')];
  const knownPaths = process.platform === 'darwin' ? meta.knownPaths : [];
  const { removed } = await cleanupMod.cleanup({
    currentAppPath: process.platform === 'darwin' ? current : null,
    currentVersion: pkg.version, dirs, knownPaths,
    trash: p => shell.trashItem(p),
    log: m => store.addLog('info', m)
  });
  meta.knownPaths = meta.knownPaths.filter(p => p === current || fs.existsSync(p));
  meta.cleanedFor = pkg.version;
  store.save();
  if (removed.length) notify('toast', `Removed ${removed.length} old file${removed.length > 1 ? 's' : ''} (moved to Trash).`);
  removeLegacyWindowsInstall();
}

// Windows: Spektly installs as a new program, so quietly uninstall the old "Creator Hub" program.
// Its data was already copied over and its uninstaller keeps app data (deleteAppDataOnUninstall: false).
function removeLegacyWindowsInstall() {
  if (process.platform !== 'win32') return;
  const meta = store.data.install ||= {};
  if (meta.legacyRemoved) return;
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null;
  const candidates = [base && path.join(base, 'creator-hub', 'Uninstall Creator Hub.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Creator Hub', 'Uninstall Creator Hub.exe')].filter(Boolean);
  const uninstaller = candidates.find(p => fs.existsSync(p));
  meta.legacyRemoved = true;
  store.save();
  if (!uninstaller) return;
  try {
    require('child_process').spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    store.addLog('info', 'Removed the old Creator Hub program (your data was copied to Spektly first).');
  } catch (e) { store.addLog('warn', 'Could not remove the old Creator Hub program: ' + e.message); }
}

// One-time move of values older versions kept in the macOS Keychain to device encryption,
// so the Keychain password prompt never comes back after updates.
function migrateKeychainValues(box) {
  if (useOsKeychain() || store.data.keychainMigrated) return;
  let moved = 0;
  const conv = v => { if (typeof v === 'string' && v.startsWith('ss1:')) { moved++; return box.encrypt(box.decrypt(v)); } return v; };
  for (const a of Object.values(store.data.accounts || {})) for (const k of ['secret', 'secretConfig']) if (a[k]) a[k] = conv(a[k]);
  const ins = store.data.insights;
  if (ins) for (const k of ['secret', 'secretConfig']) if (ins[k]) ins[k] = conv(ins[k]);
  store.data.keychainMigrated = true;
  store.save();
  if (moved) store.addLog('info', `Moved ${moved} saved sign-in value(s) out of the Keychain.`);
}

async function runUpdateCheck() {
  updateInfo = await checkForUpdate({ feedUrl: pkg.updateFeed, currentVersion: pkg.version });
  notify('changed');
  return updateInfo;
}

app.whenReady().then(async () => {
  if (await ensureSingleInstall()) return; // relaunching from /Applications
  const dir = app.getPath('userData');
  store = new Store(dir);
  if (migratedFromLegacy) {
    store.addLog('info', 'Welcome to Spektly. Your posts, accounts, license and settings were carried over from Creator Hub.');
    if (!store.data.settings.theme || store.data.settings.theme === 'midnight') store.updateSettings({ theme: 'spektly' });
  }
  const box = makeBox();
  license = new LicenseManager({ dir, box: fallback, legacyBox: box });
  migrateKeychainValues(box);
  engine = new Engine({ store, box, openExternal, notify });
  insights = new InsightsService({ store, box, openExternal });
  // A YouTube (Google) sign-in also powers Insights, so customers sign in to Google once.
  engine.onConnected = async (pid, secret) => {
    if (pid === 'youtube' && !insights.hasOwnClient() && insights.adoptGoogle(secret)) {
      insights.refreshResources().catch(e => { insights.s.lastError = e.message; store.save(); });
    }
  };
  store.onChange(() => notify('changed'));
  registerIpc();
  createWindow();
  createTray();
  app.on('activate', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  setTimeout(() => cleanupOldCopies().catch(e => store.addLog('warn', 'Cleanup: ' + e.message)), 4000);
  setTimeout(() => runUpdateCheck(), 8000);
  setInterval(() => runUpdateCheck(), 6 * 3600e3);
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; engine?.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
