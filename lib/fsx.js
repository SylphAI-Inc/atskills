'use strict';
// Filesystem helpers shared across the library.

const fs = require('fs');
const path = require('path');
// ids.js requires nothing, so this direction never cycles.
const { MAX_COLLECTION_SKILLS } = require('./ids');

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

// Parse SKILL.md frontmatter. Tolerates CRLF, quoted values, and YAML block
// scalars (`description: >-` folded over following indented lines); only
// `name` and `description` matter to the protocol (the standard's index
// fields) — two fields don't justify a YAML dependency.
function frontmatter(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalized);
  const out = { name: null, description: null };
  if (!m) return out;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      // block scalar: fold the following more-indented lines into one string
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      value = parts.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '') || null;
  }
  return out;
}

// The one directory that is never content: git's own object store. It is
// already filtered when saving, and it holds no SKILL.md by construction.
//
// Everything else is walked, INCLUDING dot-dirs — `.claude/skills/`,
// `.agents/`, `.gemini/` and `.kiro/` are the ecosystem's standard locations
// and hold ~12% of all published skills. Skipping every dot-dir also made
// local resolution disagree with remote listing (the trees API has no such
// filter), so a skill visible on GitHub vanished the moment it was saved.
const SKIP_DIRS = new Set(['.git']);

// Walk for skills under dir. A skill is a folder holding SKILL.md, and the
// walk stops there (leaf rule). Dot FILES (.source, .autotrigger) are metadata
// and are never skills; dot-DIRS are walked — see SKIP_DIRS.
function walkSkills(dir, rel = '') {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return [{ rel, dir }];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
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

// ─── The collection cap ──────────────────────────────────────────────────────

// The leaf rule applied to a flat path list instead of a live directory — what
// walkSkills would find, computed from a tree listing before anything is
// fetched. A skill is a folder holding SKILL.md and the walk STOPS there, so a
// SKILL.md nested inside another skill's bundle is that bundle's file, not a
// second skill. Dot-dirs are metadata and never count.
//
// Kept pure and beside walkSkills so the pre-fetch count and the post-fetch
// walk cannot drift: a cap enforced on a different count than the index shows
// would be a lie.
function leafSkillDirs(paths) {
  const dirs = new Set();
  for (const raw of paths) {
    const p = String(raw).trim().replace(/^\.\//, '');
    if (!p.endsWith('SKILL.md')) continue;
    const dir = p.slice(0, Math.max(0, p.length - 'SKILL.md'.length)).replace(/\/$/, '');
    // Same rule as walkSkills — the pre-fetch count and the index it guards
    // must apply identical filters, or the cap is enforced on a number the
    // reader never sees.
    if (dir.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    dirs.add(dir);
  }
  // Leaf rule: drop any dir sitting inside another skill dir.
  return [...dirs]
    .filter((dir) => {
      const segs = dir.split('/');
      for (let i = 1; i < segs.length; i++) {
        if (dirs.has(segs.slice(0, i).join('/'))) return false;
      }
      return !(dir !== '' && dirs.has(''));
    })
    .sort();
}

// The shallowest sub-paths that fit under the cap — the "you meant one of
// these" list.
//
// Grouping one level down is not enough: in a real aggregator every top-level
// child is itself oversized (`plugins/` 4,303, `skills/` 1,993), which would
// leave a refusal with no next step. So descend until a node fits and report
// that node. On a catalog of ~10-skill bundles this surfaces the bundles,
// which is exactly the unit their authors curated.
function largestUsableCollections(skills, cap = MAX_COLLECTION_SKILLS) {
  const out = [];
  const visit = (dirs, prefix) => {
    if (dirs.length <= cap) {
      if (prefix) out.push({ rel: prefix, count: dirs.length });
      return;
    }
    const groups = new Map();
    for (const dir of dirs) {
      const rest = prefix ? dir.slice(prefix.length + 1) : dir;
      const head = rest.split('/')[0];
      if (!head) continue; // a skill AT this prefix cannot be split further
      const key = prefix ? `${prefix}/${head}` : head;
      const bucket = groups.get(key);
      if (bucket) bucket.push(dir);
      else groups.set(key, [dir]);
    }
    if (groups.size === 0) return; // nothing left to split on
    for (const [key, bucket] of groups) visit(bucket, key);
  };
  visit(skills, '');
  return out.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
}

// Refuse an oversized reference, naming smaller sets that would work.
//
// Aggregator repos vendor the same catalog once per target agent, so the raw
// list offers `…/design-it` three times over and spends the whole suggestion
// budget on duplicates — keep the shortest path per name. And a flat oversized
// directory yields one singleton per skill, so prefer real collections and
// fall back to individual skills only when there is nothing larger to offer.
function assertCollectionFits(id, skillDirs) {
  if (skillDirs.length <= MAX_COLLECTION_SKILLS) return;

  const byName = new Map();
  for (const item of largestUsableCollections(skillDirs)) {
    const name = item.rel.split('/').pop();
    const seen = byName.get(name);
    if (!seen || item.rel.length < seen.rel.length) byName.set(name, item);
  }
  const ranked = [...byName.values()].sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
  const collections = ranked.filter((item) => item.count > 1);
  const suggestions = (collections.length ? collections : ranked).slice(0, 6);

  const head =
    `${id} holds ${skillDirs.length} skills — over the ${MAX_COLLECTION_SKILLS} a single reference may ` +
    `load. Reference a specific skill, or one of the collections inside it`;
  const err = new Error(
    suggestions.length
      ? `${head}:${suggestions.map((s) => `\n  ${id}/${s.rel}  (${s.count})`).join('')}`
      : `${head}.`
  );
  err.code = 'TOO_LARGE';
  err.count = skillDirs.length;
  err.suggestions = suggestions.map((s) => ({ id: `${id}/${s.rel}`, count: s.count }));
  throw err;
}

module.exports = {
  findAtskills,
  safeJoin,
  frontmatter,
  walkSkills,
  nearestSource,
  approxTokens,
  pool,
  leafSkillDirs,
  largestUsableCollections,
  assertCollectionFits,
};
