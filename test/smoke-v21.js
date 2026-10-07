'use strict';
// v2.1 UI smoke test (license stubbed — test only): first-run wizard, Accounts, Insights connect.
//   CH_GOOGLE_CLIENT_ID=x CH_GOOGLE_CLIENT_SECRET=y xvfb-run -a npx electron test/smoke-v21.js <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch21-smoke-'));
app.setPath('userData', userData);
const { LicenseManager } = require('../src/license/manager');
LicenseManager.prototype.status = () => ({ active: true, device: 'smoke', license: { tierName: 'Creator', key: 'CH1-SMOKE', serial: 1, maxDevices: 1 } });
LicenseManager.prototype.revalidate = async () => {};
require('../main.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1280, 820);
  const js = s => win.webContents.executeJavaScript(s);
  const shot = async n => { await wait(600); fs.writeFileSync(path.join(outDir, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  await shot('w0-welcome');
  for (let i = 1; i <= 3; i++) { await js(`document.querySelector('[data-action="wizNext"]').click()`); await shot('w' + i); }
  await js(`document.querySelector('[data-action="wizFinish"][data-to="dashboard"]').click()`); await shot('after-dashboard');
  await js(`document.querySelector('#nav button[data-view="accounts"]').click()`); await shot('accounts');
  await js(`document.querySelector('#nav button[data-view="insights"]').click()`); await shot('insights');
  const onboarded = await js(`hub.state().then(s => s.settings.onboarded)`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, onboarded, consoleErrors: errs }, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack || e) })); app.exit(1); });
