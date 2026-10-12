#!/usr/bin/env node
'use strict';
// Builds docs/updates/latest.json (the app's update feed) and docs/download/ links from the
// installers in dist/. Run after a build; the SHA-256 in the feed is what the app verifies.
//   node tools/make-update-feed.js <distDir> [docsDir]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pkg = require('../package.json');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const dist = args[0] || 'dist';
const docs = args[1] || 'docs';
// Where customers fetch the installers. Defaults to package.json's downloadBase (spektly.com);
// pass --base while the files still live somewhere else.
const base = (flag('base') || pkg.downloadBase).replace(/\/$/, '') + '/';

const MATCH = [
  ['darwin-arm64', n => n.endsWith('.dmg') && n.includes('arm64')],
  ['darwin-x64', n => n.endsWith('.dmg') && !n.includes('arm64')],
  ['win32-x64', n => n.endsWith('.exe')]
];
const files = {};
const names = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
for (const [key, test] of MATCH) {
  const name = names.find(test);
  if (!name) continue;
  const full = path.join(dist, name);
  files[key] = {
    name, url: base + name,
    size: fs.statSync(full).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  };
}
if (!Object.keys(files).length) { console.error('No installers found in ' + dist); process.exit(1); }

const feed = { version: pkg.version, published: new Date().toISOString(), page: 'https://spektly.com/#download', notes: process.env.RELEASE_NOTES || '', files };
fs.mkdirSync(path.join(docs, 'updates'), { recursive: true });
fs.writeFileSync(path.join(docs, 'updates', 'latest.json'), JSON.stringify(feed, null, 2) + '\n');

// A plain checksums file so anyone can verify a download by hand.
const sums = Object.values(files).map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n';
fs.writeFileSync(path.join(docs, 'updates', 'SHA256SUMS.txt'), sums);
console.log(JSON.stringify(feed, null, 2));
