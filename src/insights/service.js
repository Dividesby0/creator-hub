'use strict';
// Insights service: owns the Google connection, picks, cache, and builds the all-in-one overview
// (Google sources + every connected social platform).
const { GoogleInsights } = require('./google');
const { rangeFor, compare, delta } = require('./ranges');

const DEFAULT = { config: {}, secretConfig: '', secret: '', selections: {}, resources: null, cache: {}, lastError: null };

class InsightsService {
  constructor({ store, box, openExternal, googleImpl }) {
    this.store = store;
    this.box = box;
    store.data.insights = { ...structuredClone(DEFAULT), ...(store.data.insights || {}) };
    this.google = googleImpl || new GoogleInsights({
      getConfig: () => this.config(),
      getSecret: () => this._dec(this.s.secret),
      saveSecret: async next => { this.s.secret = this._enc(next); this.store.save(); },
      openExternal
    });
  }

  get s() { return this.store.data.insights; }
  _enc(o) { return this.box.encrypt(JSON.stringify(o || {})); }
  _dec(str) { if (!str) return {}; try { return JSON.parse(this.box.decrypt(str)); } catch (_) { return {}; } }

  // Falls back to the YouTube OAuth client so users enter it once.
  config() {
    const own = { ...this.s.config, ...this._dec(this.s.secretConfig) };
    if (own.clientId && own.clientSecret) return own;
    const yt = this.store.getAccount('youtube');
    if (yt) {
      const ytSecret = (() => { try { return JSON.parse(this.box.decrypt(yt.secretConfig)); } catch (_) { return {}; } })();
      return { clientId: own.clientId || yt.config?.clientId, clientSecret: own.clientSecret || ytSecret.clientSecret };
    }
    return own;
  }

  view() {
    const secret = this._dec(this.s.secret);
    const cfg = this.config();
    return {
      connected: !!secret.refreshToken, email: secret.email || '', hasClient: !!(cfg.clientId && cfg.clientSecret),
      clientId: this.s.config.clientId || '', usingYouTubeClient: !this.s.config.clientId && !!cfg.clientId,
      selections: this.s.selections, resources: this.s.resources, lastError: this.s.lastError
    };
  }

  saveConfig({ clientId, clientSecret }) {
    if (clientId !== undefined) this.s.config.clientId = String(clientId).trim();
    if (clientSecret) this.s.secretConfig = this._enc({ clientSecret: String(clientSecret).trim() });
    this.store.save();
  }

  async connect() {
    const r = await this.google.connect();
    this.s.lastError = null;
    await this.refreshResources();
    return r;
  }

  disconnect() { this.s.secret = ''; this.s.cache = {}; this.s.resources = null; this.store.save(); }

  async refreshResources() {
    const res = await this.google.listResources();
    this.s.resources = res;
    const sel = this.s.selections;
    // Auto-pick when there's exactly one choice.
    if (!sel.ga4Property && res.ga4.length === 1) sel.ga4Property = res.ga4[0].id;
    if (!sel.gscSite && res.gsc.length === 1) sel.gscSite = res.gsc[0].id;
    if (!sel.gbpLocation && res.gbp.length === 1) sel.gbpLocation = res.gbp[0].id;
    this.store.save();
    return res;
  }

  select(patch) {
    Object.assign(this.s.selections, patch);
    this.s.cache = {};
    this.store.save();
  }

  // ---------- social (from Creator Hub's own snapshots) ----------
  social(range) {
    const a = this.store.data.analytics || { account: {}, posts: {} };
    const at = (hist, day) => {
      // last snapshot on/before end of `day`; fall back to first snapshot after
      const t = Date.parse(day + 'T23:59:59Z');
      let best = null;
      for (const h of hist) if (Date.parse(h.at) <= t) best = h;
      return best || null;
    };
    const platforms = [];
    for (const [pid, hist] of Object.entries(a.account || {})) {
      if (!hist?.length) continue;
      const latest = hist.at(-1);
      const end = at(hist, range.end) || latest;
      const start = at(hist, range.prevEnd) || hist[0];
      platforms.push({ id: pid, followers: end.followers || 0, growth: (end.followers || 0) - (start.followers || 0) });
    }
    const inRange = (iso, s, e) => iso && iso.slice(0, 10) >= s && iso.slice(0, 10) <= e;
    const sum = (s, e) => {
      const t = { posts: 0, views: 0, likes: 0, comments: 0, shares: 0 };
      for (const p of this.store.data.posts || []) {
        if (!['published', 'partial_failed'].includes(p.status) || !inRange(p.scheduledAt, s, e)) continue;
        t.posts++;
        for (const m of Object.values(a.posts?.[p.id] || {})) for (const k of ['views', 'likes', 'comments', 'shares']) t[k] += m[k] || 0;
      }
      t.engagement = t.likes + t.comments + t.shares;
      return t;
    };
    const cur = sum(range.start, range.end), prev = sum(range.prevStart, range.prevEnd);
    return { platforms, totals: compare(cur, prev) };
  }

