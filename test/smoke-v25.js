'use strict';
// v2.5 UI smoke test (activation screen + Dusk/Dawn look) with realistic seeded data (license stubbed, test only):
// dashboard channel board, accounts, compose tiles + meters, queue, calendar, approvals, ivory theme.
//   xvfb-run -a npx electron test/smoke-v25.js <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sp25-smoke-'));
app.setPath('userData', userData);

const at = (dayOffset, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };
const post = (id, title, platforms, when, status, extra = {}) => ({ id, title, caption: title + '. Full caption text for this post.', mediaType: 'none', mediaPath: '', publicMediaUrl: '', platforms, overrides: {}, aiGenerated: false, scheduledAt: when, status, results: {}, createdAt: at(-3, 9), updatedAt: at(-3, 9), ...extra });
fs.writeFileSync(path.join(userData, 'creator-hub-data.json'), JSON.stringify({
  settings: { onboarded: true, theme: 'spektly', requireApproval: true, keepRunningInBackground: false, analyticsIntervalHours: 6 },
  accounts: {
    youtube: { config: {}, secret: 'x:e30=', profile: { name: 'Decrypt443' }, connectedAt: at(-2, 10) },
    threads: { config: {}, secret: 'x:e30=', profile: { name: '@decrypt443' }, connectedAt: at(-2, 10) },
    x: { config: {}, secret: 'x:e30=', profile: { name: '@decrypt443' }, connectedAt: at(-2, 10) },
    instagram: { config: {}, lastError: 'Instagram API error 400: {"error":{"message":"Invalid OAuth access token - Cannot parse access token","type":"OAuthException","code":190}}' }
  },
  posts: [
    post('p1', 'Is that really your mom calling? AI voice clones', ['youtube', 'threads', 'x'], at(0, 18), 'approved'),
    post('p2', 'Remove yourself from 5 data brokers tonight', ['threads', 'x'], at(1, 9, 30), 'pending_approval'),
    post('p3', 'Prompt injection in 60 seconds', ['youtube'], at(2, 12), 'approved'),
    post('p4', 'The 10-second family safe word', ['x', 'threads', 'tiktok'], at(4, 17), 'draft'),
    post('p5', 'Fake QR codes on parking meters', ['youtube', 'x'], at(5, 8), 'approved'),
    post('p6', 'Agentic trading: securing your API keys', ['x', 'threads'], at(0, 7), 'partial_failed', {
      results: { threads: { status: 'published', url: 'https://threads.net', attempts: 1 }, x: { status: 'failed', error: 'X API error 402: {"title":"CreditsDepleted"}', attempts: 3 } } })
  ],
  analytics: { account: {}, posts: {} }
}));

const { LicenseManager } = require('../src/license/manager');
let ACTIVE = false;
LicenseManager.prototype.status = () => ACTIVE ? ({ active: true, device: 'smoke', server: true, license: { tierName: 'Creator', plan: 'creator', subscription: true, until: new Date(Date.now() + 9 * 864e5).toISOString(), key: 'PLAN…0001', serial: 'AB12CD34', maxDevices: 2 } }) : ({ active: false, device: '3f2c9e0d1a2b4c5d6e7f8091a2b3c4d5', server: true });
LicenseManager.prototype.revalidate = async () => {};
// Keep the smoke run offline: no scheduler ticks or analytics calls.
const { Engine } = require('../src/engine');
Engine.prototype.start = function () {};
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
  const checks = {};
  await wait(1200);
  checks.licenseTitle = await js(`document.title`);
  checks.plansLink = await js(`document.querySelector('a[href="https://spektly.com/#plans"]')?.textContent`);
  await js(`document.querySelector('#key').value = 'not a key'; document.querySelector('#key').dispatchEvent(new Event('input'))`); await wait(600);
  checks.keyHint = await js(`document.querySelector('#keyInfo').textContent`);
  await shot('50-activate');
  ACTIVE = true;
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  for (let i = 0; i < 60 && !(await js(`document.querySelector('#splash')?.classList.contains('gone') || false`)); i++) await wait(200);
  await wait(800);
  const nav = v => js(`document.querySelector('#nav button[data-view="${v}"]').click()`);
  await nav('dashboard'); await shot('51-dashboard-dusk');
  checks.h1Font = await js(`getComputedStyle(document.querySelector('h1')).fontFamily`);
  await nav('compose'); await shot('52-compose-dusk');
  await nav('settings'); await shot('53-settings-plan');
  checks.planRow = await js(`[...document.querySelectorAll('td')].map(t => t.textContent).join('|')`);
  await js(`document.querySelector('[data-theme-pick="daylight"]').click()`); await wait(300);
  await nav('dashboard'); await shot('54-dashboard-dawn');
  await nav('accounts'); await shot('55-accounts-dawn');
  checks.emDash = await js(`document.body.innerText.includes('—')`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, checks, consoleErrors: errs }, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack || e) })); app.exit(1); });
