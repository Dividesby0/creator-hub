'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cleanupMod = require('../src/installer/cleanup');
const { checkForUpdate } = require('../src/installer/updates');
const { rangeFor, compare } = require('../src/insights/ranges');
const { GoogleInsights, friendly } = require('../src/insights/google');
const { InsightsService } = require('../src/insights/service');
const { Store } = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v2-'));
function fakeApp(dir, name, bundleId, version) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.join(p, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(p, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
    <key>CFBundleIdentifier</key>\n    <string>${bundleId}</string>
    <key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return p;
}

// ---------------- cleanup ----------------
test('cleanup finds old copies by bundle id, keeps the running app and unrelated apps', async () => {
  const apps = tmp(), downloads = tmp(), desktop = tmp();
  const current = fakeApp(apps, 'Creator Hub.app', 'com.creatorhub.desktop', '2.0.0');
  const dl = fakeApp(downloads, 'Creator Hub.app', 'com.creatorhub.desktop', '1.0.0');
  const dup = fakeApp(apps, 'Creator Hub 2.app', 'com.creatorhub.desktop', '1.0.2');
  fakeApp(desktop, 'Creator Hub Pro.app', 'com.someoneelse.app', '9.9.9'); // different app, same-ish name
  fs.writeFileSync(path.join(downloads, 'Creator.Hub-1.0.2-arm64.dmg'), 'x');
  fs.writeFileSync(path.join(downloads, 'Creator.Hub-2.0.0-arm64.dmg'), 'x');   // current installer: keep
  fs.writeFileSync(path.join(downloads, 'Creator.Hub.Setup.1.0.1.exe'), 'x');
  fs.writeFileSync(path.join(downloads, 'creator-hub-notes.txt'), 'x');

  const trashed = [];
  const r = await cleanupMod.cleanup({
    currentAppPath: current, currentVersion: '2.0.0', dirs: [apps, downloads, desktop], knownPaths: [dl],
    trash: async p => { trashed.push(p); }
  });
  assert.deepStrictEqual(trashed.sort(), [dl, dup, path.join(downloads, 'Creator.Hub-1.0.2-arm64.dmg'), path.join(downloads, 'Creator.Hub.Setup.1.0.1.exe')].sort());
  assert.ok(!trashed.includes(current), 'never trashes the running app');
  assert.strictEqual(r.removed.length, 4);
  assert.strictEqual(r.failed.length, 0);
});

test('cleanup ignores mounted disk images and unreadable folders, reports failures', async () => {
  const apps = tmp();
  const old = fakeApp(apps, 'Creator Hub.app', 'com.creatorhub.desktop', '1.0.0');
  const r = await cleanupMod.cleanup({
    currentAppPath: '/Applications/Creator Hub.app', currentVersion: '2.0.0',
    dirs: ['/definitely/missing', apps], knownPaths: ['/Volumes/Creator Hub 2.0.0/Creator Hub.app'],
    trash: async () => { throw new Error('busy'); }
  });
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].path, old);
});

test('appBundleOf and version compare', () => {
  assert.strictEqual(cleanupMod.appBundleOf('/Applications/Creator Hub.app/Contents/MacOS/Creator Hub'), '/Applications/Creator Hub.app');
  assert.strictEqual(cleanupMod.appBundleOf('C:\\Program Files\\Creator Hub\\Creator Hub.exe'), null);
  assert.strictEqual(cleanupMod.cmpVersion('1.0.10', '1.0.9'), 1);
  assert.strictEqual(cleanupMod.cmpVersion('2.0.0', '2.0.0'), 0);
  assert.strictEqual(cleanupMod.cmpVersion('1.9.9', '2.0.0'), -1);
});

