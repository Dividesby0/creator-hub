'use strict';
// Google insights: YouTube Analytics, Google Analytics 4, Search Console, Business Profile.
// One OAuth sign-in (installed-app loopback + PKCE). Every source is fetched independently so
// one missing API / permission never blanks the whole dashboard.
const crypto = require('crypto');
const { request, toForm, randomVerifier, challengeBase64Url, waitForAuthCode, REDIRECT_URI } = require('../util');
const { compare } = require('./ranges');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage'
];
const YTA = 'https://youtubeanalytics.googleapis.com/v2/reports';
const YT = 'https://www.googleapis.com/youtube/v3';
const GA_DATA = 'https://analyticsdata.googleapis.com/v1beta';
const GA_ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const GSC = 'https://searchconsole.googleapis.com/webmasters/v3';
const GBP_ACCT = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const GBP_INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_PERF = 'https://businessprofileperformance.googleapis.com/v1';

const GBP_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_CONVERSATIONS'
];

// Turn Google's raw errors into something a creator can act on.
function friendly(source, e) {
  const msg = String(e?.body?.error?.message || e?.message || e);
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    return `The ${source} API isn't enabled in your Google Cloud project. Enable it in Google Cloud Console → APIs & Services, then refresh.`;
  }
  if (e?.status === 403 && source === 'Business Profile') return 'Business Profile API access not approved yet (Google requires an access request), or this Google account manages no business locations.';
  if (e?.status === 403) return `Google denied access to ${source}. Reconnect Google and allow every permission on the consent screen.`;
  if (e?.status === 401) return 'Your Google sign-in expired. Click Reconnect.';
  return `${source}: ${msg.slice(0, 300)}`;
}

class GoogleInsights {
  /** ctx: { getConfig(), getSecret(), saveSecret(s), openExternal(url) } */
  constructor(ctx) { this.ctx = ctx; }

