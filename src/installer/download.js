'use strict';
// Downloads an update to disk, with progress and integrity checking.
//
// Why the app fetches it rather than opening a browser:
//   * a browser download gets macOS's quarantine flag, which is what produces the
//     "Apple could not verify..." prompt. A file written here carries no such flag.
//   * the customer never leaves Spektly, and never sees where the file is hosted.
//   * we can check the size and SHA-256 from the update feed before running anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAFE_NAME = /^[A-Za-z0-9._-]+\.(dmg|exe|zip)$/;

async function downloadUpdate({ url, dir, name, size, sha256, onProgress, fetchImpl = globalThis.fetch, signal }) {
  if (!/^https:\/\//i.test(String(url || ''))) throw new Error('Update location is not a secure address.');
  if (!SAFE_NAME.test(String(name || ''))) throw new Error('Update file name is not valid.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const part = file + '.part';

  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'Spektly' } });
  if (!res.ok) throw new Error(`Could not download the update (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  if (size && total && total !== size) throw new Error('The update is a different size than expected. Try again later.');

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let done = 0, lastTick = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (size && done > size) throw new Error('The update is larger than expected. Nothing was installed.');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      const now = Date.now();
      if (onProgress && (now - lastTick > 200 || done === total)) { lastTick = now; onProgress({ done, total }); }
    }
    await new Promise((res2, rej) => out.end(err => err ? rej(err) : res2()));
  } catch (e) {
    out.destroy(); try { fs.unlinkSync(part); } catch (_) {}
    throw e.name === 'AbortError' ? Object.assign(new Error('Download cancelled.'), { cancelled: true }) : e;
  }

  const got = hash.digest('hex');
  if (size && done !== size) { try { fs.unlinkSync(part); } catch (_) {} throw new Error('The update did not download completely. Try again.'); }
  if (sha256 && got !== String(sha256).toLowerCase()) {
    try { fs.unlinkSync(part); } catch (_) {}
    throw new Error('The update failed its integrity check and was deleted. Nothing was installed.');
  }
  fs.renameSync(part, file);
  return { file, bytes: done, sha256: got, verified: !!sha256 };
}

module.exports = { downloadUpdate, SAFE_NAME };
