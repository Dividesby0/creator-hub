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

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray, store, engine, license, insights, quitting = false, blockerId = null, updateInfo = null;

// ---- at-rest encryption: OS keychain (macOS Keychain / Windows DPAPI) via safeStorage ----
function makeBox() {
  // Platform tokens: prefer the OS keychain, but never let a keychain problem (denied prompt,
  // forgotten keychain password, signature change after an update) break the app.
  return {
    encrypt(s) {
      try { if (safeStorage.isEncryptionAvailable()) return 'ss1:' + safeStorage.encryptString(s).toString('base64'); } catch (_) {}
      return fallback.encrypt(s);
    },
    decrypt(s) {
      if (s.startsWith('ss1:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
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
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
}

function notify(evt, data) {
  if (evt === 'changed') win?.webContents.send('state-changed');
  if (evt === 'toast') {
    win?.webContents.send('toast', data);
    if (Notification.isSupported() && (!win || !win.isVisible())) new Notification({ title: 'Creator Hub', body: data }).show();
  }
}

function iconPath() { return path.join(__dirname, 'assets', 'icon.png'); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: 'Creator Hub', icon: iconPath(), show: false,
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu?.();
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  loadForLicenseState();
  win.once('ready-to-show', () => win.show());
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
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Creator Hub: scheduler running');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Creator Hub', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: 'Quit (stops scheduled posting)', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => { win.show(); win.focus(); });
  } catch (_) {}
}

// ---------- IPC ----------
function handle(channel, fn, { licensed = true } = {}) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (licensed && !license.status().active) throw new Error('Creator Hub is not activated.');
    return fn(...args);
  });
}

function state() {
  return {
    version: pkg.version,
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
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Creator Hub batch', extensions: ['json'] }] });
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
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), suggested || 'Creator Hub report.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
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
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), suggested || 'Creator Hub data.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, csv);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle('app:checkUpdate', () => runUpdateCheck());
}

// ---------- Installation hygiene: one copy only ----------
// macOS: offer to move into /Applications on first run (replacing any older copy there),
// then - once per new version - move every other Creator Hub copy and older installer files to the Trash.
async function ensureSingleInstall() {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Move to Applications', 'Not now'], defaultId: 0, cancelId: 1,
      message: 'Move Creator Hub to your Applications folder?',
      detail: 'This keeps one copy of Creator Hub installed and replaces any older version. Your license, posts and settings are kept.'
    });
    if (response === 0) {
      try { if (app.moveToApplicationsFolder({ conflictHandler: () => true })) return true; } // app relaunches from /Applications
      catch (e) { dialog.showErrorBox('Could not move Creator Hub', e.message); }
    }
  }
  return false;
}

async function cleanupOldCopies() {
  if (!app.isPackaged) return;
  const meta = store.data.install ||= { knownPaths: [], cleanedFor: null };
  const current = process.platform === 'darwin' ? cleanupMod.appBundleOf(process.execPath) : path.dirname(process.execPath);
  if (current && !meta.knownPaths.includes(current)) meta.knownPaths.push(current);
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
  if (removed.length) notify('toast', `Removed ${removed.length} old Creator Hub file${removed.length > 1 ? 's' : ''} (moved to Trash).`);
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
  const box = makeBox();
  license = new LicenseManager({ dir, box: fallback, legacyBox: box });
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
  app.on('activate', () => { win.show(); });
  setTimeout(() => cleanupOldCopies().catch(e => store.addLog('warn', 'Cleanup: ' + e.message)), 4000);
  setTimeout(() => runUpdateCheck(), 8000);
  setInterval(() => runUpdateCheck(), 6 * 3600e3);
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; engine?.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
