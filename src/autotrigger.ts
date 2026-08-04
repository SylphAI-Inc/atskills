/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * `.atskills/.autotrigger` — one file, the whole install lifecycle.
 *
 * Works like `.gitignore`: one entry per line, `#` for comments.
 *   plain (`sec-checklist`, `team-flows/`) → a gitignore PATTERN over the
 *     local tree under `.atskills/` — globs and `!` negation included.
 *   `@sylphai/glowmotion`  → the hub
 *   `@gh:stripe/toolkit`   → GitHub
 *   trailing `/`           → every skill under that directory
 *
 * Install = adding a line; uninstall = removing it. Every line resolves
 * local-first, so a saved copy answers its own `@` line, and per-line failures
 * are isolated — a line that can't load reports once and the session goes on.
 *
 * Ported from SylphAI-Inc/atskills lib/autotrigger.js.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ignoreModule from 'ignore';
import { AUTOTRIGGER_FILE, diskPath, normalizeId } from './ids.js';
import { frontmatter, nearestSource, safeJoin, walkSkills, writeFileAtomic, type Frontmatter } from './fsx.js';

// The `ignore` package ships a default export under CJS interop — same shim
// the core gitignore parser uses. Plain lines ARE gitignore patterns, so git's
// own matcher is the specification, not an approximation of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop
const ignore = ((ignoreModule as any).default || ignoreModule) as () => ignoreModule.Ignore;

export interface TriggerEntry {
  /** The line as written, comments and surrounding space stripped. */
  line: string;
  cloud: boolean;
  /** Canonical ID (cloud lines only). */
  id?: string;
  /** gitignore pattern (plain lines only). */
  pattern?: string;
  wholeDir?: boolean;
  /** Set when the line could not be parsed — reported, never fatal. */
  error?: string;
}

export interface ResidentSkill {
  line: string;
  id?: string;
  where?: 'yours' | 'saved' | 'cloud';
  /** `.source` line 1, for a saved copy. */
  origin?: string | null;
  file?: string;
  fm?: Frontmatter;
  error?: string;
}

export function triggerFilePath(skillsRoot: string): string {
  return path.join(skillsRoot, AUTOTRIGGER_FILE);
}

/**
 * Parse the file. Comments and blanks drop; exact duplicate lines collapse
 * (they load once); order is preserved.
 */
/**
 * gitignore semantics: `#` introduces a comment only at the start of a line
 * (after leading whitespace); a `#` inside a pattern is a literal character —
 * a skill named `c#-patterns` must keep its full name.
 */
function effectiveLine(raw: string): string {
  const line = raw.trim();
  return line.startsWith('#') ? '' : line;
}

