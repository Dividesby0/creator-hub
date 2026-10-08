'use strict';
// v2.4 UI smoke test with realistic seeded data (license stubbed, test only):
// dashboard channel board, accounts, compose tiles + meters, queue, calendar, approvals, ivory theme.
//   xvfb-run -a npx electron test/smoke-v24.js <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sp24-smoke-'));
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
LicenseManager.prototype.status = () => ({ active: true, device: 'smoke', license: { tierName: 'Creator', key: 'CH1-SMOKE', serial: 1, maxDevices: 1 } });
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
  for (let i = 0; i < 60 && !(await js(`document.querySelector('#splash')?.classList.contains('gone') || false`)); i++) await wait(200);
  await wait(800);
  const checks = {};
  const nav = v => js(`document.querySelector('#nav button[data-view="${v}"]').click()`);
  await nav('dashboard'); await shot('40-dashboard');
  checks.boardLanes = await js(`document.querySelectorAll('.lane').length`);
  checks.boardSlots = await js(`document.querySelectorAll('.slot').length`);
  checks.attentionFriendly = await js(`(document.querySelector('.attention .issue span')||{}).textContent`);
  checks.headline = await js(`document.querySelector('h1').textContent`);
  await js(`document.querySelector('.slot[data-id="p3"]').click()`); await wait(300);
  checks.slotOpensEditor = await js(`document.querySelector('#c-title')?.value`);
  await nav('accounts'); await shot('41-accounts');
  checks.accountRows = await js(`document.querySelectorAll('.chan').length`);
  checks.accountMarks = await js(`document.querySelectorAll('.chan .pmark svg path').length`);
  checks.instagramIssue = await js(`(document.querySelector('.chan .issue span')||{}).textContent`);
  checks.googleButton = await js(`!!document.querySelector('.gbtn')`);
  await js(`document.querySelector('.chan .issue summary').click()`); await shot('42-accounts-details');
  await js(`editing = null`); await nav('compose'); await wait(300);
  for (const pid of ['youtube', 'x', 'threads']) { await js(`document.querySelector('.pp[data-pid="${pid}"]').click()`); await wait(150); }
  await js(`(() => { const c = document.querySelector('#c-caption'); c.value = 'Scammers need three seconds of your voice. '.repeat(8); c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await shot('43-compose');
  checks.composeSelected = await js(`[...document.querySelectorAll('.pp.on')].map(e => e.dataset.pid)`);
  checks.xMeter = await js(`document.querySelector('[data-meter="x"]').textContent`);
  checks.overWarning = await js(`(document.querySelector('#c-counter .over')||{}).textContent`);
  await nav('queue'); await shot('44-queue');
  await nav('calendar'); await shot('45-calendar');
  await nav('approvals'); await shot('46-approvals');
  await nav('settings'); await wait(200); await js(`document.querySelector('[data-theme-pick="ivory"]').click()`); await wait(300);
  await nav('dashboard'); await shot('47-dashboard-ivory');
  await nav('accounts'); await shot('48-accounts-ivory');
  checks.emDash = await js(`document.body.innerText.includes('—')`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, checks, consoleErrors: errs }, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack || e) })); app.exit(1); });
