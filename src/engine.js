'use strict';
// Engine: account connections, scheduled publishing with retries, analytics refresh.
// Pure Node - Electron specifics (encryption, opening the browser) are injected.
const fs = require('fs');
const platforms = require('./platforms');

class Engine {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string}} o.box
   * @param {(url:string)=>void} o.openExternal
   * @param {(evt:string, data?:any)=>void} [o.notify]
   */
  constructor({ store, box, openExternal, notify, platformMap }) {
    this.store = store;
    this.box = box;
    this.openExternal = openExternal;
    this.notify = notify || (() => {});
    this.platforms = platformMap || platforms.byId;
    this.busy = new Set();
    this.timer = null;
    this.lastAnalytics = 0;
  }

  // ---------- secrets ----------
  _enc(obj) { return this.box.encrypt(JSON.stringify(obj || {})); }
  _dec(str) { if (!str) return {}; try { return JSON.parse(this.box.decrypt(str)); } catch (_) { return {}; } }

  accountsView() {
    return Object.values(this.platforms).map(p => {
      const a = this.store.getAccount(p.id) || {};
      const secretCfg = this._dec(a.secretConfig);
      return {
        id: p.id, name: p.name, auth: p.auth, supports: p.supports, oneClick: !!p.oneClick?.(), provider: p.provider || null,
        configFields: p.configFields.map(f => ({ ...f, value: f.secret ? '' : (a.config?.[f.key] ?? f.default ?? ''), hasValue: f.secret ? !!secretCfg[f.key] : undefined })),
        postOptions: p.postOptions || [],
        connected: !!a.secret, profile: a.profile || null, connectedAt: a.connectedAt || null, lastError: a.lastError || null
      };
    });
  }

  saveAccountConfig(pid, values) {
    const p = this.platforms[pid];
    if (!p) throw new Error('Unknown platform');
    const a = this.store.getAccount(pid) || {};
    const config = { ...(a.config || {}) };
    const secretCfg = this._dec(a.secretConfig);
    for (const f of p.configFields) {
      if (!(f.key in values)) continue;
      const v = String(values[f.key] ?? '').trim();
      if (f.secret) { if (v) secretCfg[f.key] = v; } // blank = keep existing
      else config[f.key] = v;
    }
    this.store.setAccount(pid, { ...a, config, secretConfig: this._enc(secretCfg) });
  }

  _ctx(pid) {
    const a = this.store.getAccount(pid) || {};
    const account = { config: { ...(a.config || {}), ...this._dec(a.secretConfig) }, secret: this._dec(a.secret), profile: a.profile };
    return {
      account,
      settings: this.store.data.settings,
      openExternal: this.openExternal,
      saveSecret: async (next) => {
        account.secret = next;
        const cur = this.store.getAccount(pid);
        this.store.setAccount(pid, { ...cur, secret: this._enc(next) });
      }
    };
  }

  async connect(pid) {
    const p = this.platforms[pid];
    const ctx = this._ctx(pid);
    try {
      const { secret, profile } = await p.connect(ctx);
      const a = this.store.getAccount(pid);
      this.store.setAccount(pid, { ...a, secret: this._enc(secret), profile, connectedAt: new Date().toISOString(), lastError: null });
      this.store.addLog('info', `${p.name} connected as ${profile.name}`); this.store.save();
      try { await this.onConnected?.(pid, secret, profile); } catch (_) {}
      return profile;
    } catch (e) {
      const a = this.store.getAccount(pid);
      this.store.setAccount(pid, { ...a, lastError: e.message });
      throw e;
    }
  }

  disconnect(pid) {
    const a = this.store.getAccount(pid);
    if (a) this.store.setAccount(pid, { config: a.config, secretConfig: a.secretConfig });
  }

  // ---------- validation ----------
  validatePost(post) {
    const problems = [];
    if (!post.platforms.length) problems.push('Pick at least one platform.');
    if (post.mediaPath && !fs.existsSync(post.mediaPath)) problems.push('Media file not found: ' + post.mediaPath);
    for (const pid of post.platforms) {
      const p = this.platforms[pid];
      if (!p) { problems.push(`Unknown platform ${pid}`); continue; }
      const need = post.mediaType === 'none' ? 'text' : post.mediaType;
      if (!p.supports[need]) problems.push(`${p.name} can't take a ${need === 'text' ? 'text-only' : need} post.`);
      if (!this.store.getAccount(pid)?.secret) problems.push(`${p.name} isn't connected yet.`);
    }
    return problems;
  }

  // ---------- publishing ----------
  start(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
    setTimeout(() => this.tick().catch(() => {}), 3000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  duePosts(now = Date.now()) {
    return this.store.data.posts.filter(p =>
      (p.status === 'approved' || p.status === 'partial' || p.status === 'retrying') &&
      new Date(p.scheduledAt).getTime() <= now && !this.busy.has(p.id));
  }

  async tick(now = Date.now()) {
    for (const post of this.duePosts(now)) await this.publishPost(post.id);
    // token upkeep + analytics
    const hours = this.store.data.settings.analyticsIntervalHours || 6;
    if (now - this.lastAnalytics > hours * 3600e3) {
      this.lastAnalytics = now;
      await this.maintainTokens();
      await this.refreshAnalytics().catch(() => {});
    }
  }

  async maintainTokens() {
    for (const p of Object.values(this.platforms)) {
      if (!p.maintain || !this.store.getAccount(p.id)?.secret) continue;
      try { await p.maintain(this._ctx(p.id)); } catch (e) { this.store.addLog('warn', `${p.name} token refresh: ${e.message}`); }
    }
  }

  async publishPost(id) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    const max = this.store.data.settings.maxAttempts || 3;
    try {
      let post = this.store.getPost(id);
      if (!post) return;
      this.store.updatePost(id, { status: 'publishing' });
      this.notify('changed');
      for (const pid of post.platforms) {
        const r = post.results[pid] || {};
        if (r.status === 'published' || (r.status === 'failed' && (r.attempts || 0) >= max)) continue;
        const p = this.platforms[pid];
        try {
          const out = await p.publish(post, this._ctx(pid));
          post.results[pid] = { status: 'published', remoteId: String(out.remoteId), url: out.url || '', note: out.note || '', cost: out.cost, at: new Date().toISOString(), attempts: (r.attempts || 0) + 1 };
          this.store.addLog('info', `Published to ${p.name}${out.url ? ': ' + out.url : ''}`);
        } catch (e) {
          const attempts = (r.attempts || 0) + 1;
          post.results[pid] = { status: 'failed', error: e.message, at: new Date().toISOString(), attempts };
          this.store.addLog('error', `${p.name} (attempt ${attempts}/${max}): ${e.message}`);
        }
        this.store.updatePost(id, { results: post.results });
        this.notify('changed');
      }
      post = this.store.getPost(id);
      const rs = post.platforms.map(pid => post.results[pid] || {});
      const ok = rs.filter(r => r.status === 'published').length;
      const exhausted = rs.every(r => r.status === 'published' || (r.attempts || 0) >= max);
      let status;
      if (ok === rs.length) status = 'published';
      else if (exhausted) status = ok ? 'partial_failed' : 'failed';
      else status = 'retrying';
      const patch = { status };
      if (status === 'retrying') patch.scheduledAt = new Date(Date.now() + 10 * 60e3).toISOString(); // retry in 10 min
      this.store.updatePost(id, patch);
      if (status === 'published') this.notify('toast', `Published "${post.title || post.caption.slice(0, 40)}"`);
      if (status === 'failed' || status === 'partial_failed') this.notify('toast', `Some platforms failed for "${post.title || post.caption.slice(0, 40)}". See Queue for details.`);
    } finally {
      this.busy.delete(id);
      this.notify('changed');
    }
  }

  retry(id) {
    const post = this.store.getPost(id);
    for (const pid of post.platforms) if (post.results[pid]?.status === 'failed') post.results[pid].attempts = 0;
    this.store.updatePost(id, { results: post.results, status: 'approved', scheduledAt: new Date().toISOString() });
  }

  // ---------- analytics ----------
  async refreshAnalytics() {
    const a = this.store.data.analytics;
    const at = new Date().toISOString();
    const summary = [];
    for (const p of Object.values(this.platforms)) {
      if (!this.store.getAccount(p.id)?.secret) continue;
      const ctx = this._ctx(p.id);
      try {
        const s = await p.fetchAccountStats(ctx);
        if (s) { (a.account[p.id] ||= []).push({ at, ...s }); a.account[p.id] = a.account[p.id].slice(-400); }
        const map = {};
        for (const post of this.store.data.posts) {
          const r = post.results?.[p.id];
          if (r?.status === 'published' && r.remoteId) map[r.remoteId] = post.id;
        }
        const stats = await p.fetchPostStats(Object.keys(map), ctx);
        for (const [rid, m] of Object.entries(stats || {})) {
          const pid = map[rid];
          (a.posts[pid] ||= {})[p.id] = { at, ...m };
        }
        summary.push(p.name);
      } catch (e) {
        this.store.addLog('warn', `${p.name} analytics: ${e.message}`);
      }
    }
    this.store.save();
    this.notify('changed');
    return summary;
  }

  // ---------- batch import (JSON produced by Claude or by hand) ----------
  importBatch(json, baseDir) {
    const path = require('path');
    const items = Array.isArray(json) ? json : json.posts;
    if (!Array.isArray(items)) throw new Error('Batch file must be an array of posts or { "posts": [...] }.');
    const created = [];
    for (const it of items) {
      let media = it.media || it.mediaPath || '';
      if (media && !path.isAbsolute(media)) media = path.resolve(baseDir, media);
      created.push(this.store.createPost({
        title: it.title, caption: it.caption, mediaPath: media, publicMediaUrl: it.publicMediaUrl,
        platforms: it.platforms, overrides: it.overrides, aiGenerated: it.aiGenerated,
        scheduledAt: it.scheduledAt ? new Date(it.scheduledAt).toISOString() : undefined
      }));
    }
    return created;
  }
}

module.exports = { Engine };
