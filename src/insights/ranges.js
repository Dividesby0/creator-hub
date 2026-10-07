'use strict';
// Date-range helpers. Ranges end "yesterday" (most Google data lags ~1-2 days).
const DAY = 864e5;
const iso = d => d.toISOString().slice(0, 10);

function rangeFor(days, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY);
  const start = new Date(end.getTime() - (days - 1) * DAY);
  const prevEnd = new Date(start.getTime() - DAY);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * DAY);
  return { days, start: iso(start), end: iso(end), prevStart: iso(prevStart), prevEnd: iso(prevEnd) };
}

function eachDay(start, end) {
  const out = [];
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += DAY) out.push(iso(new Date(t)));
  return out;
}

const delta = (cur, prev) => (prev ? (cur - prev) / Math.abs(prev) : cur ? null : 0);

// totals: {metric: number}, prevTotals: {metric: number} -> {metric: {value, prev, delta}}
function compare(totals = {}, prevTotals = {}) {
  const out = {};
  for (const k of Object.keys(totals)) out[k] = { value: totals[k] ?? 0, prev: prevTotals[k] ?? 0, delta: delta(totals[k] ?? 0, prevTotals[k] ?? 0) };
  return out;
}

module.exports = { rangeFor, eachDay, compare, delta, iso };
