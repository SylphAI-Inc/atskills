'use strict';
// .atskills/.autotrigger — one file, like .gitignore: one entry per line,
// `#` comments. plain = yours (path under .atskills/) · @ = hub ·
// @gh: = github · trailing / = every skill under that directory.
// Install = a line in this file. That's the whole equation.

const fs = require('fs');
const path = require('path');
const ignore = require('ignore');
const { normalizeId, diskPath, isGh } = require('./ids');
const { safeJoin, walkSkills, frontmatter, nearestSource, approxTokens } = require('./fsx');
const sources = require('./sources');

function triggerFile(root) {
  return path.join(root, '.autotrigger');
}

// All writes go through tmp+rename — a crash or concurrent writer can corrupt
// nothing; the worst case is losing the race, never losing the file.
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
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
    if (!line.startsWith('@')) {
      // plain = a gitignore PATTERN over the local tree (globs, ! negation —
      // exactly git's matching, via the `ignore` package). Not an ID.
      entries.push({ line, cloud: false, pattern: line });
      continue;
    }
    const body = line.slice(1);
    const wholeDir = body.endsWith('/');
    try {
      entries.push({ line, cloud: true, id: normalizeId(body), wholeDir });
    } catch (err) {
      entries.push({ line, error: err.message });
    }
  }
  return entries;
}

// expand(cache, root) → residency list: what actually loads at session start.
// Frontmatter only — the body loads on trigger. Every line resolves
// local-first, so a saved copy answers its own @ line. Per-line failures are
// non-fatal: a line that can't load reports once and the session goes on.
async function expand(cache, root) {
  const out = [];
  const entries = parse(root);
  for (const e of entries) if (e.error) out.push({ line: e.line, error: e.error });

  // Plain lines form ONE gitignore ruleset matched against the local skill
  // tree — resolution is literally "would .gitignore match this path".
  const plainEntries = entries.filter((e) => !e.error && !e.cloud);
  const allLocal = walkSkills(root);
  const loadedDirs = new Set();
  if (plainEntries.length) {
    const ig = ignore().add(plainEntries.map((e) => e.pattern));
    for (const s of allLocal) {
      if (!ig.ignores(s.rel)) continue;
      loadedDirs.add(s.dir);
      pushLocal(out, root, s.rel, s);
    }
    for (const e of plainEntries) {
      const one = ignore().add([e.pattern]);
      if (e.pattern.startsWith('!')) continue; // negations match nothing by design
      if (!allLocal.some((s) => one.ignores(s.rel))) {
        out.push({ line: e.line, error: `matches nothing under .atskills/` });
      }
    }
  }

  for (const entry of entries.filter((e) => !e.error && e.cloud)) {
    const { line, id, wholeDir } = entry;
    try {
      // local-first: a saved copy answers its own @ line
      const localDir = safeJoin(root, diskPath(id));
      if (fs.existsSync(localDir) && walkSkills(localDir).length) {
        for (const s of walkSkills(localDir)) {
          if (loadedDirs.has(s.dir)) continue; // one skill loads once
          loadedDirs.add(s.dir);
          pushLocal(out, root, s.rel ? `${id}/${s.rel}` : id, s, line);
        }
      } else if (!wholeDir) {
        const { text, status } = await sources.fetchSkill(cache, id);
        const fm = frontmatter(text);
        const invalid = validateResident(fm, sources.skillUrl(id));
        if (invalid) out.push({ line, error: invalid });
        else out.push({ line, id, where: isGh(id) ? 'github' : 'hub', status, url: sources.skillUrl(id), fm });
      } else {
        for (const m of await sources.fetchMenu(cache, id)) {
          try {
            const { text, status } = await sources.fetchSkill(cache, m.id);
            const fm = frontmatter(text);
            const invalid = validateResident(fm, sources.skillUrl(m.id));
            if (invalid) out.push({ line, error: invalid });
            else out.push({ line, id: m.id, where: isGh(id) ? 'github' : 'hub', status, url: sources.skillUrl(m.id), fm });
          } catch (err) {
            // one failing child never takes down the rest of the directory
            out.push({ line: `${line} → ${m.id}`, error: `${err.message} (loads nothing; session goes on)` });
          }
        }
      }
    } catch (err) {
      out.push({ line, error: `${err.message} (loads nothing; session goes on)` });
    }
  }
  return out;
}

// Push one local skill into the residency list (validated loudly).
function pushLocal(out, root, id, s, line) {
  const file = path.join(s.dir, 'SKILL.md');
  const fm = frontmatter(fs.readFileSync(file, 'utf8'));
  const invalid = validateResident(fm, file);
  if (invalid) {
    out.push({ line: line || s.rel, error: invalid });
    return;
  }
  const src = nearestSource(s.dir, root);
  out.push({
    line: line || s.rel,
    id,
    where: src ? 'saved' : 'yours',
    origin: src ? src.id : null,
    file,
    fm,
  });
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
  writeFileAtomic(file, body + line.trim() + '\n');
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
  writeFileAtomic(file, kept.join('\n'));
  return removed;
}

function hasLine(root, line) {
  return parse(root).some((e) => e.line === line.trim());
}

module.exports = { triggerFile, parse, expand, residentTokens, addLine, removeLine, hasLine };
