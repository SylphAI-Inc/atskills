'use strict';
// The global validating cache — browser semantics, HTTP conditional requests.
// Every fetch goes through here: unchanged (304) serves the cache, changed
// downloads fresh, offline serves stale with a warning, definitively gone
// (404) says so and offers what's cached. Entries are always safe to delete;
// the path re-resolves.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_DIR = process.env.ATSKILLS_CACHE || path.join(os.homedir(), '.atskills', 'cache');

class Cache {
  constructor(dir = DEFAULT_DIR, { log = () => {} } = {}) {
    this.dir = dir;
    this.log = log; // (level, message) — 'warn' | 'info'
  }

  _entry(url) {
    const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
    const dir = path.join(this.dir, key);
    return { dir, body: path.join(dir, 'body'), meta: path.join(dir, 'meta.json') };
  }

  _readMeta(entry) {
    try {
      return JSON.parse(fs.readFileSync(entry.meta, 'utf8'));
    } catch {
      return null;
    }
  }

  // fetch(url) → { text, status } where status is one of:
  // 'first' (never seen), 'fresh' (changed upstream), 'cache' (304 unchanged),
  // 'stale' (offline, serving old copy).
  async fetch(url, { headers = {} } = {}) {
    const entry = this._entry(url);
    const meta = this._readMeta(entry);

    const h = { 'User-Agent': 'atskills', ...headers };
    if (meta && meta.etag) h['If-None-Match'] = meta.etag;
    if (process.env.GITHUB_TOKEN && /(^|\.)github(usercontent)?\.com/.test(new URL(url).hostname)) {
      h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const cached = () => {
      const buffer = fs.readFileSync(entry.body);
      return { buffer, text: buffer.toString('utf8') };
    };

    let res;
    try {
      res = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch {
      if (meta && fs.existsSync(entry.body)) {
        this.log('warn', `offline — cached copy from ${meta.fetchedAt} (may be stale)`);
        return { ...cached(), status: 'stale', meta };
      }
      throw new Error(`offline and nothing cached for ${url}`);
    }

    if (res.status === 304 && fs.existsSync(entry.body)) {
      return { ...cached(), status: 'cache', meta };
    }
    if (res.status === 404) {
      const err = new Error(
        meta && fs.existsSync(entry.body)
          ? `upstream gone (404); a copy fetched ${meta.fetchedAt} is still cached`
          : `not found: ${url}`
      );
      err.code = 'GONE';
      err.cached = meta && fs.existsSync(entry.body) ? cached().text : null;
      throw err;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);

    // Binary-safe: store raw bytes, decode to text only on read.
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(entry.dir, { recursive: true });
    const tmp = entry.body + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, entry.body);
    const newMeta = { url, etag: res.headers.get('etag'), fetchedAt: new Date().toISOString() };
    fs.writeFileSync(entry.meta, JSON.stringify(newMeta, null, 2));
    return { buffer, text: buffer.toString('utf8'), status: meta ? 'fresh' : 'first', meta: newMeta };
  }
}

module.exports = { Cache, DEFAULT_DIR };
