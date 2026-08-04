/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Filesystem helpers shared by the @skills implementation.
 * Ported from SylphAI-Inc/atskills lib/fsx.js.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SOURCE_FILE } from './ids.js';

/**
 * Join a relative path under root, refusing anything that escapes it — the
 * defense against `..` smuggled through a reference or a config line.
 */
export function safeJoin(root: string, rel: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes the skills directory: ${rel}`);
  }
  return abs;
}

/**
 * The nearest `.atskills/` at or above `start`, or null. Same walk-up rule as
 * git's repo discovery: a skill command run in a subdirectory finds the
 * project's skills root.
 */
export function findAtskills(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, '.atskills');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface Frontmatter {
  name: string | null;
  description: string | null;
}

/**
 * Parse SKILL.md frontmatter. Tolerates CRLF, quoted values, and YAML block
 * scalars (`description: >-` folded over following indented lines). Only
 * `name` and `description` matter to the protocol — two fields don't justify
 * a YAML dependency.
 */
export function frontmatter(text: string): Frontmatter {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalized);
  const out: Frontmatter = { name: null, description: null };
  if (!m) return out;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      value = parts.join(' ');
    }
    out[kv[1] as 'name' | 'description'] = value.replace(/^["']|["']$/g, '') || null;
  }
  return out;
}

export interface FoundSkill {
  /** Path relative to the walk root, posix separators. '' for the root itself. */
  rel: string;
  dir: string;
}

/**
 * The one directory that is never content: git's own object store. It is
 * already filtered when saving, and holds no SKILL.md by construction.
 *
 * Every other directory is walked, INCLUDING dot-dirs — `.claude/skills/`,
 * `.agents/`, `.gemini/`, `.kiro/` and `.atskills/` are where the ecosystem
 * publishes, and hold ~12% of all skills. Skipping every dot-dir also made
 * local resolution disagree with remote listing (the GitHub trees API has no
 * such filter), so a skill visible on GitHub vanished once it was saved.
 *
 * Protocol: atskills PROTOCOL.md §8.2.1 (source of truth — change it there).
 */
const SKIP_DIRS = new Set(['.git']);

/**
 * Walk for skills under dir. A skill is a folder holding SKILL.md, and the
 * walk stops there (leaf rule). Dot FILES (.source, .autotrigger) are metadata
 * and are never skills; dot-DIRS are walked — see SKIP_DIRS.
 */
export function walkSkills(dir: string, rel = ''): FoundSkill[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return [{ rel, dir }];
  const found: FoundSkill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    found.push(...walkSkills(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
  }
  return found;
}

/**
 * The leaf rule applied to a flat path list instead of a live directory —
 * what `walkSkills` would find, computed from `git ls-tree` output before
 * anything is downloaded.
 *
 * A skill is a folder holding SKILL.md and the walk STOPS there, so a
 * SKILL.md nested inside another skill's bundle is that bundle's file, not a
 * second skill. Dot-dirs are metadata and never count. Returns the skill
 * directories, posix-relative, '' for the root itself.
 *
 * Kept pure and separate from walkSkills so the pre-download count and the
 * post-download walk cannot drift apart — they are the same rule, and a cap
 * enforced on a different count than the menu shows would be a lie.
 */
export function leafSkillDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const raw of paths) {
    const p = raw.trim().replace(/^\.\//, '');
    if (!p.endsWith('SKILL.md')) continue;
    const dir = p.slice(0, Math.max(0, p.length - 'SKILL.md'.length)).replace(/\/$/, '');
    // Same rule as walkSkills — the pre-download count and the menu it guards
    // must apply identical filters, or the cap is enforced on a number the
    // reader never sees.
    if (dir.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    dirs.add(dir);
  }
  // Leaf rule: drop any dir that sits inside another skill dir.
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

export interface SourceStamp {
  /** Line 1 — the cloud ID this copy came from. */
  id: string;
  /** Line 2's date part (`YYYY-MM-DD`), or the whole line when unparsable. */
  taken: string;
  /** Line 2's revision, or null when the stamp predates/omits one. */
  revision: string | null;
  file: string;
}

function parseSource(file: string): SourceStamp {
  const [id, line2 = ''] = fs.readFileSync(file, 'utf-8').trim().split('\n');
  const m = /^(\S+)\s+rev:(\S+)$/.exec(line2.trim());
  return { id: id.trim(), taken: m ? m[1] : line2.trim(), revision: m ? m[2] : null, file };
}

/**
 * Nearest `.source` at or above `dir`, stopping at root — a directory save
 * writes one stamp at the subtree top, so the closest stamp above a skill is
 * its origin. Pure provenance: nothing resolves against it.
 */
export function nearestSource(dir: string, root: string): SourceStamp | null {
  let cur = path.resolve(dir);
  const stop = path.resolve(root);
  for (;;) {
    const f = path.join(cur, SOURCE_FILE);
    if (fs.existsSync(f)) {
      try {
        return parseSource(f);
      } catch {
        return null;
      }
    }
    if (cur === stop) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Write the two-line stamp: the cloud ID, then the revision taken. */
export function writeSource(dest: string, id: string, revision: string): void {
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, SOURCE_FILE), `${id}\n${today} rev:${revision}\n`, 'utf-8');
}

/** Non-dot files of a tree, as sorted relative posix paths. */
export function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

/** Top-level entries of a skill dir, dirs marked with a trailing slash. */
export function bundleEntries(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'SKILL.md')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return [];
  }
}

export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** Run fn over items with bounded concurrency — the network fan-out helper. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** All writes go through tmp+rename — a crash can never leave a partial file. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}
