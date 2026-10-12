'use strict';
// End-to-end: the in-app updater. Serves a real file over a local server, drives the banner
// through Download -> progress -> Install, and checks a tampered file is refused.
//   xvfb-run -a npx electron --no-sandbox test/smoke-update.js <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-upd-'));
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'creator-hub-data.json'), JSON.stringify({
  settings: { onboarded: true, theme: 'spektly' }, accounts: {}, posts: [], analytics: { account: {}, posts: {} } }));

const BODY = Buffer.alloc(3 * 1024 * 1024, 7);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');
let serveBad = false;
// Dribbled out in chunks so the progress bar has something to show, as a real download would.
const srv = http.createServer(async (req, res) => {
  res.setHeader('content-length', String(BODY.length));
  const body = serveBad ? Buffer.alloc(BODY.length, 9) : BODY;
  const step = Math.ceil(body.length / 12);
  for (let o = 0; o < body.length; o += step) {
    res.write(body.subarray(o, o + step));
    await new Promise(r => setTimeout(r, 120));
  }
  res.end();
});

const { LicenseManager } = require('../src/license/manager');
LicenseManager.prototype.status = () => ({ active: true, device: 'smoke', server: true, license: { tierName: 'Creator', plan: 'creator', subscription: true, until: new Date(Date.now() + 9e8).toISOString(), key: 'K', maxDevices: 2 } });
LicenseManager.prototype.revalidate = async () => {};
const { Engine } = require('../src/engine');
Engine.prototype.start = function () {};
// Pretend a newer version exists, served from our local stand-in for spektly.com.
const updates = require('../src/installer/updates');
let PORT = 0;
updates.checkForUpdate = async () => ({ version: '9.9.9', url: `https://127.0.0.1:${PORT}/Spektly-mac-arm64.dmg`,
  name: 'Spektly-mac-arm64.dmg', size: BODY.length, sha256: SHA, notes: 'n', page: 'p', source: 'site' });
// The downloader insists on https; point its fetch at the local http server instead.
const dl = require('../src/installer/download');
const realDownload = dl.downloadUpdate;
dl.downloadUpdate = opts => realDownload({ ...opts, url: opts.url.replace(`https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`).replace(/^http:/, 'https:'),
  fetchImpl: u => fetch(String(u).replace('https://', 'http://')) });
require('../main.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); PORT = srv.address().port;
  let win; for (let i = 0; i < 60 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
  const js = s => win.webContents.executeJavaScript(s);
  const shot = async n => { fs.writeFileSync(path.join(outDir, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  for (let i = 0; i < 60 && !(await js(`document.querySelector('#splash')?.classList.contains('gone') || false`)); i++) await wait(200);
  const r = {};
  for (let i = 0; i < 40 && !(await js(`!document.querySelector('#updateBanner')?.hidden`)); i++) await wait(500);
  r.offered = await js(`document.querySelector('#updateBanner').innerText`);
  await shot('60-offered');
  await js(`document.querySelector('[data-action="downloadUpdate"]').click()`);
  await wait(700); r.during = await js(`document.querySelector('#updateBanner').innerText`);
  await shot('61-downloading');
  for (let i = 0; i < 60 && !/ready to install/i.test(await js(`document.querySelector('#updateBanner').innerText`)); i++) await wait(400);
  r.ready = await js(`document.querySelector('#updateBanner').innerText`);
  await shot('62-ready');
  const f = path.join(userData, 'updates', 'Spektly-mac-arm64.dmg');
  r.fileWritten = fs.existsSync(f) && fs.statSync(f).size === BODY.length;
  r.hashMatches = r.fileWritten && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === SHA;
  // a tampered download must be refused and deleted
  fs.rmSync(path.join(userData, 'updates'), { recursive: true, force: true });
  serveBad = true;
  await js(`window.__s=null`);
  await js(`(async()=>{ await hub.update.download(); })()`); await wait(4000);
  r.tampered = await js(`document.querySelector('#updateBanner').innerText`);
  r.tamperedFileGone = !fs.existsSync(f);
  await shot('63-tampered');
  r.ok = /Download it/i.test(r.offered) && /Downloading/i.test(r.during) && /ready to install/i.test(r.ready)
       && r.fileWritten && r.hashMatches && /integrity check/i.test(r.tampered) && r.tamperedFileGone;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(r, null, 2));
  srv.close(); app.exit(r.ok ? 0 : 1);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ error: String(e.stack || e) })); app.exit(1); });
