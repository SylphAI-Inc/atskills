/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * `/skills` — the management tree, part of the protocol. A filesystem-style
 * checkbox tree over `.autotrigger` and `.atskills/`: directories are nodes
 * you check or uncheck as a whole (one dir line covers every skill under it);
 * leaves check individually. Toggling rewrites the same lines a hand edit
 * would — no state beyond the files.
 *
 * Checkbox semantics (shared with the atskills reference console):
 *   [x] directly listed          [#] covered by a directory line
 *   [~] directory partially on   [ ] off
 *   toggle a dir  → add/remove its dir line (adding cleans redundant leaf lines)
 *   uncheck a covered leaf → SPLIT: the dir line becomes explicit sibling lines
 *   check a leaf → that leaf's line only — NEVER auto-promoted to a dir line
 *   (a dir/ line covers FUTURE skills too; only an explicit dir check says that)
 *
 * Ported from SylphAI-Inc/atskills lib/ui.js.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ignoreModule from 'ignore';
import type { SkillTreeItem, SkillCheckState } from './types.js';
import { diskPath, normalizeId } from './ids.js';
import { frontmatter, nearestSource, safeJoin, walkSkills } from './fsx.js';
import { addTriggerLine, hasTriggerLine, parseTriggers, removeTriggerLine } from './autotrigger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop
const ignore = ((ignoreModule as any).default || ignoreModule) as () => ignoreModule.Ignore;

interface Child {
  name: string;
  path: string;
  isSkill: boolean;
}

/**
 * Immediate skill-bearing children of a directory. A child is a skill when it
 * holds SKILL.md (leaf rule); otherwise it is a deeper directory (kept only
 * if skills live somewhere below it).
 */
function localChildren(root: string, dirPath: string): Child[] {
  const abs = dirPath ? safeJoin(root, dirPath) : root;
  if (!fs.existsSync(abs)) return [];
  const out: Child[] = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = dirPath ? `${dirPath}/${e.name}` : e.name;
    const isSkill = fs.existsSync(path.join(abs, e.name, 'SKILL.md'));
    if (isSkill || walkSkills(path.join(abs, e.name)).length > 0) out.push({ name: e.name, path: p, isSkill });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The .autotrigger line that covers a child: skills by path, dirs by path/. */
function coverLine(c: Child): string {
  return c.isSkill ? c.path : `${c.path}/`;
}

/**
 * The whole management tree: every local skill at its depth (single-child dir
 * chains compressed into one row, GitHub-style), every followed cloud line,
 * every broken line — nothing hidden. `checked` is computed here so a
 * renderer needs no filesystem at all.
 */
export function collectTreeItems(root: string): SkillTreeItem[] {
  const items: SkillTreeItem[] = [];
  const localPaths = new Set<string>();
  for (const s of walkSkills(root)) localPaths.add(s.rel);

  const pushSkill = (rel: string, depth: number, parentDir: string): void => {
    try {
      normalizeId(rel);
    } catch (err) {
      // a local name the reference grammar can't address — show it, don't lie
      items.push({
        kind: 'error', id: rel, line: rel, display: rel, depth,
        description: `unaddressable name: ${err instanceof Error ? err.message : String(err)}`,
        origin: 'invalid', checked: false,
      });
      return;
    }
    const dir = safeJoin(root, rel);
    // The dir can vanish between walkSkills and this read (concurrent
    // /skills remove, background checkout) — skip it rather than throwing
    // the whole tree away.
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    } catch {
      return;
    }
    const fm = frontmatter(raw);
    const src = nearestSource(dir, root);
    items.push({
      kind: src ? 'saved' : 'yours',
      line: rel,
      id: rel,
      display: depth ? rel.slice(parentDir.length + 1) : rel,
      depth,
      parentDir,
      sourceId: src ? src.id : null,
      description: fm.description ?? '',
      origin: src ? `from ${src.id} (${src.taken})` : 'yours',
      checked: false,
    });
  };

  const walk = (prefix: string, depth: number): void => {
    for (const c of localChildren(root, prefix)) {
      if (c.isSkill) {
        pushSkill(c.path, depth, prefix);
        continue;
      }
      let p = c.path;
      let name = c.name;
      let kids = localChildren(root, p);
      while (kids.length === 1 && !kids[0].isSkill) {
        name += `/${kids[0].name}`;
        p = kids[0].path;
        kids = localChildren(root, p);
      }
      const covered = walkSkills(safeJoin(root, p));
      items.push({
        kind: 'dir',
        line: `${p}/`,
        id: `${p}/`,
        display: `${name}/`,
        depth,
        parentDir: prefix,
        children: covered.map((s) => `${p}/${s.rel}`),
        description: `${covered.length} skills — one line covers them all`,
        origin: 'directory',
        checked: false,
      });
      walk(p, depth + 1);
    }
  };
  walk('', 0);

  for (const e of parseTriggers(root)) {
    if (e.error) {
      items.push({ kind: 'error', id: e.line, line: e.line, display: e.line, depth: 0, description: e.error, origin: 'invalid', checked: false });
      continue;
    }
    if (!e.cloud) continue; // local lines are represented by the tree above
    const id = e.id as string;
    if (localPaths.has(diskPath(id))) {
      // CONFLICT surfaced, not hidden: a saved copy AND an @ line exist for
      // the same skill. The copy answers the line (local-first) — mark the
      // local row so the user sees the relation and can drop the line.
      const local = items.find((i) => i.line === diskPath(id));
      if (local) {
        local.atLine = e.line;
        local.origin += ' · @ line answers to this copy';
      }
      continue;
    }
    items.push({
      kind: 'cloud',
      line: e.line,
      id,
      display: e.line,
      depth: 0,
      description: e.wholeDir ? 'every skill under this directory' : "follows the provider's latest",
      origin: id.startsWith('gh:') ? 'github · auto-updates' : 'hub · auto-updates',
      checked: false,
    });
  }

  for (const item of items) item.checked = isChecked(root, item);
  return items;
}

/** Longest ancestor prefix with a dir line — the closest cover. */
function coveringAncestor(root: string, relPath: string): string | null {
  const segs = relPath.replace(/\/$/, '').split('/');
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = segs.slice(0, i).join('/');
    if (hasTriggerLine(root, `${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * A plain line whose gitignore PATTERN matches rel (globs, negation) without
 * being an exact ancestor-dir line — same matcher resolution uses, so the
 * tree can never disagree with what actually loads.
 */
function coveringPattern(root: string, rel: string): string | null {
  const entries = parseTriggers(root).filter((e) => !e.cloud && !e.error && e.line !== rel);
  if (entries.length === 0) return null;
  if (!ignore().add(entries.map((e) => e.pattern as string)).ignores(rel)) return null;
  for (const e of entries) {
    if (ignore().add([e.pattern as string]).ignores(rel)) return e.line;
  }
  return null;
}

function isChecked(root: string, item: SkillTreeItem): SkillCheckState {
  if (item.kind === 'dir') {
    if (hasTriggerLine(root, item.line)) return 'direct';
    if (coveringAncestor(root, item.line)) return 'via-dir';
    for (const e of parseTriggers(root)) {
      if (!e.cloud && !e.error && `${e.line}/`.startsWith(item.line)) return 'partial';
    }
    return false;
  }
  if (item.kind === 'cloud') return hasTriggerLine(root, item.line) ? 'direct' : false;
  if (hasTriggerLine(root, item.line)) return 'direct';
  if (item.atLine && hasTriggerLine(root, item.atLine)) return 'direct'; // fires via its @ line
  if (coveringAncestor(root, item.line)) return 'via-dir';
  if (coveringPattern(root, item.line)) return 'via-dir'; // glob/negation lines cover too
  return false;
}

/**
 * SPLIT a covering dir line so everything under it stays on EXCEPT
 * targetPath: walking from the cover toward the target, each sibling branch
 * gets its own coarsest covering line.
 */
function splitCover(root: string, coverDir: string, targetPath: string): void {
  removeTriggerLine(root, `${coverDir}/`);
  let cur = coverDir;
  const rest = targetPath.replace(/\/$/, '').slice(coverDir.length + 1).split('/');
  for (const seg of rest) {
    for (const c of localChildren(root, cur)) {
      if (c.name !== seg) addTriggerLine(root, coverLine(c));
    }
    cur = `${cur}/${seg}`;
  }
}

// NOTE: there is deliberately NO auto-collapse. Checking every child of a
// directory individually is NOT the same statement as checking the directory:
// a `dir/` line also covers skills added in the future. Only an explicit
// check of the directory node itself may write that line — never assume.

/**
 * The one toggle — filesystem-checkbox semantics at any depth. Returns a
 * note describing what was written (shown in the dialog's status row).
 */
export function toggleTreeItem(root: string, itemId: string): string {
  const items = collectTreeItems(root);
  // Dir rows are spelled with a trailing slash (their line). A typed
  // `/skills toggle team-flows` means the directory when no leaf answers.
  const item = items.find((i) => i.id === itemId) ?? items.find((i) => i.id === `${itemId}/`);
  if (!item) return `no row for '${itemId}' — the tree may have changed`;
  if (item.kind === 'error') return 'fix or remove this line in .autotrigger';

  if (item.kind === 'cloud') {
    if (hasTriggerLine(root, item.line)) {
      removeTriggerLine(root, item.line);
      return `removed: ${item.line}`;
    }
    addTriggerLine(root, item.line);
    return `added: ${item.line}`;
  }

  const rel = item.kind === 'dir' ? item.line.replace(/\/$/, '') : item.line;
  const state = item.checked;

  if (state === 'via-dir') {
    // a glob/negation pattern can't be split mechanically — point at the line
    if (!coveringAncestor(root, rel)) {
      const p = coveringPattern(root, rel);
      return `covered by pattern "${p}" — edit .autotrigger to change this`;
    }
    // uncheck under a cover: split every covering ancestor, closest first
    let guard = 0;
    let last: string | null = null;
    while (guard++ < 32) {
      const cover = coveringAncestor(root, rel);
      if (!cover) break;
      splitCover(root, cover, rel);
      last = cover;
    }
    return `split ${last}/ — unchecked ${item.display}, siblings stay on`;
  }

  if (item.kind === 'dir') {
    if (state === 'direct') {
      removeTriggerLine(root, item.line);
      return `removed: ${item.line}`;
    }
    // adding the dir line covers the whole subtree — clean descendant lines
    for (const e of parseTriggers(root)) {
      if (!e.cloud && !e.error && `${e.line}/`.startsWith(item.line)) removeTriggerLine(root, e.line);
    }
    addTriggerLine(root, item.line);
    return `added: ${item.line} (covers ${(item.children ?? []).length} skills, present and future)`;
  }

  // local leaf
  if (state === 'direct') {
    if (hasTriggerLine(root, item.line)) {
      removeTriggerLine(root, item.line);
      return `removed: ${item.line}`;
    }
    if (item.atLine && hasTriggerLine(root, item.atLine)) {
      removeTriggerLine(root, item.atLine);
      return `removed @ line ${item.atLine} — your saved copy was answering it`;
    }
    return 'nothing to remove';
  }
  // checking a leaf writes that leaf's line, nothing more — even if it's the
  // last unchecked child, we never promote to a dir/ line on our own
  addTriggerLine(root, item.line);
  return `added: ${item.line}`;
}

/** The checkbox a state renders as — shared vocabulary with the reference. */
export function checkboxFor(state: SkillCheckState): string {
  return state === 'direct' ? '[x]' : state === 'via-dir' ? '[#]' : state === 'partial' ? '[~]' : '[ ]';
}
