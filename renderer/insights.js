'use strict';
/* Creator Hub — Insights: all-in-one metrics & reporting. Loaded before app.js; uses its globals at call time. */
const Insights = (() => {
  let days = 28, tab = 'overview', report = null, loading = false, error = null;
  const COLORS = { a: '#5b8cff', b: '#2fbf71', c: '#f0a830', d: '#e1306c', muted: '#9aa3b2' };
  const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- formatting ----------
  const num = (v, d = 0) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const compact = v => v == null || isNaN(v) ? '—' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : num(v);
  const pctv = v => v == null || isNaN(v) ? '—' : (v * 100).toFixed(1) + '%';
  const dur = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const FMT = {
    views: compact, watchHours: v => num(v, 1), avgViewDuration: dur, netSubscribers: v => (v > 0 ? '+' : '') + num(v), likes: compact, comments: compact, shares: compact,
    engagementRate: pctv, activeUsers: compact, newUsers: compact, sessions: compact, screenPageViews: compact, averageSessionDuration: dur,
    clicks: compact, impressions: compact, ctr: pctv, position: v => num(v, 1), searchViews: compact, mapsViews: compact, websiteClicks: compact,
    calls: compact, directions: compact, messages: compact, posts: num, engagement: compact
  };
  const LABEL = {
    views: 'Views', watchHours: 'Watch hours', avgViewDuration: 'Avg view duration', netSubscribers: 'Net subscribers', likes: 'Likes', comments: 'Comments', shares: 'Shares',
    engagementRate: 'Engagement rate', activeUsers: 'Visitors', newUsers: 'New visitors', sessions: 'Sessions', screenPageViews: 'Page views', averageSessionDuration: 'Avg session',
    clicks: 'Search clicks', impressions: 'Impressions', ctr: 'Click-through rate', position: 'Avg position', searchViews: 'Search views', mapsViews: 'Maps views',
    websiteClicks: 'Website clicks', calls: 'Calls', directions: 'Direction requests', messages: 'Messages', posts: 'Posts published', engagement: 'Engagement'
  };
  const INVERSE = new Set(['position']); // lower is better

  function deltaPill(d, key) {
    if (d == null || isNaN(d)) return '<span class="dpill flat">new</span>';
    const good = INVERSE.has(key) ? d < 0 : d > 0;
    const cls = Math.abs(d) < 0.005 ? 'flat' : good ? 'up' : 'down';
    return `<span class="dpill ${cls}">${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%</span>`;
  }
  const tile = (key, t, label) => t ? `<div class="kpi"><div class="muted small">${e(label || LABEL[key] || key)}</div><div class="kv">${(FMT[key] || compact)(t.value)}</div>${deltaPill(t.delta, key)} <span class="muted small">vs ${(FMT[key] || compact)(t.prev)}</span></div>` : '';

  // ---------- charts (pure SVG, theme-aware; `light` for PDF) ----------
  function lineChart(series, lines, { height = 190, light = false, width = 760 } = {}) {
    if (!series?.length) return `<div class="empty small">No data for this period yet.</div>`;
    const pad = { l: 46, r: 12, t: 12, b: 24 };
    const W = width, H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = Math.max(1, ...lines.flatMap(l => series.map(s => +s[l.key] || 0)));
    const x = i => pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
    const y = v => pad.t + ih - (v / max) * ih;
    const grid = light ? '#e5e7eb' : 'var(--line)', txt = light ? '#6b7280' : 'var(--muted)';
    const ticks = [0, 0.5, 1].map(f => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="${grid}" stroke-width="1"/><text x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end" font-size="10" fill="${txt}">${compact(max * f)}</text>`).join('');
    const paths = lines.map(l => {
      const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(+s[l.key] || 0).toFixed(1)}`).join(' ');
      const area = `${pad.l},${pad.t + ih} ${pts} ${x(series.length - 1)},${pad.t + ih}`;
      return (l.fill ? `<polygon points="${area}" fill="${l.color}" opacity="0.10"/>` : '') + `<polyline points="${pts}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }).join('');
    const xl = `<text x="${pad.l}" y="${H - 6}" font-size="10" fill="${txt}">${e(series[0].date)}</text><text x="${W - pad.r}" y="${H - 6}" font-size="10" text-anchor="end" fill="${txt}">${e(series.at(-1).date)}</text>`;
    const legend = lines.map(l => `<span class="lg"><i style="background:${l.color}"></i>${e(l.label)}</span>`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img">${ticks}${paths}${xl}</svg><div class="legend">${legend}</div></div>`;
  }

  function bars(items, labelKey, valueKey, { fmt = compact, color = COLORS.a, light = false } = {}) {
    if (!items?.length) return '<div class="empty small">No data.</div>';
    const max = Math.max(1, ...items.map(i => +i[valueKey] || 0));
    return `<div class="bars">${items.map(i => `<div class="barrow"><div class="bl" title="${e(i[labelKey])}">${e(i[labelKey])}</div><div class="bt"><div class="bf" style="width:${((+i[valueKey] || 0) / max) * 100}%;background:${color}"></div></div><div class="bv">${fmt(+i[valueKey])}</div></div>`).join('')}</div>`;
  }

  function table(rows, cols) {
    if (!rows?.length) return '<div class="empty small">No data.</div>';
    return `<table><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${e(c.label)}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : e(r[c.key])}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  // ---------- data ----------
  async function load(force = false) {
    loading = true; error = null; rerender();
    try { report = await hub.insights.refresh(days, force); }
    catch (err) { error = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    loading = false; rerender();
  }
  const rerender = () => { if (typeof view !== 'undefined' && view === 'insights') render(); };
  const src = k => report?.google?.sources?.[k];

  // ---------- views ----------
  function connectCard(iv) {
    const own = `<div class="grid g2"><label class="field"><span>OAuth Client ID (Desktop app)</span><input type="text" id="g-cid" value="${e(iv.clientId)}" placeholder="${iv.usingYouTubeClient ? 'using YouTube client' : ''}"></label>
      <label class="field"><span>OAuth Client Secret</span><input type="password" id="g-cs" placeholder="${iv.hasClient && !iv.oneClick ? '•••••• saved' : ''}"></label></div>
      <ol class="small muted" style="line-height:1.7">
        <li>Google Cloud Console → APIs &amp; Services → <b>Enable</b>: YouTube Data API v3, YouTube Analytics API, Google Analytics Data API, Google Analytics Admin API, Google Search Console API, and the three Business Profile APIs.</li>
        <li>Credentials → OAuth client ID → type <b>Desktop app</b>. Redirect is handled automatically (<code>http://127.0.0.1:8765/callback/</code>).</li>
        <li>OAuth consent screen → add your Google account as a test user, or publish the app.</li></ol>`;
    const status = iv.connected ? `<span class="small" style="color:var(--ok)">✓ Connected as ${e(iv.email)}</span><button class="btn danger sm" data-ins="disconnect">Disconnect</button>` : '';
    if (iv.oneClick) {
      return `<div class="card" style="margin-bottom:14px"><h2>Connect Google</h2>
        <p class="muted">One sign-in unlocks <b>YouTube Analytics</b>, <b>Google Analytics</b> (your website), <b>Search Console</b> (how people find you on Google) and <b>Business Profile</b> (Maps &amp; Search). It's the same sign-in as YouTube posting, so if YouTube is connected you're already set. Read-only — Creator Hub never changes anything.</p>
        <div class="row"><button class="btn primary" data-ins="connect">${iv.connected ? 'Reconnect Google' : 'Connect Google'}</button>${status}</div>
        <details style="margin-top:12px"><summary class="muted small">Use my own Google developer keys (advanced)</summary><div style="margin-top:10px">${own}</div></details></div>`;
    }
    return `<div class="card" style="margin-bottom:14px"><h2>Connect Google</h2>
      <p class="muted">One sign-in unlocks <b>YouTube Analytics</b>, <b>Google Analytics 4</b>, <b>Search Console</b> and <b>Business Profile</b>. Read-only.</p>
      ${iv.usingYouTubeClient ? '<div class="note info">Using the Google keys from your YouTube connection.</div>' : ''}
      ${own}
      <div class="row"><button class="btn primary" data-ins="connect">${iv.connected ? 'Reconnect Google' : 'Save & sign in with Google'}</button>${status}</div></div>`;
  }

  function pickers(iv) {
    const r = iv.resources || { ga4: [], gsc: [], gbp: [], errors: {} };
    const sel = (key, list, label, err) => `<label class="field"><span>${label}</span>${list?.length
      ? `<select data-ins-select="${key}"><option value="">— not used —</option>${list.map(o => `<option value="${e(o.id)}" ${iv.selections[key] === o.id ? 'selected' : ''}>${e(o.name)}</option>`).join('')}</select>`
      : `<div class="small muted" style="padding:9px 0">${e(err || 'None found for this Google account.')}</div>`}</label>`;
    return `<div class="card" style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Data sources</h3><div class="row"><span class="small muted">${r.youtube ? 'YouTube: ' + e(r.youtube.name) : e(r.errors?.youtube || '')}</span><button class="btn sm" data-ins="resources">Re-scan</button></div></div>
      <div class="grid g3" style="margin-top:10px">${sel('ga4Property', r.ga4, 'Google Analytics 4 property', r.errors?.ga4)}${sel('gscSite', r.gsc, 'Search Console site', r.errors?.gsc)}${sel('gbpLocation', r.gbp, 'Business Profile location', r.errors?.gbp)}</div></div>`;
  }

  function sourceError(k, name) {
    const s = src(k);
    if (!report?.google) return `<div class="note info">Connect Google above to see ${name}.</div>`;
    if (!s) return `<div class="note info">Choose a ${name} source in “Data sources” above.</div>`;
    if (!s.ok) return `<div class="note">${e(s.error)}</div>`;
    return '';
  }

  function overviewTab() {
    const k = report?.overview?.kpis || {};
    const t = (key, label, fmt) => k[key] ? `<div class="kpi big"><div class="muted small">${label}</div><div class="kv">${(fmt || compact)(k[key].value)}</div>${deltaPill(k[key].delta, key)}${key === 'audience' ? ` <span class="muted small">${k.audience.growth >= 0 ? '+' : ''}${num(k.audience.growth)} this period</span>` : ''}</div>` : '';
    const hl = report?.overview?.highlights || [];
    const yt = src('youtube'), ga = src('ga4'), gsc = src('gsc');
    return `<div class="grid g4" style="margin-bottom:14px">${t('audience', 'Total audience')}${t('reach', 'Total reach')}${t('engagement', 'Engagement')}${t('watchHours', 'Watch hours', v => num(v, 1))}${t('websiteVisitors', 'Website visitors')}${t('searchClicks', 'Google search clicks')}${t('businessActions', 'Business actions')}</div>
      ${hl.length ? `<div class="card" style="margin-bottom:14px"><h2>What changed</h2>${hl.map(h => `<div class="hl ${h.tone}">${e(h.text)}</div>`).join('')}</div>` : ''}
      <div class="grid g2">
        ${yt?.ok ? `<div class="card"><h3>YouTube views</h3>${lineChart(yt.series, [{ key: 'views', label: 'Views', color: COLORS.a, fill: true }], { height: 150 })}</div>` : ''}
        ${ga?.ok ? `<div class="card"><h3>Website visitors</h3>${lineChart(ga.series, [{ key: 'users', label: 'Visitors', color: COLORS.b, fill: true }], { height: 150 })}</div>` : ''}
        ${gsc?.ok ? `<div class="card"><h3>Google search</h3>${lineChart(gsc.series, [{ key: 'impressions', label: 'Impressions', color: COLORS.c }, { key: 'clicks', label: 'Clicks', color: COLORS.a }], { height: 150 })}</div>` : ''}
        <div class="card"><h3>Social audience</h3>${table(report?.social?.platforms || [], [{ label: 'Platform', render: r => chip(r.id) }, { label: 'Followers', num: 1, render: r => num(r.followers) }, { label: 'Growth', num: 1, render: r => `<span style="color:${r.growth >= 0 ? 'var(--ok)' : 'var(--bad)'}">${r.growth >= 0 ? '+' : ''}${num(r.growth)}</span>` }])}</div>
      </div>`;
  }

  function youtubeTab() {
    const er = sourceError('youtube', 'YouTube'); if (er) return er;
    const y = src('youtube'), T = y.totals;
    return `<div class="grid g4" style="margin-bottom:14px">${['views', 'watchHours', 'avgViewDuration', 'netSubscribers', 'engagementRate', 'likes', 'comments', 'shares'].map(k => tile(k, T[k])).join('')}</div>
      <div class="card" style="margin-bottom:14px"><h3>Daily views</h3>${lineChart(y.series, [{ key: 'views', label: 'Views', color: COLORS.a, fill: true }])}</div>
      <div class="card" style="margin-bottom:14px"><h3>Daily watch hours &amp; new subscribers</h3>${lineChart(y.series, [{ key: 'watchHours', label: 'Watch hours', color: COLORS.c, fill: true }, { key: 'subscribers', label: 'New subscribers', color: COLORS.b }], { height: 150 })}</div>
      <div class="grid g2"><div class="card"><h3>Top videos</h3>${table(y.topVideos, [{ label: 'Video', render: r => `<a data-url="${e(r.url)}">${e(r.title)}</a>` }, { label: 'Views', num: 1, render: r => compact(r.views) }, { label: 'Watch h', num: 1, render: r => num(r.watchHours, 1) }, { label: 'Avg %', num: 1, render: r => num(r.avgViewPct, 0) + '%' }, { label: 'Subs', num: 1, render: r => '+' + num(r.subscribers) }])}</div>
      <div class="card"><h3>Where views come from</h3>${bars(y.trafficSources, 'source', 'views')}</div></div>`;
  }

  function websiteTab() {
    const er = sourceError('ga4', 'Google Analytics'); if (er) return er;
    const g = src('ga4'), T = g.totals;
    return `<div class="grid g3" style="margin-bottom:14px">${['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration'].map(k => tile(k, T[k])).join('')}</div>
      <div class="card" style="margin-bottom:14px"><h3>Traffic</h3>${lineChart(g.series, [{ key: 'users', label: 'Visitors', color: COLORS.b, fill: true }, { key: 'sessions', label: 'Sessions', color: COLORS.a }, { key: 'views', label: 'Page views', color: COLORS.c }])}</div>
      <div class="grid g2"><div class="card"><h3>Top pages</h3>${table(g.topPages, [{ label: 'Page', key: 'page' }, { label: 'Views', num: 1, render: r => compact(r.views) }, { label: 'Visitors', num: 1, render: r => compact(r.users) }])}</div>
      <div class="card"><h3>Traffic channels</h3>${bars(g.channels, 'channel', 'sessions', { color: COLORS.b })}</div></div>`;
  }

  function searchTab() {
    const er = sourceError('gsc', 'Search Console'); if (er) return er;
    const g = src('gsc'), T = g.totals;
    return `<div class="grid g4" style="margin-bottom:14px">${['clicks', 'impressions', 'ctr', 'position'].map(k => tile(k, T[k])).join('')}</div>
      <div class="card" style="margin-bottom:14px"><h3>Google Search performance</h3>${lineChart(g.series, [{ key: 'impressions', label: 'Impressions', color: COLORS.c, fill: true }, { key: 'clicks', label: 'Clicks', color: COLORS.a }])}</div>
      <div class="grid g2"><div class="card"><h3>Top search queries</h3>${table(g.topQueries, [{ label: 'Query', key: 'query' }, { label: 'Clicks', num: 1, render: r => compact(r.clicks) }, { label: 'Impr.', num: 1, render: r => compact(r.impressions) }, { label: 'CTR', num: 1, render: r => pctv(r.ctr) }, { label: 'Pos.', num: 1, render: r => num(r.position, 1) }])}</div>
      <div class="card"><h3>Top pages in Google</h3>${table(g.topPages, [{ label: 'Page', key: 'page' }, { label: 'Clicks', num: 1, render: r => compact(r.clicks) }, { label: 'Impr.', num: 1, render: r => compact(r.impressions) }])}</div></div>`;
  }

  function businessTab() {
    const er = sourceError('gbp', 'Business Profile'); if (er) return er;
    const g = src('gbp'), T = g.totals;
    return `<div class="grid g4" style="margin-bottom:14px">${['impressions', 'searchViews', 'mapsViews', 'websiteClicks', 'calls', 'directions', 'messages'].map(k => tile(k, T[k], k === 'impressions' ? 'Profile views' : null)).join('')}</div>
      <div class="card"><h3>Business Profile activity</h3>${lineChart(g.series, [{ key: 'impressions', label: 'Profile views', color: COLORS.a, fill: true }, { key: 'websiteClicks', label: 'Website clicks', color: COLORS.b }, { key: 'calls', label: 'Calls', color: COLORS.c }, { key: 'directions', label: 'Directions', color: COLORS.d }])}</div>`;
  }

  function socialTab() {
    const s = report?.social || { platforms: [], totals: {} };
    return `<div class="grid g4" style="margin-bottom:14px">${['posts', 'views', 'engagement', 'likes', 'comments', 'shares'].map(k => tile(k, s.totals[k])).join('')}</div>
      <div class="grid g2"><div class="card"><h3>Followers by platform</h3>${bars(s.platforms.map(p => ({ ...p, name: (S.accounts.find(a => a.id === p.id)?.name || p.id) })), 'name', 'followers')}</div>
      <div class="card"><h3>Growth this period</h3>${table(s.platforms, [{ label: 'Platform', render: r => chip(r.id) }, { label: 'Followers', num: 1, render: r => num(r.followers) }, { label: 'Change', num: 1, render: r => `${r.growth >= 0 ? '+' : ''}${num(r.growth)}` }])}</div></div>
      <p class="small muted" style="margin-top:10px">Social numbers come from your connected Creator Hub accounts and refresh every ${S.settings.analyticsIntervalHours} hours (X stats only if enabled in Settings).</p>`;
  }

  const TABS = [['overview', 'Overview'], ['youtube', 'YouTube'], ['website', 'Website'], ['search', 'Google Search'], ['business', 'Business Profile'], ['social', 'Social']];

  function renderView() {
    const iv = S.insights;
    if (!report && !loading && !error) setTimeout(() => load(false), 0);
    const range = report?.range;
    return `<div class="header"><div><h1>Insights</h1><div class="muted">Everything about your reach in one place${range ? ` · ${e(range.start)} → ${e(range.end)} vs previous ${days} days` : ''}${report?.fetchedAt ? ` · updated ${new Date(report.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</div></div>
      <div class="row"><div class="seg">${[7, 28, 90].map(d => `<button class="${d === days ? 'on' : ''}" data-ins-days="${d}">${d} days</button>`).join('')}</div>
      <button class="btn" data-ins="refresh" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button>
      <button class="btn" data-ins="csv" ${report ? '' : 'disabled'}>Export CSV</button><button class="btn primary" data-ins="pdf" ${report ? '' : 'disabled'}>Download report (PDF)</button></div></div>
      ${error ? `<div class="note">${e(error)}</div>` : ''}${iv.lastError ? `<div class="note">${e(iv.lastError)}</div>` : ''}
      ${iv.connected ? pickers(iv) : connectCard(iv)}
      <div class="tabs">${TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-ins-tab="${k}">${l}</button>`).join('')}</div>
      ${loading && !report ? '<div class="card empty">Loading your numbers…</div>' : { overview: overviewTab, youtube: youtubeTab, website: websiteTab, search: searchTab, business: businessTab, social: socialTab }[tab]()}
      ${iv.connected ? `<details class="small muted" style="margin-top:18px"><summary>Google connection</summary><div style="margin-top:8px">${connectCard(iv)}</div></details>` : ''}`;
  }

  // ---------- exports ----------
  function csv() {
    const out = [['section', 'date_or_item', 'metric', 'value']];
    const push = (a, b, c, d) => out.push([a, b, c, d]);
    const r = report;
    for (const [k, v] of Object.entries(r.overview.kpis)) if (v) { push('overview', `${r.range.start}..${r.range.end}`, k, v.value); push('overview_previous', `${r.range.prevStart}..${r.range.prevEnd}`, k, v.prev); }
    for (const [name, s] of Object.entries(r.google?.sources || {})) {
      if (!s.ok) continue;
      for (const [k, v] of Object.entries(s.totals || {})) push(name + '_totals', `${r.range.start}..${r.range.end}`, k, v.value);
      for (const row of s.series || []) for (const [k, v] of Object.entries(row)) if (k !== 'date') push(name + '_daily', row.date, k, v);
      for (const [listName, list] of Object.entries(s)) if (Array.isArray(list) && listName !== 'series') for (const it of list) {
        const label = it.title || it.page || it.query || it.channel || it.source || '';
        for (const [k, v] of Object.entries(it)) if (typeof v === 'number') push(`${name}_${listName}`, label, k, v);
      }
    }
    for (const p of r.social.platforms) { push('social_followers', p.id, 'followers', p.followers); push('social_followers', p.id, 'growth', p.growth); }
    return out.map(row => row.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n';
  }

  function pdfHtml() {
    const r = report, L = { light: true, width: 700, height: 170 };
    const kp = (label, t, fmt = compact, key) => t ? `<div class="k"><div class="l">${label}</div><div class="v">${fmt(t.value)}</div><div class="d ${t.delta == null ? '' : (INVERSE.has(key) ? t.delta < 0 : t.delta > 0) ? 'up' : 'down'}">${t.delta == null ? 'new' : (t.delta > 0 ? '▲ ' : '▼ ') + Math.abs(t.delta * 100).toFixed(1) + '%'} vs prev</div></div>` : '';
    const K = r.overview.kpis, yt = src('youtube'), ga = src('ga4'), gsc = src('gsc'), gbp = src('gbp');
    const sec = (title, body) => `<section><h2>${title}</h2>${body}</section>`;
    const tbl = (rows, cols) => rows?.length ? `<table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>${rows.map(x => `<tr>${cols.map(c => `<td>${e(c[1](x))}</td>`).join('')}</tr>`).join('')}</table>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;margin:0;padding:28px 34px;font-size:12px}
      h1{font-size:22px;margin:0}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}.sub{color:#6b7280;margin:4px 0 16px}
      .ks{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.k{border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px}.l{color:#6b7280;font-size:10px}.v{font-size:18px;font-weight:700;margin:2px 0}
      .d{font-size:10px;color:#6b7280}.d.up{color:#15803d}.d.down{color:#b91c1c}table{width:100%;border-collapse:collapse;margin-top:6px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #f1f5f9;font-size:11px}
      th{color:#6b7280;font-weight:500}.hl{padding:5px 0;border-bottom:1px solid #f1f5f9}.legend{font-size:10px;color:#6b7280}.legend i{display:inline-block;width:10px;height:3px;margin:0 4px 2px 8px;vertical-align:middle}
      section{page-break-inside:avoid}.chart svg{width:100%}footer{margin-top:24px;color:#9ca3af;font-size:10px}</style></head><body>
      <h1>Creator performance report</h1><div class="sub">${e(r.range.start)} – ${e(r.range.end)} (${days} days) compared with ${e(r.range.prevStart)} – ${e(r.range.prevEnd)} · generated ${new Date().toLocaleString()}</div>
      <div class="ks">${kp('Total audience', K.audience)}${kp('Total reach', K.reach)}${kp('Engagement', K.engagement)}${kp('Watch hours', K.watchHours, v => num(v, 1))}${kp('Website visitors', K.websiteVisitors)}${kp('Search clicks', K.searchClicks)}${kp('Business actions', K.businessActions)}</div>
      ${r.overview.highlights.length ? sec('Highlights', r.overview.highlights.map(h => `<div class="hl">• ${e(h.text)}</div>`).join('')) : ''}
      ${yt?.ok ? sec('YouTube', `<div class="ks">${['views', 'watchHours', 'avgViewDuration', 'netSubscribers'].map(k => kp(LABEL[k], yt.totals[k], FMT[k], k)).join('')}</div>${lineChart(yt.series, [{ key: 'views', label: 'Daily views', color: COLORS.a, fill: true }], L)}${tbl(yt.topVideos.slice(0, 8), [['Top videos', x => x.title], ['Views', x => compact(x.views)], ['Watch h', x => num(x.watchHours, 1)], ['Avg %', x => num(x.avgViewPct) + '%']])}${tbl(yt.trafficSources.slice(0, 6), [['Traffic source', x => x.source], ['Views', x => compact(x.views)]])}`) : ''}
      ${ga?.ok ? sec('Website (Google Analytics)', `<div class="ks">${['activeUsers', 'sessions', 'screenPageViews', 'engagementRate'].map(k => kp(LABEL[k], ga.totals[k], FMT[k], k)).join('')}</div>${lineChart(ga.series, [{ key: 'users', label: 'Visitors', color: COLORS.b, fill: true }, { key: 'sessions', label: 'Sessions', color: COLORS.a }], L)}${tbl(ga.topPages.slice(0, 8), [['Top pages', x => x.page], ['Views', x => compact(x.views)]])}${tbl(ga.channels.slice(0, 6), [['Channel', x => x.channel], ['Sessions', x => compact(x.sessions)]])}`) : ''}
      ${gsc?.ok ? sec('Google Search (Search Console)', `<div class="ks">${['clicks', 'impressions', 'ctr', 'position'].map(k => kp(LABEL[k], gsc.totals[k], FMT[k], k)).join('')}</div>${lineChart(gsc.series, [{ key: 'impressions', label: 'Impressions', color: COLORS.c, fill: true }, { key: 'clicks', label: 'Clicks', color: COLORS.a }], L)}${tbl(gsc.topQueries.slice(0, 10), [['Top queries', x => x.query], ['Clicks', x => compact(x.clicks)], ['Impr.', x => compact(x.impressions)], ['Pos.', x => num(x.position, 1)]])}`) : ''}
      ${gbp?.ok ? sec('Google Business Profile', `<div class="ks">${['impressions', 'websiteClicks', 'calls', 'directions'].map(k => kp(k === 'impressions' ? 'Profile views' : LABEL[k], gbp.totals[k], FMT[k], k)).join('')}</div>${lineChart(gbp.series, [{ key: 'impressions', label: 'Profile views', color: COLORS.a, fill: true }, { key: 'websiteClicks', label: 'Website clicks', color: COLORS.b }], L)}`) : ''}
      ${sec('Social platforms', `<div class="ks">${['posts', 'views', 'engagement'].map(k => kp(LABEL[k], r.social.totals[k], FMT[k], k)).join('')}</div>${tbl(r.social.platforms, [['Platform', x => x.id], ['Followers', x => num(x.followers)], ['Change', x => (x.growth >= 0 ? '+' : '') + num(x.growth)]])}`)}
      <footer>Generated by Creator Hub · data from YouTube Analytics, Google Analytics, Search Console, Business Profile and connected social platforms.</footer></body></html>`;
  }

  // ---------- events ----------
  async function onClick(t) {
    if (t.dataset.insDays) { days = +t.dataset.insDays; report = null; return load(false); }
    if (t.dataset.insTab) { tab = t.dataset.insTab; return render(); }
    switch (t.dataset.ins) {
      case 'connect': {
        const cid = document.getElementById('g-cid')?.value.trim(), cs = document.getElementById('g-cs')?.value.trim();
        if (cid || cs) await run(() => hub.insights.saveConfig({ clientId: cid, clientSecret: cs }));
        toast('Your browser will open to sign in with Google…');
        try { const r = await run(() => hub.insights.connect()); toast(`Connected Google${r?.email ? ' as ' + r.email : ''}.`); } catch (_) {}
        await refresh(); report = null; return load(true);
      }
      case 'disconnect': if (confirm('Disconnect Google? Insights will only show social data until you reconnect.')) { await run(() => hub.insights.disconnect()); report = null; await refresh(); } return;
      case 'resources': toast('Scanning your Google account…'); await run(() => hub.insights.resources()); await refresh(); return load(true);
      case 'refresh': return load(true);
      case 'csv': return run(() => hub.insights.exportCsv(csv(), `Creator Hub data ${report.range.start} to ${report.range.end}.csv`), 'CSV saved.');
      case 'pdf': return run(() => hub.insights.exportPdf(pdfHtml(), `Creator Hub report ${report.range.start} to ${report.range.end}.pdf`), 'Report saved.');
    }
  }
  async function onChange(t) {
    if (t.dataset.insSelect) { await run(() => hub.insights.select({ [t.dataset.insSelect]: t.value })); await refresh(); report = null; return load(true); }
  }

  return { render: renderView, onClick, onChange, _test: { lineChart, bars, csv: () => csv(), pdf: () => pdfHtml(), setReport: r => { report = r; } } };
})();