// ---------------- update check ----------------
test('update check picks the right installer and ignores same/older versions', async () => {
  const rel = { tag_name: 'v2.1.0', html_url: 'https://gh/rel', body: 'notes', assets: [
    { name: 'Creator.Hub-2.1.0-arm64.dmg', browser_download_url: 'https://gh/arm.dmg' },
    { name: 'Creator.Hub-2.1.0.dmg', browser_download_url: 'https://gh/intel.dmg' },
    { name: 'Creator.Hub.Setup.2.1.0.exe', browser_download_url: 'https://gh/win.exe' }] };
  const f = async () => new Response(JSON.stringify(rel));
  assert.strictEqual((await checkForUpdate({ feedUrl: 'x', currentVersion: '2.0.0', platform: 'darwin', arch: 'arm64', fetchImpl: f })).url, 'https://gh/arm.dmg');
  assert.strictEqual((await checkForUpdate({ feedUrl: 'x', currentVersion: '2.0.0', platform: 'darwin', arch: 'x64', fetchImpl: f })).url, 'https://gh/intel.dmg');
  assert.strictEqual((await checkForUpdate({ feedUrl: 'x', currentVersion: '2.0.0', platform: 'win32', fetchImpl: f })).url, 'https://gh/win.exe');
  assert.strictEqual(await checkForUpdate({ feedUrl: 'x', currentVersion: '2.1.0', fetchImpl: f }), null);
  assert.strictEqual(await checkForUpdate({ feedUrl: 'x', currentVersion: '2.0.0', fetchImpl: async () => new Response('nope', { status: 404 }) }), null);
  assert.strictEqual(await checkForUpdate({ feedUrl: 'x', currentVersion: '2.0.0', fetchImpl: async () => { throw new Error('offline'); } }), null);
});

// ---------------- ranges ----------------
test('ranges end yesterday and previous period is adjacent and equal length', () => {
  const r = rangeFor(28, new Date('2026-10-07T12:00:00Z'));
  assert.deepStrictEqual(r, { days: 28, start: '2026-09-09', end: '2026-10-06', prevStart: '2026-08-12', prevEnd: '2026-09-08' });
  const c = compare({ a: 150, b: 0 }, { a: 100, b: 0 });
  assert.strictEqual(c.a.delta, 0.5);
  assert.strictEqual(c.b.delta, 0);
});

// ---------------- Google providers (mocked HTTP) ----------------
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, h] of routes) if (String(url).includes(match)) {
      const r = typeof h === 'function' ? h(String(url), opts) : h;
      return new Response(JSON.stringify(r.body ?? r), { status: r.status || 200 });
    }
    throw new Error('unmocked ' + url);
  };
  return calls;
}
const gctx = () => ({ getConfig: () => ({ clientId: 'c', clientSecret: 's' }), getSecret: () => ({ refreshToken: 'r', accessToken: 'A', expiresAt: Date.now() + 3600e3 }), saveSecret: async () => {} });
const R = rangeFor(28, new Date('2026-10-07T12:00:00Z'));

