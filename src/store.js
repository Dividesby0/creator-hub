'use strict';
// Simple JSON-file store with atomic writes. No native dependencies, so it
// runs the same on macOS and Windows without rebuilds.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DATA = {
  version: 1,
  posts: [],
  accounts: {},          // platformId -> { config (plain), secret (encrypted blob), profile, connectedAt }
  analytics: {           // snapshots used by the dashboard
    account: {},         // platformId -> [{ at, followers, ... }]
    posts: {}            // postId -> { platformId -> { at, views, likes, comments, shares } }
  },
  settings: {
    requireApproval: true,
    launchAtLogin: false,
    keepRunningInBackground: true,
    xAnalytics: false,            // X charges per read; off by default
    aiHashtag: '#AIgenerated',     // appended when a post is marked AI-generated
    appendAiHashtag: true,
    analyticsIntervalHours: 6,
    maxAttempts: 3,
    onboarded: false,             // first-run setup wizard completed or skipped
    theme: 'midnight'             // midnight | aurora | ultraviolet | ember | daylight
  },
  log: []
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'creator-hub-data.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    this.listeners = new Set();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // merge in any new default keys
      return {
        ...structuredClone(DEFAULT_DATA),
        ...raw,
        settings: { ...DEFAULT_DATA.settings, ...(raw.settings || {}) },
        analytics: { ...structuredClone(DEFAULT_DATA.analytics), ...(raw.analytics || {}) }
      };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // keep a copy of a corrupt file rather than overwriting it silently
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
      }
      return structuredClone(DEFAULT_DATA);
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) { try { fn(); } catch (_) {} }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---------- posts ----------
  listPosts() {
    return [...this.data.posts].sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
  }
  getPost(id) { return this.data.posts.find(p => p.id === id); }

  createPost(input) {
    const now = new Date().toISOString();
    const post = {
      id: crypto.randomUUID(),
      title: input.title || '',
      caption: input.caption || '',
      mediaPath: input.mediaPath || '',
      mediaType: input.mediaType || detectMediaType(input.mediaPath),
      publicMediaUrl: input.publicMediaUrl || '',
      platforms: Array.isArray(input.platforms) ? input.platforms : [],
      overrides: input.overrides || {},
      aiGenerated: !!input.aiGenerated,
      scheduledAt: input.scheduledAt || now,
      status: this.data.settings.requireApproval && !input.preApproved ? 'pending_approval' : 'approved',
      results: {},
      createdAt: now,
      updatedAt: now
    };
    this.data.posts.push(post);
    this.addLog('info', `Post created: "${post.title || post.caption.slice(0, 40)}"`);
    this.save();
    return post;
  }

  updatePost(id, patch) {
    const post = this.getPost(id);
    if (!post) throw new Error('Post not found');
    Object.assign(post, patch, { updatedAt: new Date().toISOString() });
    if (patch.mediaPath !== undefined && patch.mediaType === undefined) post.mediaType = detectMediaType(post.mediaPath);
    this.save();
    return post;
  }

  deletePost(id) {
    this.data.posts = this.data.posts.filter(p => p.id !== id);
    delete this.data.analytics.posts[id];
    this.save();
  }

  // ---------- accounts ----------
  getAccount(pid) { return this.data.accounts[pid] || null; }
  setAccount(pid, value) { this.data.accounts[pid] = value; this.save(); }
  removeAccount(pid) { delete this.data.accounts[pid]; this.save(); }

  // ---------- settings ----------
  updateSettings(patch) { Object.assign(this.data.settings, patch); this.save(); return this.data.settings; }

  // ---------- log ----------
  addLog(level, message) {
    this.data.log.unshift({ at: new Date().toISOString(), level, message });
    this.data.log = this.data.log.slice(0, 500);
  }
}

function detectMediaType(p) {
  if (!p) return 'none';
  const ext = path.extname(p).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.webm'].includes(ext)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  return 'none';
}

module.exports = { Store, detectMediaType, DEFAULT_DATA };
