'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Tray, Menu, nativeImage, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { Engine } = require('./src/engine');
const { LicenseManager } = require('./src/license/manager');
const { deviceFingerprint } = require('./src/license/core');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray, store, engine, license, quitting = false, blockerId = null;

// ---- at-rest encryption: OS keychain (macOS Keychain / Windows DPAPI) via safeStorage ----
function makeBox() {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypt: s => 'ss1:' + safeStorage.encryptString(s).toString('base64'),
      decrypt: s => s.startsWith('ss1:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : fallback.decrypt(s)
    };
  }
  return fallback;
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
    tray.setToolTip('Creator Hub — scheduler running');
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
}

app.whenReady().then(() => {
  const dir = app.getPath('userData');
  store = new Store(dir);
  const box = makeBox();
  license = new LicenseManager({ dir, box });
  engine = new Engine({ store, box, openExternal, notify });
  store.onChange(() => notify('changed'));
  registerIpc();
  createWindow();
  createTray();
  app.on('activate', () => { win.show(); });
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; engine?.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