test('YouTube Analytics: totals, period deltas, daily series, top videos with titles, traffic sources', async () => {
  const hdr = names => names.map(name => ({ name }));
  mockFetch([
    ['dimensions=day', { columnHeaders: hdr(['day', 'views', 'estimatedMinutesWatched', 'subscribersGained']), rows: [['2026-09-09', 100, 600, 3], ['2026-09-10', 120, 660, 1]] }],
    ['dimensions=video', { columnHeaders: hdr(['video', 'views', 'estimatedMinutesWatched', 'averageViewPercentage', 'likes', 'subscribersGained']), rows: [['vid1', 900, 3000, 52.5, 40, 6]] }],
    ['dimensions=insightTrafficSourceType', { columnHeaders: hdr(['insightTrafficSourceType', 'views', 'estimatedMinutesWatched']), rows: [['YT_SEARCH', 500, 1], ['SUGGESTED_VIDEO', 300, 1]] }],
    [`startDate=${R.prevStart}`, { columnHeaders: hdr(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares']), rows: [[1000, 3000, 180, 20, 5, 50, 10, 5]] }],
    [`startDate=${R.start}`, { columnHeaders: hdr(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares']), rows: [[1500, 6000, 240, 30, 2, 90, 20, 10]] }],
    ['/youtube/v3/videos', { items: [{ id: 'vid1', snippet: { title: 'AI voice clone scams' } }] }]
  ]);
  const y = await new GoogleInsights(gctx()).youtube(R);
  assert.strictEqual(y.totals.views.value, 1500);
  assert.strictEqual(y.totals.views.delta, 0.5);
  assert.strictEqual(y.totals.watchHours.value, 100);
  assert.strictEqual(y.totals.netSubscribers.value, 28);
  assert.ok(Math.abs(y.totals.engagementRate.value - 120 / 1500) < 1e-9);
  assert.strictEqual(y.series.length, 2);
  assert.strictEqual(y.series[0].watchHours, 10);
  assert.strictEqual(y.topVideos[0].title, 'AI voice clone scams');
  assert.strictEqual(y.trafficSources[0].source, 'YouTube search');
});

test('GA4: totals for both periods, daily series with ISO dates, pages and channels', async () => {
  const calls = mockFetch([[':runReport', (url, o) => {
    const b = JSON.parse(o.body);
    const dim = b.dimensions?.[0]?.name;
    if (!dim) {
      const prev = b.dateRanges[0].startDate === R.prevStart;
      return { metricHeaders: b.metrics.map(m => ({ name: m.name })), rows: [{ metricValues: b.metrics.map((_, i) => ({ value: String(prev ? 100 + i : 200 + i) })) }] };
    }
    if (dim === 'date') return { rows: [{ dimensionValues: [{ value: '20260909' }], metricValues: [{ value: '10' }, { value: '12' }, { value: '30' }] }] };
    if (dim === 'pagePath') return { rows: [{ dimensionValues: [{ value: '/voice-clones' }], metricValues: [{ value: '400' }, { value: '150' }] }] };
    return { rows: [{ dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '90' }] }] };
  }]]);
  const g = await new GoogleInsights(gctx()).ga4('123456', R);
  assert.strictEqual(g.totals.activeUsers.value, 200);
  assert.strictEqual(g.totals.activeUsers.prev, 100);
  assert.deepStrictEqual(g.series[0], { date: '2026-09-09', users: 10, sessions: 12, views: 30 });
  assert.strictEqual(g.topPages[0].page, '/voice-clones');
  assert.strictEqual(g.channels[0].channel, 'Organic Search');
  assert.ok(calls[0].url.includes('/properties/123456:runReport'));
});

test('Search Console: encodes site URL, totals and query table', async () => {
  const calls = mockFetch([['searchAnalytics/query', (url, o) => {
    const b = JSON.parse(o.body);
    if (!b.dimensions) return { rows: [{ clicks: b.startDate === R.start ? 50 : 40, impressions: 2000, ctr: 0.025, position: 8.2 }] };
    if (b.dimensions[0] === 'date') return { rows: [{ keys: ['2026-09-09'], clicks: 2, impressions: 80, position: 9 }] };
    if (b.dimensions[0] === 'query') return { rows: [{ keys: ['ai voice scam'], clicks: 9, impressions: 600, ctr: 0.015, position: 6.3 }] };
    return { rows: [{ keys: ['https://site/a'], clicks: 9, impressions: 600 }] };
  }]]);
  const g = await new GoogleInsights(gctx()).gsc('sc-domain:decrypt443.com', R);
  assert.ok(calls[0].url.includes('/sites/sc-domain%3Adecrypt443.com/searchAnalytics/query'));
  assert.strictEqual(g.totals.clicks.value, 50);
  assert.strictEqual(g.totals.clicks.delta, 0.25);
  assert.strictEqual(g.topQueries[0].query, 'ai voice scam');
});

test('Business Profile: sums impression metrics and builds daily series', async () => {
  const calls = mockFetch([[':fetchMultiDailyMetricsTimeSeries', url => {
    const prev = url.includes(`dailyRange.start_date.month=${+R.prevStart.slice(5, 7)}&dailyRange.start_date.day=${+R.prevStart.slice(8)}`);
    const ser = (m, v) => ({ dailyMetric: m, timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 9 }, value: String(v) }] } });
    return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
      ser('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', prev ? 10 : 30), ser('BUSINESS_IMPRESSIONS_MOBILE_MAPS', 20), ser('WEBSITE_CLICKS', 5), ser('CALL_CLICKS', 2)] }] };
  }]]);
  const g = await new GoogleInsights(gctx()).gbp('locations/42', R);
  assert.ok(calls[0].url.includes('/locations/42:fetchMultiDailyMetricsTimeSeries?dailyMetrics='));
  assert.strictEqual(g.totals.impressions.value, 50);
  assert.strictEqual(g.totals.impressions.prev, 30);
  assert.strictEqual(g.totals.websiteClicks.value, 5);
  assert.deepStrictEqual(g.series[0], { date: '2026-09-09', impressions: 50, websiteClicks: 5, calls: 2, directions: 0 });
});