export function parseTriggers(skillsRoot: string): TriggerEntry[] {
  const file = triggerFilePath(skillsRoot);
  if (!fs.existsSync(file)) return [];
  const seen = new Set<string>();
  const entries: TriggerEntry[] = [];
  for (const rawLine of fs.readFileSync(file, 'utf-8').split('\n')) {
    const line = effectiveLine(rawLine);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    if (!line.startsWith('@')) {
      entries.push({ line, cloud: false, pattern: line });
      continue;
    }
    const body = line.slice(1);
    const wholeDir = body.endsWith('/');
    try {
      entries.push({ line, cloud: true, id: normalizeId(body), wholeDir });
    } catch (e) {
      entries.push({ line, cloud: true, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return entries;
}

/**
 * What actually loads at session start, for the LOCAL half of the file:
 * plain lines matched as one gitignore ruleset over the skill tree, plus any
 * `@` line a saved copy answers. Cloud lines with no local copy are left to
 * the caller (they need the network); they appear here as `where: 'cloud'`
 * placeholders so the count and ordering stay honest.
 */
export function expandLocalTriggers(skillsRoot: string): ResidentSkill[] {
  const out: ResidentSkill[] = [];
  const entries = parseTriggers(skillsRoot);
  for (const e of entries) if (e.error) out.push({ line: e.line, error: e.error });

  const plain = entries.filter((e) => !e.error && !e.cloud);
  const allLocal = walkSkills(skillsRoot);
  const loadedDirs = new Set<string>();

  if (plain.length > 0) {
    const ig = ignore().add(plain.map((e) => e.pattern as string));
    for (const s of allLocal) {
      if (!ig.ignores(s.rel)) continue;
      loadedDirs.add(s.dir);
      pushLocal(out, skillsRoot, s.rel, s.dir);
    }
    for (const e of plain) {
      const pattern = e.pattern as string;
      if (pattern.startsWith('!')) continue; // a negation matches nothing by design
      const one = ignore().add([pattern]);
      if (!allLocal.some((s) => one.ignores(s.rel))) {
        out.push({ line: e.line, error: `matches nothing under .atskills/` });
      }
    }
  }

  for (const entry of entries.filter((e) => !e.error && e.cloud)) {
    const id = entry.id as string;
    let localDir: string;
    try {
      localDir = safeJoin(skillsRoot, diskPath(id));
    } catch (e) {
      out.push({ line: entry.line, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const localSkills = walkSkills(localDir);
    if (localSkills.length > 0) {
      // local-first: a saved copy answers its own @ line
      for (const s of localSkills) {
        if (loadedDirs.has(s.dir)) continue; // one skill loads once
        loadedDirs.add(s.dir);
        pushLocal(out, skillsRoot, s.rel ? `${id}/${s.rel}` : id, s.dir, entry.line);
      }
    } else {
      out.push({ line: entry.line, id, where: 'cloud' });
    }
  }
  return out;
}

function pushLocal(out: ResidentSkill[], skillsRoot: string, id: string, dir: string, line?: string): void {
  const file = path.join(dir, 'SKILL.md');
  let fm: Frontmatter;
  try {
    fm = frontmatter(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    out.push({ line: line ?? id, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!fm.name || !fm.description) {
    out.push({
      line: line ?? id,
      error:
        `SKILL.md at ${file} is missing frontmatter (name + description), which the skills index ` +
        `requires — skill skipped`,
    });
    return;
  }
  const src = nearestSource(dir, skillsRoot);
  out.push({ line: line ?? id, id, where: src ? 'saved' : 'yours', origin: src ? src.id : null, file, fm });
}

// ─── Editing — suffixes, dialog checkboxes and hand edits write the same lines ─

/** Append a line if it isn't already there. Returns false when it was. */
export function addTriggerLine(skillsRoot: string, line: string): boolean {
  const file = triggerFilePath(skillsRoot);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const target = line.trim();
  if (current.split('\n').some((l) => effectiveLine(l) === target)) return false;
  const body = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current;
  fs.mkdirSync(skillsRoot, { recursive: true });
  writeFileAtomic(file, body + target + '\n');
  return true;
}

/** Drop a line. Returns false when it wasn't present. */
export function removeTriggerLine(skillsRoot: string, line: string): boolean {
  const file = triggerFilePath(skillsRoot);
  if (!fs.existsSync(file)) return false;
  const target = line.trim();
  let removed = false;
  const kept = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((raw) => {
      if (effectiveLine(raw) === target) {
        removed = true;
        return false;
      }
      return true;
    });
  if (removed) writeFileAtomic(file, kept.join('\n'));
  return removed;
}

export function hasTriggerLine(skillsRoot: string, line: string): boolean {
  return parseTriggers(skillsRoot).some((e) => e.line === line.trim());
}

/**
 * The line `:install` writes for an ID: the `@` cloud form, unless a saved
 * copy sits at the ID's path — then the plain local path, so the file reads
 * true. (The copy answers either way; this is purely honesty.)
 */
export function installLineFor(skillsRoot: string, id: string): string {
  const disk = diskPath(id);
  try {
    if (walkSkills(safeJoin(skillsRoot, disk)).length > 0) return disk;
  } catch {
    // escaping path — fall through to the cloud form, which normalizeId vetted
  }
  return `@${id}`;
}
