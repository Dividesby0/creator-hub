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

// ---- seed v2 Insights cache with realistic sample data ----
{
  const { rangeFor, compare } = require('../src/insights/ranges');
  const r = rangeFor(28);
  const file = path.join(userData, 'creator-hub-data.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const days = []; for (let i = 0; i < 28; i++) days.push(new Date(Date.parse(r.start) + i * 864e5).toISOString().slice(0, 10));
  const wave = (b, a, i, k = 1) => Math.round(b + a * Math.sin(i / 3.2 * k) + i * b * 0.02);
  const fakeSecret = null; // not connected via OAuth in the smoke test; cache is shown directly
  data.analytics.account = {
    tiktok: [{ at: new Date(Date.parse(r.prevEnd)).toISOString(), followers: 1240 }, { at: new Date().toISOString(), followers: 1810 }],
    instagram: [{ at: new Date(Date.parse(r.prevEnd)).toISOString(), followers: 640 }, { at: new Date().toISOString(), followers: 702 }],
    x: [{ at: new Date(Date.parse(r.prevEnd)).toISOString(), followers: 310 }, { at: new Date().toISOString(), followers: 298 }]
  };
  data.insights = { config: {}, secretConfig: '', secret: '', selections: { ga4Property: '1', gscSite: 'sc-domain:decrypt443.com', gbpLocation: 'locations/1' },
    resources: { youtube: { id: 'UC1', name: 'Decrypt443', subscribers: 2140 }, ga4: [{ id: '1', name: 'decrypt443.com (Decrypt443)' }], gsc: [{ id: 'sc-domain:decrypt443.com', name: 'Domain: decrypt443.com' }], gbp: [{ id: 'locations/1', name: 'Decrypt443 Studio' }], errors: {} },
    lastError: null,
    cache: { '28': { range: r, fetchedAt: new Date().toISOString(), google: { range: r, resources: { youtube: { subscribers: 2140 } }, sources: {
      youtube: { ok: true, totals: compare({ views: 48210, watchHours: 1932.4, avgViewDuration: 214, netSubscribers: 386, likes: 2140, comments: 388, shares: 291, engagementRate: 0.0585 }, { views: 31950, watchHours: 1310, avgViewDuration: 198, netSubscribers: 210, likes: 1500, comments: 260, shares: 180, engagementRate: 0.061 }),
        series: days.map((d, i) => ({ date: d, views: wave(1500, 500, i), watchHours: wave(60, 20, i, 1.3), subscribers: wave(12, 6, i) })),
        topVideos: [['That call from “mom” was AI', 12840, 512, 61], ['Remove yourself from data brokers tonight', 8410, 301, 54], ['Prompt injection explained in 60s', 6120, 188, 72], ['Is your trading bot leaking keys?', 4380, 160, 48]].map(([title, views, w, p], i) => ({ id: 'v' + i, title, views, watchHours: w, avgViewPct: p, likes: Math.round(views * 0.045), subscribers: Math.round(views / 80), url: 'https://youtube.com' })),
        trafficSources: [['Shorts feed', 19800], ['YouTube search', 12100], ['Suggested videos', 8900], ['Browse / Home', 5100], ['External sites', 2310]].map(([source, views]) => ({ source, views })) },
      ga4: { ok: true, totals: compare({ activeUsers: 6120, newUsers: 5290, sessions: 8410, screenPageViews: 15230, engagementRate: 0.62, averageSessionDuration: 96 }, { activeUsers: 4980, newUsers: 4400, sessions: 6900, screenPageViews: 12100, engagementRate: 0.58, averageSessionDuration: 88 }),
        series: days.map((d, i) => ({ date: d, users: wave(210, 60, i), sessions: wave(290, 80, i), views: wave(540, 140, i) })),
        topPages: [['/ai-voice-clone-scams', 3120, 2210], ['/data-broker-opt-out', 2410, 1880], ['/', 1980, 1500]].map(([page, views, users]) => ({ page, views, users })),
        channels: [['Organic Social', 3400], ['Organic Search', 2810], ['Direct', 1500], ['Referral', 700]].map(([channel, sessions]) => ({ channel, sessions })) },
      gsc: { ok: true, totals: compare({ clicks: 1420, impressions: 61200, ctr: 0.0232, position: 14.6 }, { clicks: 980, impressions: 44100, ctr: 0.0222, position: 17.9 }),
        series: days.map((d, i) => ({ date: d, clicks: wave(50, 15, i), impressions: wave(2200, 500, i), position: 14 })),
        topQueries: [['ai voice clone scam', 210, 9800, 0.021, 6.4], ['how to opt out of data brokers', 180, 7200, 0.025, 8.1], ['prompt injection example', 95, 4100, 0.023, 11.2]].map(([query, clicks, impressions, ctr, position]) => ({ query, clicks, impressions, ctr, position })),
        topPages: [['https://decrypt443.com/ai-voice-clone-scams', 520, 21000]].map(([page, clicks, impressions]) => ({ page, clicks, impressions })) },
      gbp: { ok: false, error: 'Business Profile API access not approved yet (Google requires an access request), or this Google account manages no business locations.' }
    } } } } };
  fs.writeFileSync(file, JSON.stringify(data));
}

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
  for (const v of ['insights', 'dashboard', 'compose', 'queue', 'calendar', 'approvals', 'analytics', 'accounts', 'settings']) {
    await js(`document.querySelector('#nav button[data-view="${v}"]').click()`);
    await shot(win, 'view-' + v);
  }
  // Insights tabs
  await js(`document.querySelector('#nav button[data-view="insights"]').click()`);
  for (const t of ['youtube', 'website', 'search', 'business', 'social']) {
    await js(`document.querySelector('[data-ins-tab="${t}"]').click()`);
    await shot(win, 'insights-' + t);
  }
  // PDF + CSV report generation
  await js(`document.querySelector('[data-ins-tab="overview"]').click()`);
  const html = await js(`Insights._test.pdf()`);
  const csvText = await js(`Insights._test.csv()`);
  fs.writeFileSync(path.join(outDir, 'report.csv'), csvText);
  const off = new BrowserWindow({ show: false, width: 1100, height: 1400, webPreferences: { sandbox: true, javascript: false } });
  await off.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  fs.writeFileSync(path.join(outDir, 'report.pdf'), await off.webContents.printToPDF({ printBackground: true, pageSize: 'Letter' }));
  off.destroy();
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
