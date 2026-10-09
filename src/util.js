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

// ---- Loopback OAuth: opens the browser, waits for ?code on 127.0.0.1:<port>/callback/ ----
// Only one sign-in can be waiting at a time: starting a new one cancels the old listener, so a
// second click on "Connect" never fails with "address already in use".
let activeLogin = null;
function cancelPendingSignIn(reason = 'Sign-in was restarted.') { if (activeLogin) activeLogin(new Error(reason)); }

/**
 * @param {object} o
 * @param {(redirectUri:string)=>string} o.buildUrl  builds the provider's authorize URL
 * @param {string} o.state  expected state value
 * @param {number} [o.port] fixed port (registered redirect), or 0 for any free port (Google desktop apps)
 * @returns {Promise<{code:string, redirectUri:string}>}
 */
function loopbackSignIn(opts) {
  const { buildUrl, openExternal, port = OAUTH_PORT, timeoutMs = 10 * 60 * 1000 } = opts; // opts.state is read when the browser returns
  cancelPendingSignIn();
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (!u.pathname.startsWith('/callback')) { res.writeHead(404); return res.end(); }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      const page = (title, msg, ok) => `<!doctype html><meta charset="utf-8"><title>Spektly</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1624;color:#eef1f5;font:16px -apple-system,Segoe UI,sans-serif"><div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:15px;font-weight:700;letter-spacing:-.02em;color:#7fa3cc;margin-bottom:18px">spektly</div><div style="width:56px;height:56px;margin:0 auto;border-radius:50%;display:grid;place-items:center;font-size:28px;background:${ok ? '#4fd1a5' : '#f28b8b'};color:#0b1624">${ok ? '&#10003;' : '!'}</div><h2 style="margin:16px 0 6px">${title}</h2><p style="color:#93a6bd;margin:0">${msg}</p></div></body>`;
      if (err || !code || gotState !== opts.state) {
        res.end(page('Not connected', 'Nothing was changed. Close this window and click Connect in Spektly to try again.', false));
        finish(new Error(err ? `Sign-in was not completed (${err}${u.searchParams.get('error_description') ? ': ' + u.searchParams.get('error_description') : ''}).` : 'Sign-in response did not match. Please try again.'));
      } else {
        res.end(page('Connected', 'Spektly has finished connecting your account. This window closes on its own.', true));
        finish(null, code);
      }
    });
    let done = false;
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Click Connect to try again.')), timeoutMs);
    function finish(e, code) {
      if (done) return; done = true;
      if (activeLogin === finish) activeLogin = null;
      clearTimeout(timer);
      server.close();
      setImmediate(() => server.closeAllConnections?.()); // drop browser keep-alive sockets so the next sign-in gets a fresh listener
      e ? reject(e) : resolve({ code, redirectUri });
    }
    activeLogin = finish;
    server.on('error', e => finish(new Error(e.code === 'EADDRINUSE'
      ? 'Another app is using the sign-in port. Close other Spektly windows and try again.'
      : `Could not start sign-in: ${e.message}`)));
    server.listen(port, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback/`;
      openExternal(buildUrl(redirectUri));
    });
  });
}

// Back-compat helper for providers with a fixed registered redirect (TikTok, X).
async function waitForAuthCode({ authUrl, state, openExternal, timeoutMs }) {
  const { code } = await loopbackSignIn({ buildUrl: () => authUrl, state, openExternal, timeoutMs });
  return code;
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
  randomVerifier, challengeBase64Url, challengeHex, waitForAuthCode, loopbackSignIn, cancelPendingSignIn,
  fileInfo, readChunk, sleep, captionFor
};