test('one failing source never blanks the others; errors are human-readable', async () => {
  mockFetch([
    ['youtubeanalytics', { status: 403, body: { error: { message: 'YouTube Analytics API has not been used in project 123 before or it is disabled.' } } }],
    ['searchAnalytics', { rows: [{ clicks: 1, impressions: 2, ctr: 0.5, position: 3, keys: ['x'] }] }]
  ]);
  const all = await new GoogleInsights(gctx()).fetchAll(R, { gscSite: 'https://site/' });
  assert.strictEqual(all.sources.youtube.ok, false);
  assert.match(all.sources.youtube.error, /isn't enabled in your Google Cloud project/);
  assert.strictEqual(all.sources.gsc.ok, true);
  assert.strictEqual(all.sources.ga4, undefined, 'unselected sources are skipped');
  assert.match(friendly('Business Profile', { status: 403, message: 'x' }), /access request/);
});

// ---------------- service overview ----------------
test('overview combines Google and social data into audience, reach and highlights', () => {
  const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
  const store = new Store(tmp());
  const svc = new InsightsService({ store, box, openExternal: () => {}, googleImpl: {} });
  const range = rangeFor(28, new Date('2026-10-07T12:00:00Z'));
  store.data.analytics.account = {
    tiktok: [{ at: '2026-09-01T00:00:00Z', followers: 100 }, { at: '2026-10-05T00:00:00Z', followers: 160 }],
    x: [{ at: '2026-09-01T00:00:00Z', followers: 40 }, { at: '2026-10-05T00:00:00Z', followers: 38 }]
  };
  const social = svc.social(range);
  assert.deepStrictEqual(social.platforms.map(p => [p.id, p.followers, p.growth]), [['tiktok', 160, 60], ['x', 38, -2]]);
  const google = { resources: { youtube: { subscribers: 1000 } }, sources: {
    youtube: { ok: true, totals: compare({ views: 5000, likes: 100, comments: 20, shares: 10, netSubscribers: 50, watchHours: 300 }, { views: 4000, likes: 80, comments: 10, shares: 5, netSubscribers: 20, watchHours: 200 }),
      topVideos: [{ title: 'Deepfake calls', views: 2000 }], trafficSources: [{ source: 'YouTube search', views: 3000 }, { source: 'Browse / Home', views: 2000 }] },
    gsc: { ok: true, totals: compare({ clicks: 10, impressions: 800 }, { clicks: 5, impressions: 400 }), topQueries: [{ query: 'voice clone scam', impressions: 300, position: 7.4 }] }
  } };
  const o = svc.buildOverview(range, google, social);
  assert.strictEqual(o.kpis.audience.value, 1000 + 160 + 38);
  assert.strictEqual(o.kpis.audience.growth, 50 + 58);
  assert.strictEqual(o.kpis.reach.value, 5000 + 800);
  assert.strictEqual(o.kpis.websiteVisitors, null);
  const text = o.highlights.map(h => h.text).join(' | ');
  assert.match(text, /Deepfake calls/);
  assert.match(text, /60% of YouTube views came from YouTube search/);
  assert.match(text, /SEO opportunity: “voice clone scam”/);
  assert.match(text, /Fastest-growing platform: tiktok/);
});

test('service falls back to the YouTube OAuth client and stores the Google secret encrypted', async () => {
  const box = { encrypt: s => 'x:' + Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s.slice(2), 'base64').toString() };
  const store = new Store(tmp());
  store.setAccount('youtube', { config: { clientId: 'yt-client' }, secretConfig: box.encrypt(JSON.stringify({ clientSecret: 'yt-secret' })) });
  const svc = new InsightsService({ store, box, openExternal: () => {} });
  assert.deepStrictEqual(svc.config(), { clientId: 'yt-client', clientSecret: 'yt-secret', source: 'own' });
  assert.strictEqual(svc.view().usingYouTubeClient, true);
  svc.saveConfig({ clientId: 'own', clientSecret: 'own-secret' });
  assert.deepStrictEqual(svc.config(), { clientId: 'own', clientSecret: 'own-secret', source: 'own' });
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('own-secret'));
});