  // ---------- overview ----------
  buildOverview(range, google, social) {
    const src = google?.sources || {};
    const v = (s, k) => (src[s]?.ok ? src[s].totals?.[k] : null);
    const pair = (...items) => {
      let cur = 0, prev = 0, any = false;
      for (const it of items) if (it) { any = true; cur += it.value || 0; prev += it.prev || 0; }
      return any ? { value: cur, prev, delta: delta(cur, prev) } : null;
    };
    const socialFollowers = social.platforms.filter(p => p.id !== 'youtube').reduce((t, p) => t + p.followers, 0);
    const socialGrowth = social.platforms.filter(p => p.id !== 'youtube').reduce((t, p) => t + p.growth, 0);
    const ytSubs = google?.resources?.youtube?.subscribers ?? social.platforms.find(p => p.id === 'youtube')?.followers ?? 0;
    const ytNet = v('youtube', 'netSubscribers');
    const audienceNow = socialFollowers + ytSubs;
    const audienceGrowth = socialGrowth + (ytNet?.value || 0);

    const kpis = {
      audience: { value: audienceNow, prev: audienceNow - audienceGrowth, delta: delta(audienceNow, audienceNow - audienceGrowth), growth: audienceGrowth },
      reach: pair(v('youtube', 'views'), social.totals.views, v('gsc', 'impressions'), v('gbp', 'impressions')),
      engagement: pair(v('youtube', 'likes'), v('youtube', 'comments'), v('youtube', 'shares'), social.totals.engagement),
      watchHours: v('youtube', 'watchHours'),
      websiteVisitors: v('ga4', 'activeUsers'),
      searchClicks: v('gsc', 'clicks'),
      businessActions: pair(v('gbp', 'websiteClicks'), v('gbp', 'calls'), v('gbp', 'directions'), v('gbp', 'messages'))
    };
    return { kpis, highlights: this.highlights(src, social) };
  }

  highlights(src, social) {
    const out = [];
    const pct = d => `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`;
    const yt = src.youtube?.ok ? src.youtube : null;
    if (yt?.topVideos?.[0]) out.push({ tone: 'good', text: `Top video: “${yt.topVideos[0].title}” — ${Math.round(yt.topVideos[0].views).toLocaleString()} views this period.` });
    if (yt?.trafficSources?.[0]) {
      const total = yt.trafficSources.reduce((t, s) => t + s.views, 0) || 1;
      out.push({ tone: 'info', text: `${Math.round(yt.trafficSources[0].views / total * 100)}% of YouTube views came from ${yt.trafficSources[0].source}.` });
    }
    const vd = yt?.totals?.views?.delta;
    if (vd != null && Math.abs(vd) >= 0.1) out.push({ tone: vd > 0 ? 'good' : 'warn', text: `YouTube views ${pct(vd)} vs. the previous period.` });
    const sub = yt?.totals?.netSubscribers;
    if (sub && sub.value < 0) out.push({ tone: 'warn', text: `You lost ${Math.abs(sub.value)} subscribers net — check recent uploads for drop-off.` });
    const gsc = src.gsc?.ok ? src.gsc : null;
    if (gsc) {
      const opp = (gsc.topQueries || []).filter(q => q.impressions > 50 && q.position > 3 && q.position <= 15).sort((a, b) => b.impressions - a.impressions)[0];
      if (opp) out.push({ tone: 'info', text: `SEO opportunity: “${opp.query}” gets ${Math.round(opp.impressions)} impressions at position ${opp.position.toFixed(1)} — a better title or page could move it to the top 3.` });
    }
    const ga = src.ga4?.ok ? src.ga4 : null;
    if (ga?.channels?.[0]) out.push({ tone: 'info', text: `Most website sessions come from ${ga.channels[0].channel}.` });
    const gbp = src.gbp?.ok ? src.gbp : null;
    if (gbp?.totals?.impressions?.delta != null && Math.abs(gbp.totals.impressions.delta) >= 0.1) out.push({ tone: gbp.totals.impressions.delta > 0 ? 'good' : 'warn', text: `Business Profile views ${pct(gbp.totals.impressions.delta)}.` });
    const grower = [...social.platforms].sort((a, b) => b.growth - a.growth)[0];
    if (grower?.growth > 0) out.push({ tone: 'good', text: `Fastest-growing platform: ${grower.id} (+${grower.growth} followers).` });
    return out.slice(0, 6);
  }

  async refresh(days = 28, { force = false } = {}) {
    const range = rangeFor(days);
    const key = String(days);
    const cached = this.s.cache[key];
    if (!force && cached && cached.range.end === range.end && Date.now() - Date.parse(cached.fetchedAt) < 3 * 3600e3) return this.report(days);
    let google = null;
    if (this._dec(this.s.secret).refreshToken) {
      try {
        if (!this.s.resources) await this.refreshResources();
        google = await this.google.fetchAll(range, this.s.selections);
        google.resources = this.s.resources;
        this.s.lastError = null;
      } catch (e) { this.s.lastError = e.message; }
    }
    this.s.cache[key] = { range, fetchedAt: new Date().toISOString(), google };
    this.store.save();
    return this.report(days);
  }

  report(days = 28) {
    const range = rangeFor(days);
    const cached = this.s.cache[String(days)] || { range, fetchedAt: null, google: null };
    const social = this.social(cached.range || range);
    return { range: cached.range || range, fetchedAt: cached.fetchedAt, google: cached.google, social, overview: this.buildOverview(cached.range || range, cached.google, social) };
  }
}

module.exports = { InsightsService };
