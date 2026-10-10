'use strict';
// Live check of the in-app TikTok sign-in window (real tiktok.com, no credentials entered):
//   xvfb-run -a npx electron test/smoke-signin.js <outDir>
const { app, BrowserWindow, BaseWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const outDir = process.argv[process.argv.length - 1];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-signin-'));
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'creator-hub-data.json'), JSON.stringify({
  settings: { onboarded: true, theme: 'spektly' },
  accounts: { tiktok: { config: { clientKey: 'decrypt443' } } }, posts: [], analytics: { account: {}, posts: {} } }));
const { LicenseManager } = require('../src/license/manager');
LicenseManager.prototype.status = () => ({ active: true, device: 'smoke', license: { tierName: 'Creator', key: 'CH1-SMOKE', serial: 1, maxDevices: 1 } });
LicenseManager.prototype.revalidate = async () => {};
const { Engine } = require('../src/engine'); Engine.prototype.start = function () {};
require('../main.js');
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let win; for (let i = 0; i < 50 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
  const js = s => win.webContents.executeJavaScript(s);
  for (let i = 0; i < 60 && !(await js(`document.querySelector('#splash')?.classList.contains('gone') || false`)); i++) await wait(200);
  await js(`document.querySelector('#nav button[data-view="accounts"]').click()`); await wait(500);
  const clicked = await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => /Connect TikTok/.test(b.textContent)); if (b) b.click(); return !!b; })()`);
  let signInWin; for (let i = 0; i < 40 && !(signInWin = BaseWindow.getAllWindows().find(w => w.__view)); i++) await wait(250);
  const signIn = signInWin && { webContents: signInWin.__view.webContents, getTitle: () => signInWin.getTitle(), getParentWindow: () => signInWin.getParentWindow(), isDestroyed: () => signInWin.isDestroyed(), close: () => signInWin.close() };
  const r = { clicked, windowOpened: !!signIn };
  if (signIn) {
    await wait(9000);
    r.title = signIn.getTitle(); r.url = signIn.webContents.getURL();
    r.clientKey = new URL(r.url).searchParams.get('client_key');
    r.text = (await signIn.webContents.executeJavaScript('document.body.innerText').catch(e => String(e))).slice(0, 600);
    fs.writeFileSync(path.join(outDir, 'signin.png'), (await signIn.webContents.capturePage()).toPNG());
    r.barText = await signInWin.contentView.children[0].webContents.executeJavaScript('document.body.innerText').catch(() => 'js-off');
    r.parent = !!signIn.getParentWindow();
    fs.writeFileSync(path.join(outDir, 'bar.png'), (await signInWin.contentView.children[0].webContents.capturePage()).toPNG());
    if (process.env.TRY_BROWSER) {
      const { shell } = require('electron'); shell.openExternal = async u => { r.handedTo = u; };
      await signInWin.contentView.children[0].webContents.executeJavaScript('document.querySelector("a").click()');
      await wait(1500);
      r.closedAfterHandoff = signInWin.isDestroyed();
      r.issueAfterHandoff = await js(`(document.querySelector('.chan .issue span')||{}).textContent || ''`);
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(r, null, 2)); app.exit(0); return;
    }
    // Simulate TikTok sending the browser back to Spektly (wrong state, so nothing is stored):
    let dec = r.url; for (let i = 0; i < 5; i++) dec = decodeURIComponent(dec);
    const redirect = dec.match(/redirect_uri=(http:\/\/127\.0\.0\.1:\d+\/callback\/)/)[1];
    await signIn.webContents.loadURL(redirect + '?code=x&state=wrong');
    r.callbackPage = await signIn.webContents.executeJavaScript('document.body.innerText');
    await wait(2500);
    r.closedItself = signIn.isDestroyed();
    if (!signIn.isDestroyed()) signIn.close();
    await wait(800);
    r.afterClose = await js(`(document.querySelector('.chan .issue span')||{}).textContent || ''`);
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(r, null, 2));
  app.exit(0);
}).catch(e => { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ error: String(e.stack || e) })); app.exit(1); });