  async connect() {
    const { clientId, clientSecret } = this.ctx.getConfig();
    if (!clientId || !clientSecret) throw new Error('Enter the Google OAuth Client ID and Secret first (the same Desktop-app client you use for YouTube works).');
    const verifier = randomVerifier();
    const state = crypto.randomUUID();
    const url = `${AUTH}?` + new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      code_challenge: challengeBase64Url(verifier), code_challenge_method: 'S256'
    });
    const code = await waitForAuthCode({ authUrl: url, state, openExternal: this.ctx.openExternal });
    const { body } = await request('Google', TOKEN, {
      method: 'POST',
      body: toForm({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
    });
    if (!body.refresh_token) throw new Error('Google did not return a refresh token. Remove Creator Hub from your Google account permissions and connect again.');
    let email = '';
    try { email = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url')).email || ''; } catch (_) {}
    const secret = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000, scope: body.scope, email };
    await this.ctx.saveSecret(secret);
    return { email, scopes: String(body.scope || '').split(' ') };
  }

  async token() {
    const s = this.ctx.getSecret();
    if (!s?.refreshToken) throw Object.assign(new Error('Google is not connected.'), { status: 401 });
    if (s.expiresAt && Date.now() < s.expiresAt - 60_000) return s.accessToken;
    const { clientId, clientSecret } = this.ctx.getConfig();
    const { body } = await request('Google', TOKEN, {
      method: 'POST', body: toForm({ client_id: clientId, client_secret: clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' })
    });
    const next = { ...s, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    await this.ctx.saveSecret(next);
    return next.accessToken;
  }

  async get(url) {
    const t = await this.token();
    return (await request('Google', url, { headers: { Authorization: `Bearer ${t}` } })).body;
  }
  async post(url, json) {
    const t = await this.token();
    return (await request('Google', url, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(json) })).body;
  }

  // ---------- resource pickers ----------
  async listResources() {
    const out = { ga4: [], gsc: [], gbp: [], youtube: null, errors: {} };
    await Promise.all([
      (async () => {
        try {
          let pageToken = '', guard = 0;
          do {
            const b = await this.get(`${GA_ADMIN}/accountSummaries?pageSize=200${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
            for (const a of b.accountSummaries || []) for (const p of a.propertySummaries || []) out.ga4.push({ id: p.property.replace('properties/', ''), name: `${p.displayName} (${a.displayName})` });
            pageToken = b.nextPageToken || '';
          } while (pageToken && ++guard < 10);
        } catch (e) { out.errors.ga4 = friendly('Google Analytics Admin', e); }
      })(),
      (async () => {
        try {
          const b = await this.get(`${GSC}/sites`);
          out.gsc = (b.siteEntry || []).filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => ({ id: s.siteUrl, name: s.siteUrl.replace(/^sc-domain:/, 'Domain: ') }));
        } catch (e) { out.errors.gsc = friendly('Search Console', e); }
      })(),
      (async () => {
        try {
          const accts = await this.get(`${GBP_ACCT}/accounts`);
          for (const a of accts.accounts || []) {
            const b = await this.get(`${GBP_INFO}/${a.name}/locations?readMask=name,title&pageSize=100`);
            for (const l of b.locations || []) out.gbp.push({ id: l.name, name: l.title });
          }
        } catch (e) { out.errors.gbp = friendly('Business Profile', e); }
      })(),
      (async () => {
        try {
          const b = await this.get(`${YT}/channels?part=snippet,statistics&mine=true`);
          const c = b.items?.[0];
          out.youtube = c ? { id: c.id, name: c.snippet.title, subscribers: +c.statistics.subscriberCount || 0, videos: +c.statistics.videoCount || 0 } : null;
          if (!c) out.errors.youtube = 'This Google account has no YouTube channel.';
        } catch (e) { out.errors.youtube = friendly('YouTube Data', e); }
      })()
    ]);
    return out;
  }

  // ---------- YouTube Analytics ----------
  async yta(params) {
    const q = new URLSearchParams({ ids: 'channel==MINE', ...params });
    const b = await this.get(`${YTA}?${q}`);
    const cols = (b.columnHeaders || []).map(c => c.name);
    return (b.rows || []).map(r => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  }

  async youtube(range) {
    const metrics = 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares';
    const [cur, prev, daily, top, traffic] = await Promise.all([
      this.yta({ startDate: range.start, endDate: range.end, metrics }),
      this.yta({ startDate: range.prevStart, endDate: range.prevEnd, metrics }),
      this.yta({ startDate: range.start, endDate: range.end, metrics: 'views,estimatedMinutesWatched,subscribersGained', dimensions: 'day', sort: 'day' }),
      this.yta({ startDate: range.start, endDate: range.end, metrics: 'views,estimatedMinutesWatched,averageViewPercentage,likes,subscribersGained', dimensions: 'video', sort: '-views', maxResults: '10' }),
      this.yta({ startDate: range.start, endDate: range.end, metrics: 'views,estimatedMinutesWatched', dimensions: 'insightTrafficSourceType', sort: '-views' }).catch(() => [])
    ]);
    const tot = r => ({
      views: +r?.views || 0, watchHours: (+r?.estimatedMinutesWatched || 0) / 60, avgViewDuration: +r?.averageViewDuration || 0,
      netSubscribers: (+r?.subscribersGained || 0) - (+r?.subscribersLost || 0), likes: +r?.likes || 0, comments: +r?.comments || 0, shares: +r?.shares || 0
    });
    let titles = {};
    if (top.length) {
      try {
        const b = await this.get(`${YT}/videos?part=snippet&id=${top.map(t => t.video).join(',')}`);
        titles = Object.fromEntries((b.items || []).map(v => [v.id, v.snippet.title]));
      } catch (_) {}
    }
    const engagement = r => { const t = tot(r); return t.views ? (t.likes + t.comments + t.shares) / t.views : 0; };
    const totals = compare({ ...tot(cur[0]), engagementRate: engagement(cur[0]) }, { ...tot(prev[0]), engagementRate: engagement(prev[0]) });
    return {
      totals,
      series: daily.map(d => ({ date: d.day, views: +d.views, watchHours: (+d.estimatedMinutesWatched) / 60, subscribers: +d.subscribersGained })),
      topVideos: top.map(t => ({ id: t.video, title: titles[t.video] || t.video, views: +t.views, watchHours: (+t.estimatedMinutesWatched) / 60, avgViewPct: +t.averageViewPercentage, likes: +t.likes, subscribers: +t.subscribersGained, url: `https://www.youtube.com/watch?v=${t.video}` })),
      trafficSources: traffic.map(t => ({ source: prettySource(t.insightTrafficSourceType), views: +t.views }))
    };
  }

  // ---------- Google Analytics 4 ----------
  async ga4(propertyId, range) {
    const run = body => this.post(`${GA_DATA}/properties/${encodeURIComponent(propertyId)}:runReport`, body);
    const metrics = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration'].map(name => ({ name }));
    const row = b => Object.fromEntries((b.metricHeaders || []).map((h, i) => [h.name, +(b.rows?.[0]?.metricValues?.[i]?.value || 0)]));
    const [cur, prev, daily, pages, channels] = await Promise.all([
      run({ dateRanges: [{ startDate: range.start, endDate: range.end }], metrics }),
      run({ dateRanges: [{ startDate: range.prevStart, endDate: range.prevEnd }], metrics }),
      run({ dateRanges: [{ startDate: range.start, endDate: range.end }], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
      run({ dateRanges: [{ startDate: range.start, endDate: range.end }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }),
      run({ dateRanges: [{ startDate: range.start, endDate: range.end }], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 })
    ]);
    const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const r = (b, i) => (b.rows || []).map(x => [x.dimensionValues[0].value, ...x.metricValues.map(m => +m.value)]);
    return {
      totals: compare(row(cur), row(prev)),
      series: r(daily).map(([d, users, sessions, views]) => ({ date: ymd(d), users, sessions, views })),
      topPages: r(pages).map(([page, views, users]) => ({ page, views, users })),
      channels: r(channels).map(([channel, sessions]) => ({ channel, sessions }))
    };
  }

  // ---------- Search Console ----------
  async gsc(siteUrl, range) {
    const q = body => this.post(`${GSC}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body);
    const tot = b => { const x = b.rows?.[0] || {}; return { clicks: x.clicks || 0, impressions: x.impressions || 0, ctr: x.ctr || 0, position: x.position || 0 }; };
    const [cur, prev, daily, queries, pages] = await Promise.all([
      q({ startDate: range.start, endDate: range.end }),
      q({ startDate: range.prevStart, endDate: range.prevEnd }),
      q({ startDate: range.start, endDate: range.end, dimensions: ['date'] }),
      q({ startDate: range.start, endDate: range.end, dimensions: ['query'], rowLimit: 15 }),
      q({ startDate: range.start, endDate: range.end, dimensions: ['page'], rowLimit: 10 })
    ]);
    return {
      totals: compare(tot(cur), tot(prev)),
      series: (daily.rows || []).map(x => ({ date: x.keys[0], clicks: x.clicks, impressions: x.impressions, position: x.position })),
      topQueries: (queries.rows || []).map(x => ({ query: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position })),
      topPages: (pages.rows || []).map(x => ({ page: x.keys[0], clicks: x.clicks, impressions: x.impressions }))
    };
  }

  // ---------- Business Profile ----------
  async gbpRange(location, start, end) {
    const [sy, sm, sd] = start.split('-').map(Number), [ey, em, ed] = end.split('-').map(Number);
    const q = new URLSearchParams();
    for (const m of GBP_METRICS) q.append('dailyMetrics', m);
    Object.entries({ 'dailyRange.start_date.year': sy, 'dailyRange.start_date.month': sm, 'dailyRange.start_date.day': sd,
      'dailyRange.end_date.year': ey, 'dailyRange.end_date.month': em, 'dailyRange.end_date.day': ed }).forEach(([k, v]) => q.append(k, v));
    const b = await this.get(`${GBP_PERF}/${location}:fetchMultiDailyMetricsTimeSeries?${q}`);
    const byDate = {}, sums = {};
    for (const group of b.multiDailyMetricTimeSeries || []) {
      for (const s of group.dailyMetricTimeSeries || []) {
        for (const dv of s.timeSeries?.datedValues || []) {
          const d = `${dv.date.year}-${String(dv.date.month).padStart(2, '0')}-${String(dv.date.day).padStart(2, '0')}`;
          const v = +(dv.value || 0);
          (byDate[d] ||= {})[s.dailyMetric] = v;
          sums[s.dailyMetric] = (sums[s.dailyMetric] || 0) + v;
        }
      }
    }
    const impressions = o => GBP_METRICS.slice(0, 4).reduce((t, k) => t + (o[k] || 0), 0);
    const totals = { impressions: impressions(sums), searchViews: (sums.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) + (sums.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0),
      mapsViews: (sums.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) + (sums.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0),
      websiteClicks: sums.WEBSITE_CLICKS || 0, calls: sums.CALL_CLICKS || 0, directions: sums.BUSINESS_DIRECTION_REQUESTS || 0, messages: sums.BUSINESS_CONVERSATIONS || 0 };
    const series = Object.keys(byDate).sort().map(d => ({ date: d, impressions: impressions(byDate[d]), websiteClicks: byDate[d].WEBSITE_CLICKS || 0, calls: byDate[d].CALL_CLICKS || 0, directions: byDate[d].BUSINESS_DIRECTION_REQUESTS || 0 }));
    return { totals, series };
  }

  async gbp(location, range) {
    const [cur, prev] = await Promise.all([this.gbpRange(location, range.start, range.end), this.gbpRange(location, range.prevStart, range.prevEnd)]);
    return { totals: compare(cur.totals, prev.totals), series: cur.series };
  }

  // ---------- everything ----------
  async fetchAll(range, sel = {}) {
    const result = { range, fetchedAt: new Date().toISOString(), sources: {} };
    const run = async (key, label, fn) => {
      try { result.sources[key] = { ok: true, ...(await fn()) }; }
      catch (e) { result.sources[key] = { ok: false, error: friendly(label, e) }; }
    };
    await Promise.all([
      run('youtube', 'YouTube Analytics', () => this.youtube(range)),
      sel.ga4Property ? run('ga4', 'Google Analytics Data', () => this.ga4(sel.ga4Property, range)) : null,
      sel.gscSite ? run('gsc', 'Search Console', () => this.gsc(sel.gscSite, range)) : null,
      sel.gbpLocation ? run('gbp', 'Business Profile', () => this.gbp(sel.gbpLocation, range)) : null
    ]);
    return result;
  }
}

const SOURCE_NAMES = {
  YT_SEARCH: 'YouTube search', SUGGESTED_VIDEO: 'Suggested videos', BROWSE: 'Browse / Home', EXT_URL: 'External sites',
  SHORTS: 'Shorts feed', SUBSCRIBER: 'Subscriptions', NOTIFICATION: 'Notifications', PLAYLIST: 'Playlists', NO_LINK_OTHER: 'Direct / unknown',
  YT_CHANNEL: 'Channel pages', YT_OTHER_PAGE: 'Other YouTube pages', END_SCREEN: 'End screens', ANNOTATION: 'Cards', ADVERTISING: 'Ads',
  RELATED_VIDEO: 'Related videos', HASHTAGS: 'Hashtags', SOUND_PAGE: 'Sound pages', LIVE_REDIRECT: 'Live redirects', CAMPAIGN_CARD: 'Campaign cards', VIDEO_REMIXES: 'Remixes'
};
const prettySource = s => SOURCE_NAMES[s] || String(s || 'Other').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

module.exports = { GoogleInsights, friendly, GBP_METRICS, SCOPES };
