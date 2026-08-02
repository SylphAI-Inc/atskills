'use strict';
// .atskills/.autotrigger — one file, like .gitignore: one entry per line,
// `#` comments. plain = yours (path under .atskills/) · @ = hub ·
// @gh: = github · trailing / = every skill under that directory.
// Install = a line in this file. That's the whole equation.

const fs = require('fs');
const path = require('path');
const { normalizeId, diskPath, isGh } = require('./ids');
const { safeJoin, walkSkills, frontmatter, nearestSource, approxTokens } = require('./fsx');
const sources = require('./sources');

function triggerFile(root) {
  return path.join(root, '.autotrigger');
}

// parse(root) → [{ line, raw, cloud, id, wholeDir }] — comments and blanks
// dropped, exact duplicates collapsed (they load once), order preserved.
function parse(root) {
  const file = triggerFile(root);
  if (!fs.existsSync(file)) return [];
  const seen = new Set();
  const entries = [];
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const cloud = line.startsWith('@');
    const body = cloud ? line.slice(1) : line;
    const wholeDir = body.endsWith('/');
    let id;
    try {
      id = normalizeId(body);
    } catch (err) {
      entries.push({ line, error: err.message });
      continue;
    }
    entries.push({ line, cloud, id, wholeDir });
  }
  return entries;
}

// expand(cache, root) → residency list: what actually loads at session start.
// Frontmatter only — the body loads on trigger. Every line resolves
// local-first, so a saved copy answers its own @ line. Per-line failures are
// non-fatal: a line that can't load reports once and the session goes on.
async function expand(cache, root) {
  const out = [];
  const loadedDirs = new Set();

  for (const entry of parse(root)) {
    if (entry.error) {
      out.push({ line: entry.line, error: entry.error });
      continue;
    }
    const { line, cloud, id, wholeDir } = entry;
    try {
      const localDir = safeJoin(root, diskPath(id));
      if (fs.existsSync(localDir) && walkSkills(localDir).length) {
        for (const s of walkSkills(localDir)) {
          if (loadedDirs.has(s.dir)) continue; // one skill loads once
          loadedDirs.add(s.dir);
          const file = path.join(s.dir, 'SKILL.md');
          const fm = frontmatter(fs.readFileSync(file, 'utf8'));
          const invalid = validateResident(fm, file);
          if (invalid) {
            out.push({ line, error: invalid });
            continue;
          }
          const src = nearestSource(s.dir, root);
          out.push({
            line,
            id: s.rel ? `${id}/${s.rel}` : id,
            where: src ? 'saved' : 'yours',
            origin: src ? src.id : null,
            file,
            fm,
          });
        }
      } else if (cloud && !wholeDir) {
        const { text, status } = await sources.fetchSkill(cache, id);
        const fm = frontmatter(text);
        const invalid = validateResident(fm, sources.skillUrl(id));
        if (invalid) {
          out.push({ line, error: invalid });
          continue;
        }
        out.push({ line, id, where: isGh(id) ? 'github' : 'hub', status, url: sources.skillUrl(id), fm });
      } else if (cloud && wholeDir) {
        for (const m of await sources.fetchMenu(cache, id)) {
          const { text, status } = await sources.fetchSkill(cache, m.id);
          const fm = frontmatter(text);
          const invalid = validateResident(fm, sources.skillUrl(m.id));
          if (invalid) {
            out.push({ line, error: invalid });
            continue;
          }
          out.push({ line, id: m.id, where: isGh(id) ? 'github' : 'hub', status, url: sources.skillUrl(m.id), fm });
        }
      } else {
        out.push({ line, error: `nothing at .atskills/${diskPath(id)}` });
      }
    } catch (err) {
      out.push({ line, error: `${err.message} (loads nothing; session goes on)` });
    }
  }
  return out;
}

// Frontmatter is what residency injects — a skill without name + description
// can't sit in the index. Refuse loudly, per entry, never silently.
function validateResident(fm, ref) {
  if (!fm.name || !fm.description) {
    return `SKILL.md at ${ref} is missing frontmatter (name + description) — required for the index; skill skipped`;
  }
  return null;
}

function residentTokens(entries) {
  return entries
    .filter((e) => !e.error)
    .reduce((n, e) => n + approxTokens(`- ${e.fm.name || '?'}: ${e.fm.description || ''}`), 0);
}

// Editing — suffixes, checkboxes, and hand edits all write the same file.
function addLine(root, line) {
  const file = triggerFile(root);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split('\n').map((l) => l.replace(/#.*$/, '').trim());
  if (lines.includes(line.trim())) return false;
  const body = current.length && !current.endsWith('\n') ? current + '\n' : current;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, body + line.trim() + '\n');
  return true;
}

function removeLine(root, line) {
  const file = triggerFile(root);
  if (!fs.existsSync(file)) return false;
  const target = line.trim();
  let removed = false;
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter((raw) => {
    if (raw.replace(/#.*$/, '').trim() === target) {
      removed = true;
      return false;
    }
    return true;
  });
  fs.writeFileSync(file, kept.join('\n'));
  return removed;
}

function hasLine(root, line) {
  return parse(root).some((e) => e.line === line.trim());
}

module.exports = { triggerFile, parse, expand, residentTokens, addLine, removeLine, hasLine };
