'use strict';
// v2.2 UI smoke test (license stubbed, test only): splash, setup modal, accounts, guided setup, themes.
//   xvfb-run -a npx electron test/smoke-v22.js <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch22-smoke-'));
app.setPath('userData', userData);
const { LicenseManager } = require('../src/license/manager');
LicenseManager.prototype.status = () => ({ active: true, device: 'smoke', license: { tierName: 'Creator', key: 'CH1-SMOKE', serial: 1, maxDevices: 1 } });
LicenseManager.prototype.revalidate = async () => {};
require('../main.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let win;
  for (let i = 0; i < 50 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
  win.setSize(1280, 820);
  const js = s => win.webContents.executeJavaScript(s);
  const shot = async (n, d = 500) => { await wait(d); fs.writeFileSync(path.join(outDir, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  await new Promise(r => win.webContents.once('did-finish-load', r)).catch(() => {});
  await shot('00-splash', 700);
  await wait(1500);
  await shot('01-setup-welcome');
  for (let i = 2; i <= 5; i++) { await js(`document.querySelector('[data-action="wizNext"]').click()`); await shot(`0${i}-setup`); }
  await js(`document.querySelector('[data-action="wizFinish"][data-to="dashboard"]').click()`); await shot('10-dashboard', 900);
  await js(`document.querySelector('#nav button[data-view="accounts"]').click()`); await shot('11-accounts');
  await js(`document.querySelector('[data-action="assist"][data-pid="tiktok"]').click()`); await shot('12-assist-tiktok');
  await js(`document.querySelector('[data-modal-close]').click()`);
  await js(`document.querySelector('#nav button[data-view="settings"]').click()`); await shot('13-settings');
  for (const t of ['aurora', 'ultraviolet', 'ember', 'daylight', 'midnight']) {
    await js(`document.querySelector('#nav button[data-view="settings"]').click()`); await wait(200);
    await js(`document.querySelector('[data-theme-pick="${t}"]').click()`); await wait(300);
    await js(`document.querySelector('#nav button[data-view="dashboard"]').click()`); await shot('20-theme-' + t);
  }
  await js(`Modal.confirm('Scheduled posts to this account will fail until you connect it again.', { title: 'Disconnect TikTok?', ok: 'Disconnect', danger: true }); 1`);
  await shot('30-confirm-modal');
  const st = await js(`hub.state().then(s => ({ onboarded: s.settings.onboarded, theme: s.settings.theme }))`);
  const dash = await js(`document.body.innerText.includes('—')`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, ...st, emDashOnScreen: dash, consoleErrors: errs }, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack || e) })); app.exit(1); });
