'use strict';
// Filesystem helpers shared across the library.

const fs = require('fs');
const path = require('path');

// Find the nearest .atskills/ at or above `start`. Returns its absolute path
// or null. The project folder is the only project-side state the protocol has.
function findAtskills(start) {
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, '.atskills');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Join a user-supplied relative path under root, refusing anything that
// escapes root (defense against `..` smuggled through configs).
function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes .atskills/: ${rel}`);
  }
  return abs;
}

// Parse SKILL.md frontmatter — delegated to gray-matter, the ecosystem's
// standard frontmatter parser (full YAML: quotes, CRLF, block scalars). Only
// `name` and `description` matter to the protocol (the standard's index
// fields); a malformed block degrades to nulls, never a throw.
const matter = require('gray-matter');
function frontmatter(text) {
  try {
    const data = matter(String(text).replace(/\r\n/g, '\n')).data || {};
    return {
      name: data.name != null ? String(data.name).trim() : null,
      description: data.description != null ? String(data.description).trim().replace(/\s+/g, ' ') : null,
    };
  } catch {
    return { name: null, description: null };
  }
}

// Walk for skills under dir. A skill is a folder holding SKILL.md, and the
// walk stops there (leaf rule). Dotfiles/dot-dirs are metadata — never listed.
function walkSkills(dir, rel = '') {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return [{ rel, dir }];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    found.push(...walkSkills(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
  }
  return found;
}

// Nearest .source at or above `dir`, stopping at root. Returns parsed
// { id, taken, revision } or null. `.source` is pure provenance — nothing
// resolves against it.
function nearestSource(dir, root) {
  let cur = path.resolve(dir);
  const stop = path.resolve(root);
  for (;;) {
    const f = path.join(cur, '.source');
    if (fs.existsSync(f)) {
      const [id, line2 = ''] = fs.readFileSync(f, 'utf8').trim().split('\n');
      const m = /^(\S+)\s+rev:(\S+)$/.exec(line2.trim());
      return { id: id.trim(), taken: m ? m[1] : line2.trim(), revision: m ? m[2] : null, file: f };
    }
    if (cur === stop) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Run fn over items with bounded concurrency — network fan-out helper.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function approxTokens(text) {
  return Math.ceil(String(text).length / 4);
}

module.exports = { findAtskills, safeJoin, frontmatter, walkSkills, nearestSource, approxTokens, pool };
