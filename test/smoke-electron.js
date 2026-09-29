'use strict';
// Electron smoke test: activates through the real UI, then screenshots every view.
//   xvfb-run -a npx electron test/smoke-electron.js <outDir> <licenseKey> <activationCode>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const [outDir, key, activation] = process.argv.slice(-3);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-smoke-'));
app.setPath('userData', userData);

// seed a few posts so the views have something to show
const now = Date.now();
const iso = h => new Date(now + h * 3600e3).toISOString();
fs.writeFileSync(path.join(userData, 'creator-hub-data.json'), JSON.stringify({
  posts: [
    { id: 'p1', title: 'Is that really your mom calling? (AI voice clones)', caption: 'Scammers need 3 seconds of audio to clone a voice. Here is the 10-second family safe-word trick that stops them cold.', mediaType: 'none', mediaPath: '', platforms: ['youtube', 'tiktok', 'instagram'], overrides: {}, aiGenerated: true, scheduledAt: iso(20), status: 'pending_approval', results: {}, createdAt: iso(-1), updatedAt: iso(-1) },
    { id: 'p2', title: 'Remove yourself from 5 data brokers tonight', caption: 'Data brokers sell your address and phone for $1. Opt out of these five first.', mediaType: 'none', mediaPath: '', platforms: ['threads', 'x'], overrides: {}, aiGenerated: false, scheduledAt: iso(44), status: 'approved', results: {}, createdAt: iso(-2), updatedAt: iso(-2) },
    { id: 'p3', title: 'Prompt injection in 60 seconds', caption: 'Your AI agent reads a web page. The page tells it to email your files. Here is how that works.', mediaType: 'none', mediaPath: '', platforms: ['threads', 'x', 'facebook'], overrides: {}, aiGenerated: false, scheduledAt: iso(-30), status: 'published', results: { threads: { status: 'published', url: 'https://threads.net', remoteId: '1', attempts: 1 }, x: { status: 'published', url: 'https://x.com', remoteId: '2', attempts: 1, cost: 0.015 }, facebook: { status: 'published', remoteId: '3', url: 'https://facebook.com', attempts: 1 } }, createdAt: iso(-40), updatedAt: iso(-30) },
    { id: 'p4', title: 'Agentic trading: securing your API keys', caption: 'If your trading agent leaks its keys, someone else trades your account.', mediaType: 'none', mediaPath: '', platforms: ['x', 'threads'], overrides: {}, aiGenerated: false, scheduledAt: iso(-3), status: 'partial_failed', results: { threads: { status: 'published', url: 'https://threads.net', remoteId: '4', attempts: 1 }, x: { status: 'failed', error: 'X API error 402: credits exhausted — add credits in the X developer console', attempts: 3 } }, createdAt: iso(-5), updatedAt: iso(-3) }
  ],
  analytics: { account: {}, posts: { p3: { threads: { views: 1840, likes: 96, comments: 14, shares: 9 }, x: { views: 920, likes: 31, comments: 4, shares: 6 } } } },
  settings: { requireApproval: true, keepRunningInBackground: false }
}));

require('../main.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function shot(win, name) {
  await wait(700);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1360, 900);
  await shot(win, '01-license');
  const js = s => win.webContents.executeJavaScript(s);
  await js(`document.querySelector('#accept').checked = true;
    const k = document.querySelector('#key'); k.value = ${JSON.stringify(key)}; k.dispatchEvent(new Event('input'));
    document.querySelector('details').open = true;
    document.querySelector('#act').value = ${JSON.stringify(activation)};`);
  await wait(600);
  await shot(win, '02-license-filled');
  await js(`document.querySelector('#offline').click()`);
  await wait(2500);
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  for (const v of ['dashboard', 'compose', 'queue', 'calendar', 'approvals', 'analytics', 'accounts', 'settings']) {
    await js(`document.querySelector('#nav button[data-view="${v}"]').click()`);
    await shot(win, 'view-' + v);
  }
  // compose interactions: toggle platforms and type an over-length caption for X
  await js(`document.querySelector('#nav button[data-view="compose"]').click()`);
  await wait(300);
  await js(`document.querySelector('[data-pid="x"]').click()`);
  await wait(300);
  await js(`document.querySelector('[data-pid="threads"]').click()`);
  await wait(300);
  await js(`const c=document.querySelector('#c-caption'); c.value='AI voice clone scams are exploding. '.repeat(9)+' https://example.com'; c.dispatchEvent(new Event('input',{bubbles:true}));`);
  await shot(win, 'view-compose-filled');
  const text = await js(`document.body.innerText.slice(0,200)`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, consoleErrors: errs, sample: text }, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack || e) })); app.exit(1); });
