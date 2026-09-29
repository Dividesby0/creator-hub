'use strict';
// Shared helpers: HTTP with readable errors, PKCE, loopback OAuth server.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OAUTH_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/callback/`;

class ApiError extends Error {
  constructor(platform, status, body, message) {
    super(message || `${platform} API error ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 800));
    this.platform = platform;
    this.status = status;
    this.body = body;
  }
}

async function request(platform, url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : {}; } catch (_) { /* keep text */ }
  if (!res.ok) throw new ApiError(platform, res.status, body);
  return { res, body, headers: res.headers, status: res.status };
}

function toForm(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.append(k, String(v));
  return p;
}

// ---- PKCE ----
function randomVerifier(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}
const challengeBase64Url = v => crypto.createHash('sha256').update(v).digest('base64url');
const challengeHex = v => crypto.createHash('sha256').update(v).digest('hex'); // TikTok desktop uses hex

// ---- Loopback OAuth: opens the browser, waits for ?code on 127.0.0.1:8765/callback/ ----
function waitForAuthCode({ authUrl, state, openExternal, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
      if (!u.pathname.startsWith('/callback')) { res.writeHead(404); return res.end(); }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || !code || gotState !== state) {
        res.end('<h2>Connection failed.</h2><p>You can close this tab and try again in Creator Hub.</p>');
        finish(new Error(err ? `Authorization denied: ${err} ${u.searchParams.get('error_description') || ''}` : 'Invalid OAuth response (state mismatch or missing code)'));
      } else {
        res.end('<h2>Connected.</h2><p>You can close this tab and return to Creator Hub.</p>');
        finish(null, code);
      }
    });
    let done = false;
    const timer = setTimeout(() => finish(new Error('Timed out waiting for authorization')), timeoutMs);
    function finish(e, code) {
      if (done) return; done = true;
      clearTimeout(timer);
      server.close();
      e ? reject(e) : resolve(code);
    }
    server.on('error', e => finish(new Error(`Could not start local login listener on port ${OAUTH_PORT}: ${e.message}`)));
    server.listen(OAUTH_PORT, '127.0.0.1', () => openExternal(authUrl));
  });
}

// ---- files ----
function fileInfo(p) {
  const st = fs.statSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'
  }[ext] || 'application/octet-stream';
  return { size: st.size, mime, name: path.basename(p) };
}

// Read [start, end) of a file without loading the whole thing.
function readChunk(p, start, end) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally { fs.closeSync(fd); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// caption = override || caption, plus optional AI hashtag
function captionFor(post, pid, settings, maxLen) {
  let text = (post.overrides?.[pid]?.caption ?? post.caption ?? '').trim();
  if (post.aiGenerated && settings?.appendAiHashtag && settings.aiHashtag && !text.includes(settings.aiHashtag)) {
    text = text ? `${text}\n\n${settings.aiHashtag}` : settings.aiHashtag;
  }
  if (maxLen && text.length > maxLen) throw new Error(`Caption is ${text.length} characters; the limit here is ${maxLen}. Add a shorter override for this platform.`);
  return text;
}

module.exports = {
  OAUTH_PORT, REDIRECT_URI, ApiError, request, toForm,
  randomVerifier, challengeBase64Url, challengeHex, waitForAuthCode,
  fileInfo, readChunk, sleep, captionFor
};
