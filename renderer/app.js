'use strict';
/* Spektly renderer - vanilla JS, no remote code. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => (n ?? 0).toLocaleString();
const fmtDate = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const LIMITS = { x: 280, threads: 500, instagram: 2200, tiktok: 2200, youtube: 5000, facebook: 63206 };
const STATUS_LABEL = { draft: 'Draft', pending_approval: 'Needs approval', approved: 'Scheduled', publishing: 'Publishing', retrying: 'Retrying', published: 'Published', partial_failed: 'Partly failed', failed: 'Failed' };

let S = null;              // app state from main
let view = 'dashboard';
let editing = null;        // post being edited in Compose
let calMonth = new Date(); calMonth.setDate(1);

const pname = id => S.accounts.find(a => a.id === id)?.name || id;
const pcolor = id => `var(--${id})`;
// Platform marks: the real logo in a small app-icon tile, so every channel is recognisable at a glance.
const PLATFORM_ORDER = ['youtube', 'tiktok', 'instagram', 'threads', 'facebook', 'x'];
function pmark(id, size = 'sm') {
  const m = PLATFORM_MARKS[id];
  if (!m) return '';
  return `<span class="pmark pm-${id} ${size}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${m.path}"/></svg></span>`;
}
const chip = (id, extra = '', cls = '') => `<span class="chip ${cls}">${pmark(id, 'xs')}${esc(pname(id))}${extra}</span>`;
const marks = ids => `<span class="markstack">${ids.map(id => pmark(id, 'xs')).join('')}</span>`;

// Turn raw platform/API errors into one plain sentence plus the original text for support.
function friendly(raw, pid) {
  const s = String(raw || ''), n = pid ? pname(pid) : 'The platform';
  const say = text => ({ text, detail: s });
  if (!s) return null;
  if (/invalid_client|client secret is invalid/i.test(s)) return say(`${n} did not accept Spektly's sign-in. Click Connect again; this was fixed in version 2.3.`);
  if (/access_denied|user denied|declined/i.test(s)) return say(`Access was not granted on the ${n} sign-in page. Click Connect and choose Continue or Allow.`);
  if (/window was closed/i.test(s)) return say(`The ${n} sign-in window was closed before it finished. Click Connect to try again.`);
  if (/timed out|restarted/i.test(s)) return say(`The ${n} sign-in was not finished. Click Connect to start it again.`);
  if (/is not a TikTok client key/i.test(s)) return say(s);
  if (/OAuth access token|parse access token|invalid[_ ]token|token.*expired|expired.*token|invalid_grant|\b401\b/i.test(s)) return say(`The saved ${n} sign-in no longer works. Reconnect ${n} to fix it.`);
  if (/\b402\b|credits/i.test(s)) return say(`Your X developer account is out of credits. Add credits in the X developer portal, then retry.`);
  if (/\b429\b|rate limit|too many/i.test(s)) return say(`${n} is limiting how often Spektly can post. It will retry automatically.`);
  if (/\b403\b|permission|scope/i.test(s)) return say(`${n} refused this action. Reconnect and allow every permission on the sign-in page.`);
  if (/ENOTFOUND|ECONN|network|fetch failed|EAI_AGAIN/i.test(s)) return say(`Spektly could not reach ${n}. Check your internet connection; it will retry.`);
  if (/public media URL|publicMediaUrl/i.test(s)) return say(s);
  return say(`${n} returned an error.`);
}
function issue(raw, pid) {
  const f = friendly(raw, pid);
  if (!f) return '';
  return `<div class="issue"><span>${esc(f.text)}</span>${f.detail && f.detail !== f.text ? `<details><summary>Details</summary><code>${esc(f.detail)}</code></details>` : ''}</div>`;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); throw e; }
}

async function refresh() {
  S = await hub.state();
  const pending = S.posts.filter(p => p.status === 'pending_approval').length;
  const b = $('#approvalBadge'); b.hidden = !pending; b.textContent = pending;
  const upcoming = S.posts.filter(p => p.status === 'approved').length;
  const connected = S.accounts.filter(a => a.connected).length;
  const ub = $('#updateBanner');
  if (ub) { ub.hidden = !S.update; if (S.update) ub.innerHTML = `Spektly ${S.update.version} is available. <a data-url="${S.update.url}">Download it</a>. Installing it replaces this version automatically.`; }
  if (S.settings.theme && document.documentElement.dataset.theme !== S.settings.theme) Theme.apply(S.settings.theme);
  renderWizard();
  $('#navStatus').innerHTML = `<div class="navmarks" title="${connected} of 6 channels connected">${PLATFORM_ORDER.map(pid => `<span class="${S.accounts.find(a => a.id === pid)?.connected ? 'on' : ''}">${pmark(pid, 'xs')}</span>`).join('')}</div>
    <div>${upcoming} post${upcoming === 1 ? '' : 's'} scheduled</div><div class="small">Keep Spektly running so posts go out on time.</div><div class="small">Version ${esc(S.version || '')}</div>`;
  render();
}

function go(v) {
  view = v;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  render();
}

function render() {
  if (!S) return;
  const m = $('#main');
  const fn = { dashboard, compose, queue, calendar, approvals, analytics, accounts, settings, insights: Insights.render }[view];
  // Don't clobber a half-typed form on background refreshes
  if ((view === 'compose' || view === 'insights') && m.dataset.view === view && document.activeElement && m.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  m.dataset.view = view;
  m.innerHTML = fn();
  (afterRender[view] || (() => {}))();
}
const afterRender = {};

// ================= Dashboard =================
function setupTrack() {
  const steps = [
    { done: S.accounts.some(a => a.connected), title: 'Connect a channel', body: 'YouTube takes one click with your Google account.', go: 'accounts', cta: 'Open Accounts' },
    { done: S.posts.length > 0, title: 'Write your first post', body: 'One caption, sent to every channel you pick.', go: 'compose', cta: 'Compose' },
    { done: S.posts.some(p => ['approved', 'publishing', 'published', 'partial_failed'].includes(p.status)), title: 'Approve and schedule it', body: 'Nothing goes live until you approve it.', go: 'approvals', cta: 'Approvals' }
  ];
  if (steps.every(x => x.done)) return '';
  const cur = steps.findIndex(x => !x.done);
  return `<section class="track" aria-label="Getting started">${steps.map((x, i) => `
    <div class="track-step ${x.done ? 'done' : i === cur ? 'now' : ''}">
      <span class="tnum">${x.done ? '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>' : i + 1}</span>
      <div><div class="tt">${x.title}</div><div class="muted small">${x.body}</div>
      ${i === cur ? `<button class="btn primary sm" data-go="${x.go}">${x.cta}</button>` : ''}</div>
    </div>`).join('')}</section>`;
}
function weekDays() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(d0); d.setDate(d0.getDate() + i); return d; });
}
function channelBoard() {
  const days = weekDays(), end = new Date(days[6]); end.setDate(end.getDate() + 1);
  const inWeek = S.posts.filter(p => { const t = new Date(p.scheduledAt); return t >= days[0] && t < end; });
  const cell = (pid, d) => inWeek.filter(p => p.platforms.includes(pid) && new Date(p.scheduledAt).toDateString() === d.toDateString())
    .map(p => {
      const r = p.results?.[pid]; const st = r?.status === 'failed' ? 'failed' : r?.status === 'published' ? 'published' : p.status;
      return `<button class="slot st-${st}" data-action="edit" data-id="${p.id}" title="${esc(STATUS_LABEL[st] || st)}: ${esc(p.title || p.caption.slice(0, 60))}">
        <span class="time">${new Date(p.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        <span class="ttl">${esc(p.title || p.caption.slice(0, 40) || 'Untitled')}</span></button>`;
    }).join('');
  const lanes = PLATFORM_ORDER.map(pid => {
    const a = S.accounts.find(x => x.id === pid);
    return `<div class="lane ${a.connected ? '' : 'off'}">
      <div class="lane-head">${pmark(pid, 'md')}<div><div class="ln">${esc(a.name)}</div>
        <div class="small ${a.connected ? 'muted' : ''}">${a.connected ? esc(a.profile?.name || 'Connected') : `<a data-go="accounts">Connect</a>`}</div></div></div>
      ${days.map((d, i) => `<div class="cell ${i === 0 ? 'today' : ''}">${cell(pid, d)}</div>`).join('')}
    </div>`;
  }).join('');
  return `<section class="board" aria-label="This week across your channels">
    <div class="board-top"><div class="lane-head"></div>${days.map((d, i) => `<div class="dh ${i === 0 ? 'today' : ''}"><span>${i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' })}</span><b>${d.getDate()}</b></div>`).join('')}</div>
    ${lanes}</section>`;
}
function dashboard() {
  const posts = S.posts;
  const week = weekDays(); const end = new Date(week[6]); end.setDate(end.getDate() + 1);
  const thisWeek = posts.filter(p => { const t = new Date(p.scheduledAt); return t >= week[0] && t < end && ['approved', 'pending_approval', 'publishing'].includes(p.status); });
  const chans = new Set(thisWeek.flatMap(p => p.platforms));
  const waiting = posts.filter(p => p.status === 'pending_approval').length;
  const failed = posts.filter(p => ['failed', 'partial_failed'].includes(p.status));
  const headline = thisWeek.length
    ? `${thisWeek.length} post${thisWeek.length > 1 ? 's go' : ' goes'} out this week on ${chans.size} channel${chans.size > 1 ? 's' : ''}.`
    : S.accounts.some(a => a.connected) ? 'Nothing is scheduled for the next 7 days.' : 'Connect a channel to start scheduling.';
  return `
  <div class="header"><div><h1>${headline}</h1>
    <div class="muted">${waiting ? `<a data-go="approvals">${waiting} waiting for your approval</a>. ` : ''}Spektly posts on time while it is running on this computer.</div></div>
    <div class="row"><button class="btn" data-action="import">Import batch</button><button class="btn primary" data-go="compose" data-new="1">New post</button></div></div>
  ${setupTrack()}
  ${failed.length ? `<section class="attention"><h2>Needs your attention</h2>${failed.slice(0, 4).map(p => {
    const bad = p.platforms.filter(pid => p.results?.[pid]?.status === 'failed');
    return `<div class="att-row">${marks(bad)}<div class="att-body"><div>${esc(p.title || p.caption.slice(0, 70) || 'Untitled')}</div>
      ${bad.map(pid => issue(p.results[pid].error, pid)).join('')}</div>
      <button class="btn sm primary" data-action="retry" data-id="${p.id}">Retry</button></div>`;
  }).join('')}</section>` : ''}
  ${channelBoard()}`;
}

// ================= Compose =================
function blankPost() {
  const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0);
  return { title: '', caption: '', mediaPath: '', mediaType: 'none', publicMediaUrl: '', platforms: [], overrides: {}, aiGenerated: false, scheduledAt: d.toISOString() };
}
function localInput(iso) { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }

function compose() {
  const p = editing || (editing = blankPost());
  return `
  <div class="header"><div><h1>${p.id ? 'Edit post' : 'Compose'}</h1><div class="muted">One post, many platforms. Override captions per platform where limits differ.</div></div>
    ${p.id ? '<button class="btn" data-action="newPost">Start a new post instead</button>' : ''}</div>
  <div class="grid g2" style="align-items:start">
    <div class="card">
      <label class="field"><span>Title (YouTube title, Facebook video title, and your internal label)</span><input type="text" id="c-title" value="${esc(p.title)}" maxlength="100"></label>
      <label class="field"><span>Caption</span><textarea id="c-caption" rows="7">${esc(p.caption)}</textarea></label>
      <div class="counter" id="c-counter"></div>
      <label class="field" style="margin-top:12px"><span>Media</span>
        <div class="row"><button class="btn" data-action="pickMedia">Choose video or image…</button>
        <span class="muted small" id="c-media">${p.mediaPath ? esc(p.mediaPath) : 'No media (text post)'}</span>
        ${p.mediaPath ? '<a class="small" data-action="clearMedia">remove</a>' : ''}</div></label>
      ${p.mediaPath ? mediaPreview(p) : ''}
      <label class="field"><span>Public media URL (only needed for Instagram images and Threads images/video)</span><input type="url" id="c-public" value="${esc(p.publicMediaUrl)}" placeholder="https://…"></label>
      <label class="field"><span>Publish at</span><input type="datetime-local" id="c-when" value="${localInput(p.scheduledAt)}"></label>
      <label class="check"><input type="checkbox" id="c-ai" ${p.aiGenerated ? 'checked' : ''}> Contains realistic AI-generated or altered media (sets platform AI labels)</label>
    </div>
    <div class="card">
      <h2>Channels</h2>
      <div class="platforms-pick">${PLATFORM_ORDER.map(pid => { const a = S.accounts.find(x => x.id === pid); return `<button class="pp ${p.platforms.includes(pid) ? 'on' : ''} ${a.connected ? '' : 'off'}" data-action="togglePlatform" data-pid="${pid}" aria-pressed="${p.platforms.includes(pid)}">
        ${pmark(pid, 'md')}<span class="pp-txt"><span class="pp-name">${esc(a.name)}</span><span class="pp-meta" data-meter="${pid}">${a.connected ? '' : 'Not connected'}</span></span>
        <span class="pp-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span>
        <span class="pp-bar" data-bar="${pid}"></span></button>`; }).join('')}</div>
      ${p.platforms.some(pid => !S.accounts.find(a => a.id === pid).connected) ? `<div class="issue" style="margin-top:10px"><span>Some picked channels are not connected yet. <a data-go="accounts">Connect them</a> before this post is due, or it will fail there.</span></div>` : ''}
      <div id="c-overrides" style="margin-top:16px">${p.platforms.map(pid => overrideBlock(p, pid)).join('')}</div>
      <div id="c-problems"></div>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" data-action="savePost" data-mode="submit">${S.settings.requireApproval ? 'Save & send for approval' : 'Save & schedule'}</button>
        ${S.settings.requireApproval ? '<button class="btn" data-action="savePost" data-mode="approve">Save & approve</button>' : ''}
        <button class="btn" data-action="savePost" data-mode="draft">Save draft</button>
      </div>
    </div>
  </div>`;
}
function mediaPreview(p) {
  const src = 'file://' + encodeURI(p.mediaPath.replace(/\\/g, '/')).replace(/#/g, '%23');
  return p.mediaType === 'video' ? `<video class="preview" src="${src}" controls preload="metadata"></video>` : p.mediaType === 'image' ? `<img class="preview" src="${src}" alt="">` : '';
}
function overrideBlock(p, pid) {
  const a = S.accounts.find(x => x.id === pid);
  const o = p.overrides[pid] || {};
  const opts = (a.postOptions || []).map(f => f.type === 'select'
    ? `<label class="field"><span>${esc(f.label)}</span><select data-ov="${pid}" data-key="${f.key}">${f.options.map(v => `<option ${((o[f.key] ?? f.default) === v) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`
    : `<label class="field"><span>${esc(f.label)}</span><input type="text" data-ov="${pid}" data-key="${f.key}" value="${esc(o[f.key] || '')}"></label>`).join('');
  return `<details class="card" style="margin-bottom:8px;padding:12px" ${o.caption ? 'open' : ''}><summary>${chip(pid)} <span class="muted small">options & caption override</span></summary>
    <div style="margin-top:10px">${opts}
    <label class="field"><span>Caption override (blank = use main caption, limit ${fmtN(LIMITS[pid])})</span><textarea rows="3" data-ov="${pid}" data-key="caption">${esc(o.caption || '')}</textarea></label></div></details>`;
}
function readCompose() {
  const p = editing;
  p.title = $('#c-title').value;
  p.caption = $('#c-caption').value;
  p.publicMediaUrl = $('#c-public').value.trim();
  const w = $('#c-when').value; if (w) p.scheduledAt = new Date(w).toISOString();
  p.aiGenerated = $('#c-ai').checked;
  for (const el of $$('[data-ov]')) {
    const o = (p.overrides[el.dataset.ov] ||= {});
    const v = el.value.trim();
    if (v) o[el.dataset.key] = v; else delete o[el.dataset.key];
  }
}
function updateCounter() {
  if (!$('#c-caption')) return;
  const base = $('#c-caption').value;
  const ai = $('#c-ai').checked && S.settings.appendAiHashtag ? ('\n\n' + S.settings.aiHashtag).length : 0;
  const over = [];
  for (const pid of PLATFORM_ORDER) {
    const a = S.accounts.find(x => x.id === pid);
    const ov = $(`[data-ov="${pid}"][data-key="caption"]`)?.value;
    const n = (ov || base).length + ai, lim = LIMITS[pid];
    const meta = $(`[data-meter="${pid}"]`), bar = $(`[data-bar="${pid}"]`);
    if (meta) meta.textContent = a.connected ? `${fmtN(n)} / ${fmtN(lim)}` : 'Not connected';
    if (bar) { bar.style.setProperty('--fill', Math.min(1, n / lim)); bar.classList.toggle('over', n > lim); }
    if (n > lim && editing.platforms.includes(pid)) over.push(`${pname(pid)} is ${fmtN(n - lim)} characters over`);
  }
  const hasLink = /https?:\/\/\S+/.test(base);
  $('#c-counter').innerHTML = (over.length ? `<span class="over">${esc(over.join('. '))}. Shorten the caption or add an override for it.</span>` : '')
    + (editing.platforms.includes('x') ? `<span>Posting to X costs about $${hasLink ? '0.20' : '0.015'}${hasLink ? ' because the caption has a link' : ''}.</span>` : '');
}
afterRender.compose = () => updateCounter();
document.addEventListener('input', e => { if (view === 'compose' && e.target.closest('#c-caption, [data-ov], #c-ai')) updateCounter(); });

// ================= Queue =================
function resultChips(p) {
  return p.platforms.map(pid => {
    const r = p.results?.[pid];
    if (!r) return chip(pid);
    if (r.status === 'published') return `<a data-url="${esc(r.url)}" title="Open the live post">${chip(pid, '<span class="cs">posted</span>', 'ok')}</a>`;
    return chip(pid, `<span class="cs">failed${r.attempts > 1 ? `, ${r.attempts} tries` : ''}</span>`, 'bad');
  }).join('');
}
function queue() {
  const groups = [
    ['Needs attention', S.posts.filter(p => ['failed', 'partial_failed', 'retrying'].includes(p.status))],
    ['Upcoming', S.posts.filter(p => ['approved', 'pending_approval', 'publishing'].includes(p.status))],
    ['Drafts', S.posts.filter(p => p.status === 'draft')],
    ['Published', S.posts.filter(p => p.status === 'published').reverse()]
  ];
  return `<div class="header"><div><h1>Queue</h1><div class="muted">Everything you have written, grouped by what it needs next. Click a published channel to open the live post.</div></div>
    <div class="row"><button class="btn" data-action="import">Import batch</button><button class="btn primary" data-go="compose" data-new="1">New post</button></div></div>
  ${groups.map(([name, list]) => list.length ? `<div class="card" style="margin-bottom:14px"><h2>${name} <span class="muted">(${list.length})</span></h2><table>
    <tr><th style="width:140px">When</th><th>Post</th><th style="width:130px">Status</th><th style="width:300px"></th></tr>
    ${list.map(p => `<tr><td>${fmtDate(p.scheduledAt)}</td>
      <td><div>${esc(p.title || p.caption.slice(0, 80) || '(untitled)')}</div>
        <div class="row" style="margin-top:6px">${resultChips(p)}${p.mediaType !== 'none' ? `<span class="muted small">${p.mediaType}</span>` : ''}${p.aiGenerated ? '<span class="muted small">AI label</span>' : ''}</div>
        ${p.platforms.map(pid => p.results?.[pid]?.status === 'failed' ? issue(p.results[pid].error, pid) : p.results?.[pid]?.note ? `<div class="small muted" style="margin-top:4px">${esc(pname(pid))}: ${esc(p.results[pid].note)}</div>` : '').join('')}</td>
      <td><span class="status-pill s-${p.status}">${STATUS_LABEL[p.status] || p.status}</span></td>
      <td><div class="row">${actionsFor(p)}</div></td></tr>`).join('')}
  </table></div>` : '').join('') || `<div class="card empty"><p>No posts yet.</p><button class="btn primary" data-go="compose" data-new="1">Write a post</button></div>`}`;
}
function actionsFor(p) {
  const a = [];
  if (['draft', 'pending_approval', 'approved', 'failed', 'partial_failed', 'retrying'].includes(p.status)) a.push(`<button class="btn sm" data-action="edit" data-id="${p.id}">Edit</button>`);
  if (p.status === 'pending_approval') a.push(`<button class="btn sm primary" data-action="approve" data-id="${p.id}">Approve</button>`);
  if (p.status === 'draft') a.push(`<button class="btn sm" data-action="submit" data-id="${p.id}">Submit</button>`);
  if (['approved', 'pending_approval', 'draft'].includes(p.status)) a.push(`<button class="btn sm" data-action="publishNow" data-id="${p.id}">Post now</button>`);
  if (['failed', 'partial_failed', 'retrying'].includes(p.status)) a.push(`<button class="btn sm primary" data-action="retry" data-id="${p.id}">Retry</button>`);
  a.push(`<button class="btn sm" data-action="duplicate" data-id="${p.id}">Duplicate</button>`);
  if (p.status !== 'publishing') a.push(`<button class="btn sm quiet" data-action="delete" data-id="${p.id}">Delete</button>`);
  return a.join('');
}

// ================= Calendar =================
function calendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const today = new Date().toDateString();
  const days = [];
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  const byDay = {};
  for (const p of S.posts) (byDay[new Date(p.scheduledAt).toDateString()] ||= []).push(p);
  return `<div class="header"><div><h1>${calMonth.toLocaleString([], { month: 'long', year: 'numeric' })}</h1><div class="muted">Click a post to edit it.</div></div>
    <div class="row"><button class="btn" data-action="calPrev">‹</button><button class="btn" data-action="calToday">Today</button><button class="btn" data-action="calNext">›</button></div></div>
  <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('')}
  ${days.map(d => `<div class="day ${d.getMonth() !== m ? 'other' : ''} ${d.toDateString() === today ? 'today' : ''}"><div class="d">${d.getDate()}</div>
    ${(byDay[d.toDateString()] || []).map(p => `<div class="ev ${p.status}" data-action="edit" data-id="${p.id}" title="${esc(STATUS_LABEL[p.status])}">${marks(p.platforms)}<span>${new Date(p.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${esc(p.title || p.caption.slice(0, 30))}</span></div>`).join('')}
  </div>`).join('')}</div>`;
}

// ================= Approvals =================
function approvals() {
  const list = S.posts.filter(p => p.status === 'pending_approval');
  return `<div class="header"><div><h1>Approvals</h1><div class="muted">Nothing goes live until you approve it${S.settings.requireApproval ? '' : ' (approval is currently turned off in Settings)'}.</div></div>
    ${list.length ? `<button class="btn primary" data-action="approveAll">Approve all ${list.length}</button>` : ''}</div>
  ${list.length ? `<div class="grid g2">${list.map(p => `<div class="card">
    <div class="row" style="justify-content:space-between"><h3>${esc(p.title || '(untitled)')}</h3><span class="muted small">${fmtDate(p.scheduledAt)}</span></div>
    ${p.mediaPath ? mediaPreview(p) : ''}
    <p style="white-space:pre-wrap;margin:10px 0">${esc(p.caption)}</p>
    <div class="row" style="margin-bottom:12px">${p.platforms.map(id => chip(id)).join('')}${p.aiGenerated ? '<span class="chip">AI label on</span>' : ''}</div>
    <div class="row"><button class="btn primary" data-action="approve" data-id="${p.id}">Approve</button><button class="btn" data-action="edit" data-id="${p.id}">Edit</button><button class="btn" data-action="reject" data-id="${p.id}">Back to drafts</button></div>
  </div>`).join('')}</div>` : `<div class="card empty"><p>Nothing is waiting for approval.</p><button class="btn" data-go="queue">Open the Queue</button></div>`}`;
}

// ================= Analytics =================
function spark(hist) {
  const vals = hist.map(h => h.followers || 0);
  if (vals.length < 2) return '<div class="muted small">Collecting history…</div>';
  const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${44 - ((v - min) / r) * 40}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 48" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}
function analytics() {
  const acc = S.accounts.filter(a => a.connected);
  const rows = S.posts.filter(p => p.status === 'published' || p.status === 'partial_failed').map(p => {
    const m = S.analytics.posts[p.id] || {};
    const sum = k => Object.values(m).reduce((s, x) => s + (x[k] || 0), 0);
    return { p, m, views: sum('views'), likes: sum('likes'), comments: sum('comments'), shares: sum('shares') };
  }).sort((a, b) => b.views - a.views);
  const maxViews = Math.max(1, ...rows.map(r => r.views));
  const month = new Date().toISOString().slice(0, 7);
  const xCost = S.posts.reduce((s, p) => s + ((p.results?.x?.at || '').startsWith(month) ? (p.results.x.cost || 0) : 0), 0);
  return `<div class="header"><div><h1>Analytics</h1><div class="muted">Refreshes every ${S.settings.analyticsIntervalHours} hours while the app runs.</div></div>
    <button class="btn" data-action="refreshAnalytics">Refresh now</button></div>
  ${acc.length ? '' : '<div class="note info">Connect accounts to start collecting analytics.</div>'}
  <div class="grid g3" style="margin-bottom:14px">${acc.map(a => {
    const h = S.analytics.account[a.id] || [];
    const last = h.at(-1), weekAgo = h.find(x => Date.now() - new Date(x.at) < 7 * 864e5);
    const delta = last && weekAgo ? last.followers - weekAgo.followers : null;
    return `<div class="card stat">${chip(a.id)}<div class="n">${last ? fmtN(last.followers) : 'No data yet'}</div>
      <div class="muted small">${delta == null ? (a.id === 'x' && !S.settings.xAnalytics ? 'X analytics off (reads are billed)' : 'followers') : `${delta >= 0 ? '+' : ''}${fmtN(delta)} this week`}</div>${spark(h.slice(-60))}</div>`;
  }).join('')}</div>
  ${xCost ? `<div class="note info">X API spend this month (posting): about $${xCost.toFixed(2)}.</div>` : ''}
  <div class="card"><h2>Post performance</h2>${rows.length ? `<table><tr><th>Post</th><th>Platforms</th><th class="num">Views</th><th style="width:140px"></th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.p.title || r.p.caption.slice(0, 60))}<div class="muted small">${fmtDate(r.p.scheduledAt)}</div></td>
      <td><div class="row">${Object.keys(r.m).map(id => `<span title="${esc(JSON.stringify(r.m[id]))}">${chip(id)}</span>`).join('') || '<span class="muted small">pending</span>'}</div></td>
      <td class="num">${fmtN(r.views)}</td><td><div class="bar" style="width:${(r.views / maxViews) * 100}%"></div></td>
      <td class="num">${fmtN(r.likes)}</td><td class="num">${fmtN(r.comments)}</td><td class="num">${fmtN(r.shares)}</td></tr>`).join('')}</table>` : '<div class="empty">Published posts will show up here.</div>'}</div>`;
}

// ================= Accounts =================
const DEV_PORTALS = {
  youtube: 'https://console.cloud.google.com/apis/credentials',
  tiktok: 'https://developers.tiktok.com/apps',
  instagram: 'https://developers.facebook.com/apps',
  threads: 'https://developers.facebook.com/apps',
  facebook: 'https://developers.facebook.com/apps',
  x: 'https://developer.x.com/en/portal/dashboard'
};
const CONNECT_COPY = {
  youtube: 'Post videos and see YouTube, Google Analytics, Search Console and Business Profile stats with one Google sign-in.',
  tiktok: 'Send videos to TikTok as drafts or post them directly.',
  instagram: 'Post Reels and photos to your Instagram professional account.',
  threads: 'Post text, photos and videos to Threads.',
  facebook: 'Post to your Facebook Page.',
  x: 'Post to X (X bills a small fee per post).'
};
const ONE_CLICK_COPY = CONNECT_COPY;
function connectButton(a) {
  if (a.oneClick && a.provider === 'google') return `<button class="btn gbtn" data-action="connectOneClick" data-pid="${a.id}">${pmark('google', 'g')}Connect with Google</button>`;
  if (a.oneClick) return `<button class="btn primary" data-action="connectOneClick" data-pid="${a.id}">Connect ${esc(a.name)}</button>`;
  return `<button class="btn" data-action="assist" data-pid="${a.id}">Set up ${esc(a.name)}</button>`;
}
function ownKeysForm(a) {
  return `<form data-account="${a.id}">
    ${a.configFields.map(f => f.type === 'select'
      ? `<label class="field"><span>${esc(f.label)}</span><select name="${f.key}">${f.options.map(o => `<option ${(f.value || f.default) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>${f.help ? `<div class="muted small" style="margin-top:4px">${esc(f.help)}</div>` : ''}</label>`
      : `<label class="field"><span>${esc(f.label)}</span><input type="${f.secret ? 'password' : 'text'}" name="${f.key}" value="${esc(f.value)}" placeholder="${f.secret && f.hasValue ? '•••••• saved (leave blank to keep)' : ''}" autocomplete="off">${f.help ? `<div class="muted small" style="margin-top:4px">${esc(f.help)}</div>` : ''}</label>`).join('')}
    </form>`;
}
function accountRow(a) {
  const state = a.connected ? `<span class="state on">Connected as ${esc(a.profile?.name || 'your account')}</span>` : `<span class="state">Not connected</span>`;
  const actions = a.connected
    ? `<button class="btn sm" data-action="${a.oneClick ? 'connectOneClick' : 'assist'}" data-pid="${a.id}">Reconnect</button><button class="btn sm quiet" data-action="disconnect" data-pid="${a.id}">Disconnect</button>`
    : connectButton(a);
  return `<div class="chan ${a.connected ? 'is-on' : ''}">
    ${pmark(a.id, 'lg')}
    <div class="chan-body">
      <div class="chan-title"><h3>${esc(a.name)}</h3>${state}</div>
      <p class="muted small">${esc(CONNECT_COPY[a.id] || '')}</p>
      ${!a.connected && a.lastError ? issue(a.lastError, a.id) : ''}
      ${a.oneClick && !a.connected ? '' : !a.oneClick && !a.connected ? '<p class="muted small hint">Needs a free developer app from the platform, about five minutes once. Set up walks you through it.</p>' : ''}
    </div>
    <div class="chan-act">${actions}${a.oneClick ? `<a class="small muted" data-action="assist" data-pid="${a.id}">Use my own developer keys</a>` : ''}</div>
  </div>`;
}
function accounts() {
  const n = S.accounts.filter(a => a.connected).length;
  return `<div class="header"><div><h1>${n ? `${n} of 6 channels connected` : 'Connect your channels'}</h1><div class="muted">Sign-ins are encrypted on this computer and only used to talk to each platform.</div></div>
    <button class="btn" data-action="runSetup">Run setup again</button></div>
  <div class="chans">${PLATFORM_ORDER.map(pid => accountRow(S.accounts.find(a => a.id === pid))).join('')}</div>`;
}

// ================= Guided setup for platforms without one-click sign-in =================
const REDIRECT = 'http://127.0.0.1:8765/callback/';
const ASSIST = {
  youtube: { portal: 'https://console.cloud.google.com/apis/credentials', steps: [
    'Open Google Cloud Console and create a project.',
    'Enable YouTube Data API v3 and YouTube Analytics API.',
    'Create an OAuth client ID of type <b>Desktop app</b>.',
    'Paste the Client ID and Client secret below.'] },
  tiktok: { portal: 'https://developers.tiktok.com/apps', steps: [
    'Open TikTok for Developers and click <b>Connect an app</b>.',
    'Add the <b>Login Kit</b> and <b>Content Posting API</b> products.',
    'Under Login Kit, choose Desktop and add this redirect URI:{copy}',
    'Request scopes user.info.basic, user.info.stats, video.upload, video.publish and video.list.',
    'In Sandbox, add your TikTok account as a target user.',
    'Paste the Client key and Client secret below.'] },
  instagram: { portal: 'https://developers.facebook.com/apps', steps: [
    'Make sure your Instagram account is a Professional (Creator or Business) account.',
    'Open Meta for Developers, create an app and add the <b>Instagram</b> product.',
    'Under API setup with Instagram login, add your account and click <b>Generate token</b>.',
    'Paste the token below. Leave the account ID blank: Spektly finds it.'] },
  threads: { portal: 'https://developers.facebook.com/apps', steps: [
    'Open Meta for Developers and create an app with the <b>Threads API</b> use case.',
    'Add threads_basic, threads_content_publish and threads_manage_insights.',
    'Under App roles, add your Threads account as a tester, then accept it in Threads: Settings, Account, Website permissions.',
    'Generate a user token and paste it below. Spektly keeps it fresh.'] },
  facebook: { portal: 'https://developers.facebook.com/tools/explorer/', steps: [
    'Open Graph API Explorer and pick your app.',
    'Add pages_show_list, pages_manage_posts, pages_read_engagement and read_insights, then click <b>Generate Access Token</b>.',
    'In the User or Page menu, choose your Page. Copy its Page ID and access token.',
    'Paste both below.'] },
  x: { portal: 'https://developer.x.com/en/portal/dashboard', steps: [
    'Open the X Developer Portal and select your app.',
    'In User authentication settings, choose <b>OAuth 2.0</b>, type <b>Native App</b>, permissions <b>Read and write</b>.',
    'Add this callback URI:{copy}',
    'Copy the OAuth 2.0 Client ID from Keys and tokens and paste it below. X bills a small fee per post.'] }
};
const Assist = {
  open(pid) {
    const a = S.accounts.find(x => x.id === pid), g = ASSIST[pid];
    const copy = `<div class="copyfield"><code>${REDIRECT}</code><button class="btn sm" data-action="copy" data-text="${REDIRECT}">Copy</button></div>`;
    const html = `<p class="muted" style="margin-top:0">${a.oneClick ? `Only needed if you want to use your own ${esc(a.name)} developer app instead of one-click sign-in.` : `About five minutes, once. Spektly remembers it after that.`}</p>
      <ol class="steps-list">${g.steps.map(t => `<li>${t.replace('{copy}', copy)}</li>`).join('')}</ol>
      <div class="row" style="margin:2px 0 16px"><button class="btn" data-url="${g.portal}">Open ${esc(a.name)} developer site</button></div>
      ${ownKeysForm(a)}
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-action="connect" data-pid="${a.id}">${a.auth === 'oauth' ? 'Save and sign in' : 'Save and connect'}</button></div>`;
    Modal.open({ id: 'assist', title: `Set up ${esc(a.name)}`, html, wide: true });
  }
};

// ================= First-run setup (modal over the animated background) =================
let wizStep = 0;
const WIZ_STEPS = 5;
function wizardHtml() {
  const bar = `<div class="wiz-steps" aria-label="Step ${wizStep + 1} of ${WIZ_STEPS}">${Array.from({ length: WIZ_STEPS }, (_, i) => `<i class="${i === wizStep ? 'on' : i < wizStep ? 'done' : ''}"></i>`).join('')}</div>`;
  const nav = (back, next, nextLabel = 'Continue') => `<div class="row" style="justify-content:space-between;margin-top:24px">
    ${back ? '<button class="btn" data-action="wizBack">Back</button>' : '<span></span>'}
    <div class="row" style="gap:14px"><a class="small muted" data-action="wizSkip">Skip setup</a>${next ? `<button class="btn primary" data-action="wizNext">${nextLabel}</button>` : ''}</div></div>`;
  let body = '';
  if (wizStep === 0) {
    body = `<div style="text-align:center;padding:6px 0 4px">${FX.mark('mark')}</div>
      <h1 style="text-align:center">Welcome to Spektly</h1>
      <p class="muted" style="font-size:15px;line-height:1.6;text-align:center;max-width:46ch;margin:8px auto 0">Plan, approve and publish to every channel from one place, then see all your numbers together. Setup takes about two minutes.</p>
      ${nav(false, true, 'Get started')}`;
  } else if (wizStep === 1) {
    const g = S.accounts.filter(a => a.oneClick || a.assist), done = S.accounts.filter(a => a.connected).length;
    body = `<h1>Connect your accounts</h1>
      <p class="muted">Click Connect, sign in, then click Allow. Sign-ins stay encrypted on this computer.</p>
      ${S.accounts.map(a => `<div class="wiz-acct ${a.connected ? 'ok' : ''}"><div>${chip(a.id)}<div class="muted small" style="margin-top:6px">${esc(CONNECT_COPY[a.id] || '')}</div>${a.lastError && !a.connected ? `<div class="small" style="color:var(--bad);margin-top:4px">${esc(a.lastError)}</div>` : ''}</div>
        ${a.connected ? `<span class="small" style="color:var(--ok)">Connected as ${esc(a.profile?.name)}</span>` : connectButton(a)}</div>`).join('')}
      ${nav(true, true, done ? 'Continue' : 'Continue without connecting')}`;
  } else if (wizStep === 2) {
    const st = S.settings;
    const opt = (k, title, help) => `<label class="wiz-opt"><input type="checkbox" data-setting="${k}" ${st[k] ? 'checked' : ''}><div><b>${title}</b><div class="muted small">${help}</div></div></label>`;
    body = `<h1>How should posting work?</h1>
      ${opt('requireApproval', 'Let me approve posts before they go out', 'Recommended. New posts wait in Approvals until you click Approve.')}
      ${opt('keepRunningInBackground', 'Keep posting when the window is closed', 'Spektly stays in the menu bar and posts on schedule.')}
      ${opt('launchAtLogin', 'Start Spektly when I turn on my computer', 'So scheduled posts are never missed.')}
      ${nav(true, true)}`;
  } else if (wizStep === 3) {
    body = `<h1>Pick a look</h1><p class="muted">You can change this any time in Settings.</p>${Theme.picker(S.settings.theme || 'spektly')}${nav(true, true)}`;
  } else {
    const n = S.accounts.filter(a => a.connected).length;
    body = `<h1>You're all set</h1>
      <p class="muted" style="font-size:15px">${n ? `${n} account${n > 1 ? 's' : ''} connected.` : 'You can connect accounts any time in Accounts.'} Where would you like to start?</p>
      <div class="grid g3" style="margin-top:14px">
        <div class="card wiz-card" data-action="wizFinish" data-to="compose"><h3>Write your first post</h3><div class="muted small">Write once, post everywhere.</div></div>
        <div class="card wiz-card" data-action="wizFinish" data-to="insights"><h3>See your numbers</h3><div class="muted small">Every channel in one dashboard.</div></div>
        <div class="card wiz-card" data-action="wizFinish" data-to="dashboard"><h3>Open the dashboard</h3><div class="muted small">Your schedule at a glance.</div></div>
      </div>
      ${nav(true, false)}`;
  }
  return bar + `<div class="wiz-body">${body}</div>`;
}
function openWizard() {
  document.body.classList.add('fx-on');
  FX.start($('#bgfx'), { intensity: 0.8 });
  if (!Modal.body('wizard')) Modal.open({ id: 'wizard', html: wizardHtml(), wide: true, dismissable: false });
  else renderWizard();
}
function renderWizard() { const b = Modal.body('wizard'); if (b) b.innerHTML = wizardHtml(); }
async function closeWizard(to) {
  await hub.onboarding.finish();
  Modal.closeAll();
  document.body.classList.remove('fx-on');
  setTimeout(() => FX.stop($('#bgfx')), 600);
  await refresh(); editing = null; go(to || 'dashboard');
}

// ================= Settings =================
function settings() {
  const s = S.settings, L = S.license;
  const tog = (k, label, help) => `<label class="check" style="margin-bottom:10px"><input type="checkbox" data-setting="${k}" ${s[k] ? 'checked' : ''}> <span>${label}${help ? `<div class="muted small">${help}</div>` : ''}</span></label>`;
  return `<div class="header"><div><h1>Settings</h1></div></div>
  <div class="card" style="margin-bottom:14px"><h2>Appearance</h2>${Theme.picker(s.theme || 'spektly')}</div>
  <div class="grid g2" style="align-items:start">
    <div class="card"><h2>Publishing</h2>
      ${tog('requireApproval', 'Require approval before anything posts', 'New and imported posts wait in Approvals.')}
      ${tog('keepRunningInBackground', 'Keep running in the background when the window is closed', 'Scheduled posts only go out while Spektly is running.')}
      ${tog('launchAtLogin', 'Start Spektly when I log in')}
      ${tog('appendAiHashtag', 'Add an AI-disclosure hashtag to AI-labelled posts')}
      <label class="field"><span>AI hashtag</span><input type="text" data-setting-text="aiHashtag" value="${esc(s.aiHashtag)}"></label>
      <label class="field"><span>Retry attempts per platform</span><input type="number" min="1" max="10" data-setting-num="maxAttempts" value="${s.maxAttempts}"></label>
      <h2 style="margin-top:18px">Analytics</h2>
      ${tog('xAnalytics', 'Fetch X analytics', 'X bills every read (about $0.005 per post read). Off by default.')}
      <label class="field"><span>Refresh every (hours)</span><input type="number" min="1" max="48" data-setting-num="analyticsIntervalHours" value="${s.analyticsIntervalHours}"></label>
    </div>
    <div class="card"><h2>License</h2>
      ${L.active ? `<table>
        <tr><td class="muted">Edition</td><td>${esc(L.license.tierName)}</td></tr>
        <tr><td class="muted">License</td><td><code>${esc(L.license.key)}</code><div class="muted small">Serial #${L.license.serial}</div></td></tr>
        <tr><td class="muted">Devices allowed</td><td>${L.license.maxDevices}</td></tr>
        <tr><td class="muted">Updates until</td><td>${L.license.updatesUntil || 'Lifetime'}</td></tr>
        <tr><td class="muted">Expires</td><td>${L.license.expires || 'Never (perpetual)'}</td></tr>
        <tr><td class="muted">This device</td><td><code>${esc(L.device)}</code></td></tr></table>
        <div class="row" style="margin-top:12px"><button class="btn danger" data-action="deactivate">Deactivate this device</button></div>
        <div class="muted small" style="margin-top:6px">Deactivating frees this seat so you can move your license to another computer.</div>` : ''}
      <h2 style="margin-top:18px">About</h2>
      <div class="muted small" style="line-height:1.9">${esc(S.brand?.name || 'Spektly')} ${esc(S.version)} by ${esc(S.brand?.publisher || '')}<br>
        <a data-url="${esc(S.brand?.siteUrl || '')}">Website</a> &nbsp; <a data-url="${esc(S.brand?.privacyUrl || '')}">Privacy policy</a> &nbsp; <a data-url="${esc(S.brand?.termsUrl || '')}">Terms</a> &nbsp; <a data-url="mailto:${esc(S.brand?.supportEmail || '')}">Contact support</a></div>
      <h2 style="margin-top:18px">Activity log</h2>
      <div class="log">${S.log.map(l => `<div class="${l.level}"><span class="muted">${fmtDate(l.at)}</span> ${esc(l.message)}</div>`).join('') || '<div class="muted">No activity yet.</div>'}</div>
    </div>
  </div>`;
}

// ================= Events =================
document.addEventListener('click', async e => {
  const th = e.target.closest('[data-theme-pick]');
  if (th) { Theme.apply(th.dataset.themePick); await hub.settings.update({ theme: th.dataset.themePick }); await refresh(); return; }
  const ins = e.target.closest('[data-ins],[data-ins-tab],[data-ins-days]');
  if (ins) return Insights.onClick(ins);
  const t = e.target.closest('[data-go],[data-action],[data-url],#nav button');
  if (!t) return;
  if (t.matches('#nav button')) { if (t.dataset.view === 'compose' && editing?.id) editing = null; return go(t.dataset.view); }
  if (t.dataset.url) { e.preventDefault(); return hub.openUrl(t.dataset.url); }
  if (t.dataset.go) { if (t.dataset.new || t.dataset.go === 'compose') editing = null; return go(t.dataset.go); }
  const id = t.dataset.id, pid = t.dataset.pid;
  switch (t.dataset.action) {
    case 'import': {
      const r = await run(() => hub.importBatch());
      if (r) { const bad = r.filter(x => x.problems.length); toast(`Imported ${r.length} post(s).${bad.length ? ` ${bad.length} need attention (check Accounts/media).` : ''}`, !!bad.length); await refresh(); }
      break;
    }
    case 'newPost': editing = null; render(); break;
    case 'pickMedia': {
      readCompose();
      const f = await hub.pickMedia();
      if (f) { editing.mediaPath = f; editing.mediaType = /\.(mp4|mov|m4v|webm)$/i.test(f) ? 'video' : 'image'; }
      render(); break;
    }
    case 'clearMedia': readCompose(); editing.mediaPath = ''; editing.mediaType = 'none'; render(); break;
    case 'togglePlatform': {
      readCompose();
      const i = editing.platforms.indexOf(pid);
      if (i >= 0) editing.platforms.splice(i, 1); else editing.platforms.push(pid);
      render(); break;
    }
    case 'savePost': {
      readCompose();
      const mode = t.dataset.mode;
      if (!editing.caption.trim() && editing.mediaType === 'none') return toast('Add a caption or media.', true);
      const input = { ...editing };
      let res;
      if (editing.id) res = await run(() => hub.posts.update(editing.id, { title: input.title, caption: input.caption, mediaPath: input.mediaPath, mediaType: input.mediaType, publicMediaUrl: input.publicMediaUrl, platforms: input.platforms, overrides: input.overrides, aiGenerated: input.aiGenerated, scheduledAt: input.scheduledAt, results: editing.status === 'published' ? editing.results : {} }));
      else res = await run(() => hub.posts.create(input));
      const post = res.post;
      if (mode === 'draft') await hub.posts.reject(post.id);
      else if (mode === 'approve') await hub.posts.approve(post.id);
      else await hub.posts.submit(post.id);
      if (res.problems.length && mode !== 'draft') toast('Saved, but: ' + res.problems.join(' '), true);
      else toast(mode === 'draft' ? 'Draft saved.' : mode === 'approve' || !S.settings.requireApproval ? 'Scheduled.' : 'Sent for approval.');
      editing = null; await refresh(); go('queue'); break;
    }
    case 'edit': editing = structuredClone(S.posts.find(p => p.id === id)); go('compose'); break;
    case 'approve': await run(() => hub.posts.approve(id), 'Approved.'); await refresh(); break;
    case 'approveAll': await run(() => hub.posts.approve(S.posts.filter(p => p.status === 'pending_approval').map(p => p.id)), 'All approved.'); await refresh(); break;
    case 'reject': await run(() => hub.posts.reject(id)); await refresh(); break;
    case 'submit': await run(() => hub.posts.submit(id)); await refresh(); break;
    case 'publishNow': {
      const probs = await hub.posts.validate(id);
      if (probs.length) return toast(probs.join(' '), true);
      if (!await Modal.confirm('It goes out right away to every platform selected on this post.', { title: 'Publish now?', ok: 'Publish now' })) return;
      toast('Publishing…'); await run(() => hub.posts.publishNow(id)); await refresh(); break;
    }
    case 'retry': await run(() => hub.posts.retry(id), 'Retrying now.'); await refresh(); break;
    case 'duplicate': await run(() => hub.posts.duplicate(id), 'Duplicated for tomorrow.'); await refresh(); break;
    case 'delete': if (await Modal.confirm('Posts that already went out stay live on the platforms.', { title: 'Delete this post from Spektly?', ok: 'Delete', danger: true })) { await run(() => hub.posts.remove(id)); await refresh(); } break;
    case 'calPrev': calMonth.setMonth(calMonth.getMonth() - 1); render(); break;
    case 'calNext': calMonth.setMonth(calMonth.getMonth() + 1); render(); break;
    case 'calToday': calMonth = new Date(); calMonth.setDate(1); render(); break;
    case 'refreshAnalytics': toast('Refreshing analytics…'); await run(() => hub.analytics.refresh(), 'Analytics updated.'); await refresh(); break;
    case 'copy': navigator.clipboard?.writeText(t.dataset.text).then(() => toast('Copied.')); break;
    case 'connect': {
      const form = $(`form[data-account="${pid}"]`);
      const values = Object.fromEntries(new FormData(form).entries());
      await run(() => hub.accounts.save(pid, values));
      if (S.accounts.find(a => a.id === pid).auth === 'oauth') toast('Your browser will open so you can sign in.');
      try { const p = await run(() => hub.accounts.connect(pid)); toast(`Connected as ${p.name}.`); Modal.closeById('assist'); } catch (_) {}
      await refresh(); break;
    }
    case 'connectOneClick': {
      toast('Your browser will open. Sign in and click Allow.');
      try { const p = await run(() => hub.accounts.connect(pid)); toast(`Connected as ${p.name}.`); } catch (_) {}
      await refresh(); break;
    }
    case 'wizNext': wizStep = Math.min(WIZ_STEPS - 1, wizStep + 1); renderWizard(); break;
    case 'wizBack': wizStep = Math.max(0, wizStep - 1); renderWizard(); break;
    case 'wizSkip': await closeWizard('dashboard'); break;
    case 'wizFinish': await closeWizard(t.dataset.to); break;
    case 'runSetup': await hub.onboarding.restart(); await refresh(); wizStep = 0; openWizard(); break;
    case 'assist': Assist.open(pid); break;
    case 'disconnect': if (await Modal.confirm('Scheduled posts to this account will fail until you connect it again.', { title: `Disconnect ${esc(pname(pid))}?`, ok: 'Disconnect', danger: true })) { await run(() => hub.accounts.disconnect(pid)); await refresh(); } break;
    case 'deactivate': if (await Modal.confirm('You will need your license key to activate Spektly on this computer again.', { title: 'Deactivate this computer?', ok: 'Deactivate', danger: true })) await run(() => hub.license.deactivate()); break;
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.insSelect) return Insights.onChange(t);
  if (t.dataset.setting) { await run(() => hub.settings.update({ [t.dataset.setting]: t.checked })); await refresh(); }
  if (t.dataset.settingText) { await run(() => hub.settings.update({ [t.dataset.settingText]: t.value.trim() })); }
  if (t.dataset.settingNum) { const n = Math.max(1, Number(t.value) || 1); await run(() => hub.settings.update({ [t.dataset.settingNum]: n })); }
});

hub.on('state-changed', () => refresh());
hub.on('toast', m => toast(m));
// Startup: animated splash while the app loads (at least ~1.3s so it never flashes).
$('#navMark').innerHTML = FX.mark('mark');
$('#splashMark').innerHTML = FX.mark('mark');
FX.start($('#splashfx'));
const splashMin = new Promise(r => setTimeout(r, 1300));
Promise.all([refresh(), splashMin]).then(() => {
  go('dashboard');
  $('#splash').classList.add('gone');
  setTimeout(() => FX.stop($('#splashfx')), 700);
  if (!S.settings.onboarded) setTimeout(openWizard, 350);
});
