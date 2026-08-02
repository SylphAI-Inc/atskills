'use strict';
// /skills — the management tree, part of the protocol. A filesystem-style
// checkbox tree over .autotrigger and .atskills/: directories are nodes you
// check or uncheck as a whole (one dir line covers every skill under it);
// leaves check individually. Toggling rewrites the same lines a hand edit
// would — no state beyond the files.
//
// Checkbox semantics (shared by the OpenTUI console and this fallback TUI):
//   [x] directly listed          [#] covered by a directory line
//   [~] directory partially on   [ ] off
//   toggle a dir  → add/remove its dir line (adding cleans redundant leaf lines)
//   uncheck a covered leaf → SPLIT: the dir line becomes explicit sibling lines
//   check the last unchecked leaf → COLLAPSE: sibling lines become one dir line

const fs = require('fs');
const path = require('path');
const { walkSkills, frontmatter, nearestSource, safeJoin } = require('./fsx');
const { diskPath, normalizeId } = require('./ids');
const trigger = require('./autotrigger');
const { buildPrompt } = require('./prompt');

// Immediate skill-bearing children of a directory: [{name, path, isSkill}].
// A child is a skill when it holds SKILL.md (leaf rule); otherwise it is a
// deeper directory (kept only if skills live somewhere below it).
function localChildren(root, dirPath) {
  const abs = dirPath ? safeJoin(root, dirPath) : root;
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = dirPath ? `${dirPath}/${e.name}` : e.name;
    const isSkill = fs.existsSync(path.join(abs, e.name, 'SKILL.md'));
    if (isSkill || walkSkills(path.join(abs, e.name)).length) out.push({ name: e.name, path: p, isSkill });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The .autotrigger line that covers a child: skills by path, dirs by path/.
function coverLine(c) {
  return c.isSkill ? c.path : c.path + '/';
}

function collectItems(root) {
  const items = [];
  const localPaths = new Set();
  for (const s of walkSkills(root)) localPaths.add(s.rel);

  const pushSkill = (rel, depth, parentDir) => {
    try {
      normalizeId(rel);
    } catch (err) {
      // a local name the reference grammar can't address — show it, don't lie
      items.push({ kind: 'error', id: rel, line: rel, label: rel, display: rel, depth, parentDir, description: `unaddressable name: ${err.message}`, origin: 'invalid' });
      return;
    }
    const dir = safeJoin(root, rel);
    const fm = frontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    const src = nearestSource(dir, root);
    items.push({
      kind: src ? 'saved' : 'yours',
      line: rel,
      id: rel,
      sourceId: src ? src.id : null,
      label: rel,
      display: depth ? rel.slice(parentDir.length + 1) : rel,
      depth,
      parentDir: parentDir || null,
      description: fm.description || '',
      origin: src ? `from ${src.id} (${src.taken})` : 'yours',
    });
  };

  // Full file tree, any depth. Single-child dir chains compress into one row
  // (GitHub-style), so vendored paths like gh/owner/repo/sub read as one node.
  const walk = (prefix, depth) => {
    for (const c of localChildren(root, prefix)) {
      if (c.isSkill) {
        pushSkill(c.path, depth, prefix);
        continue;
      }
      let p = c.path;
      let name = c.name;
      let kids = localChildren(root, p);
      while (kids.length === 1 && !kids[0].isSkill) {
        name += '/' + kids[0].name;
        p = kids[0].path;
        kids = localChildren(root, p);
      }
      items.push({
        kind: 'dir',
        line: `${p}/`,
        id: `${p}/`,
        label: `${p}/`,
        display: `${name}/`,
        depth,
        parentDir: prefix || null,
        children: walkSkills(safeJoin(root, p)).map((s) => `${p}/${s.rel}`),
        description: `${walkSkills(safeJoin(root, p)).length} skills — one line covers them all`,
        origin: 'yours · directory',
      });
      walk(p, depth + 1);
    }
  };
  walk('', 0);

  for (const e of trigger.parse(root)) {
    if (e.error) {
      items.push({ kind: 'error', id: e.line, line: e.line, label: e.line, display: e.line, depth: 0, description: e.error, origin: 'invalid' });
      continue;
    }
    if (!e.cloud) continue; // local lines are represented by the tree above
    if (localPaths.has(diskPath(e.id))) {
      // CONFLICT surfaced, not hidden: a saved copy AND an @ line exist for
      // the same skill. The copy answers the line (local-first) — mark the
      // local row so the user sees the relation and can drop the line.
      const local = items.find((i) => i.line === diskPath(e.id));
      if (local) {
        local.atLine = e.line;
        local.origin += ' · @ line answers to this copy';
      }
      continue;
    }
    items.push({
      kind: 'cloud',
      line: e.line,
      id: e.id,
      label: e.line,
      display: e.line,
      depth: 0,
      description: e.wholeDir ? 'every skill under this directory' : "follows the provider's latest",
      origin: e.id.startsWith('gh:') ? 'github · auto-updates' : 'hub · auto-updates',
    });
  }
  return items;
}

function coveringAncestor(root, relPath) {
  // Longest ancestor prefix with a dir line — the closest cover.
  const segs = relPath.replace(/\/$/, '').split('/');
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = segs.slice(0, i).join('/');
    if (trigger.hasLine(root, prefix + '/')) return prefix;
  }
  return null;
}

// 'direct' | 'via-dir' | 'partial' | false
function isChecked(root, item) {
  if (item.kind === 'dir') {
    if (trigger.hasLine(root, item.line)) return 'direct';
    if (coveringAncestor(root, item.line)) return 'via-dir';
    const prefix = item.line;
    for (const e of trigger.parse(root)) {
      if (!e.cloud && !e.error && (e.line + '/').startsWith(prefix)) return 'partial';
    }
    return false;
  }
  const line = item.kind === 'cloud' || item.kind === 'browsed' ? item.line || '@' + item.id : item.line;
  if (line && trigger.hasLine(root, line)) return 'direct';
  if (item.atLine && trigger.hasLine(root, item.atLine)) return 'direct'; // fires via its @ line
  if (item.kind === 'browsed' && trigger.hasLine(root, '@' + item.id)) return 'direct';
  const rel = item.kind === 'browsed' ? diskPath(item.id) : item.line;
  if (!rel) return false;
  if (coveringAncestor(root, rel)) return 'via-dir';
  return false;
}

// SPLIT a covering dir line so everything under it stays on EXCEPT targetPath:
// walking from the cover toward the target, each sibling branch gets its own
// coarsest covering line.
function splitCover(root, coverDir, targetPath) {
  trigger.removeLine(root, coverDir + '/');
  let cur = coverDir;
  const rest = targetPath.replace(/\/$/, '').slice(coverDir.length + 1).split('/');
  for (const seg of rest) {
    for (const c of localChildren(root, cur)) {
      if (c.name !== seg) trigger.addLine(root, coverLine(c));
    }
    cur = `${cur}/${seg}`;
  }
}

// COLLAPSE upward: while every child of a directory is individually covered,
// replace the child lines with the one directory line.
function collapseUp(root, startDir) {
  let cur = startDir;
  let collapsed = null;
  while (cur) {
    const kids = localChildren(root, cur);
    if (!kids.length || !kids.every((c) => trigger.hasLine(root, coverLine(c)))) break;
    for (const c of kids) trigger.removeLine(root, coverLine(c));
    trigger.addLine(root, cur + '/');
    collapsed = cur;
    cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
  }
  return collapsed;
}

// The one toggle — filesystem-checkbox semantics at any depth. Returns a
// note describing what was written.
function toggle(root, item) {
  if (item.kind === 'error') return 'fix or remove this line in .autotrigger';

  if (item.kind === 'cloud' || item.kind === 'browsed') {
    const line = item.kind === 'browsed' ? '@' + item.id : item.line;
    if (trigger.hasLine(root, line)) {
      trigger.removeLine(root, line);
      return `removed: ${line}`;
    }
    trigger.addLine(root, line);
    return `added: ${line}`;
  }

  const rel = item.kind === 'dir' ? item.line.replace(/\/$/, '') : item.line;
  const state = isChecked(root, item);

  if (state === 'via-dir') {
    // uncheck under a cover: split every covering ancestor, closest first
    let guard = 0;
    let last = null;
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
      trigger.removeLine(root, item.line);
      return `removed: ${item.line}`;
    }
    // adding the dir line covers the whole subtree — clean descendant lines
    for (const e of trigger.parse(root)) {
      if (!e.cloud && !e.error && (e.line + '/').startsWith(item.line)) trigger.removeLine(root, e.line);
    }
    trigger.addLine(root, item.line);
    const collapsed = item.parentDir ? collapseUp(root, item.parentDir) : null;
    return collapsed
      ? `added: ${item.line} — all of ${collapsed}/ on, collapsed to one line`
      : `added: ${item.line} (covers ${(item.children || []).length} skills)`;
  }

  // local leaf
  if (state === 'direct') {
    if (trigger.hasLine(root, item.line)) {
      trigger.removeLine(root, item.line);
      return `removed: ${item.line}`;
    }
    if (item.atLine && trigger.hasLine(root, item.atLine)) {
      trigger.removeLine(root, item.atLine);
      return `removed @ line ${item.atLine} — your saved copy was answering it`;
    }
    return 'nothing to remove';
  }
  trigger.addLine(root, item.line);
  const parent = item.line.includes('/') ? item.line.slice(0, item.line.lastIndexOf('/')) : '';
  const collapsed = parent ? collapseUp(root, parent) : null;
  return collapsed ? `all of ${collapsed}/ on — collapsed to one line` : `added: ${item.line}`;
}

function boxFor(state) {
  return state === 'direct' ? '[x]' : state === 'via-dir' ? '[#]' : state === 'partial' ? '[~]' : '[ ]';
}

module.exports = { collectItems, isChecked, toggle, boxFor };

// ---------------------------------------------------------------------------
// Fallback ANSI TUI (no Bun/OpenTUI). ATSKILLS_UI=basic forces this.

const CSI = '\x1b[';
const hide = () => process.stdout.write(CSI + '?25l');
const show = () => process.stdout.write(CSI + '?25h');
const clear = () => process.stdout.write(CSI + '2J' + CSI + 'H');
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

async function run(cache, root) {
  if (!process.stdin.isTTY) throw new Error('/skills needs an interactive terminal (try: atskills prompt)');
  let items = collectItems(root);
  if (!items.length) {
    process.stdout.write('no skills yet — write one at .atskills/<name>/SKILL.md, or save one:\n  atskills save gh:owner/repo/path\n');
    return;
  }
  let cursor = 0;
  let mode = 'list';
  let note = '';

  const refresh = () => {
    const keepId = items[cursor] ? items[cursor].id : null;
    items = collectItems(root);
    const idx = keepId ? items.findIndex((i) => i.id === keepId) : -1;
    cursor = idx >= 0 ? idx : Math.min(cursor, Math.max(0, items.length - 1));
  };

  function renderList() {
    clear();
    const out = [];
    out.push(bold('atskills') + dim('  — the @skills console (writes .atskills/.autotrigger)'));
    out.push('');
    items.forEach((item, i) => {
      const box = boxFor(isChecked(root, item));
      const cur = i === cursor ? bold('> ') : '  ';
      const indent = '  '.repeat(item.depth || 0);
      const origin = item.kind === 'cloud' ? yellow(item.origin) : dim(item.origin || '');
      const shown = box.includes('x') || box.includes('#') || box.includes('~') ? green(box) : box;
      out.push(`${cur}${indent}${shown} ${String(item.display).padEnd(44 - indent.length)} ${origin}`);
      if (i === cursor && item.description) out.push(dim(`      ${String(item.description).slice(0, 90)}`));
    });
    out.push('');
    if (note) out.push(yellow(note));
    out.push(dim('up/down move · space toggle · enter view prompt · q quit'));
    process.stdout.write(out.join('\n') + '\n');
  }

  async function renderPrompt() {
    clear();
    const { text, tokens, sections } = await buildPrompt(cache, root);
    const out = [];
    out.push(bold('view prompt') + dim(`  — the index prompt auto-trigger makes resident (~${tokens} tokens)`));
    out.push('');
    out.push(text.trim() ? text.trimEnd() : dim('(nothing auto-triggers — the prompt is empty)'));
    out.push('');
    out.push(bold('read from:'));
    for (const s of sections) {
      if (s.error) out.push(`  x ${s.line}  ${yellow(s.error)}`);
      else out.push(dim(`  | ${s.ref}${s.web ? '  ·  review: ' + s.web : ''}`));
    }
    out.push('');
    out.push(dim('any key to go back'));
    process.stdout.write(out.join('\n') + '\n');
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  hide();
  const restore = () => {
    show();
    try { process.stdin.setRawMode(false); } catch { /* already closed */ }
    process.stdout.write('\n');
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  renderList();

  process.on('exit', show); // cursor always comes back, even on a crash
  await new Promise((done) => {
    process.stdin.on('data', async (buf) => {
      try {
      const key = buf.toString();
      if (mode === 'prompt') {
        mode = 'list';
        renderList();
        return;
      }
      if (key === 'q' || key === '\x03') { restore(); done(); return; }
      if (key === CSI + 'A' || key === 'k') cursor = (cursor - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
      else if (key === CSI + 'B' || key === 'j') cursor = (cursor + 1) % Math.max(1, items.length);
      else if (key === ' ' && items[cursor]) {
        note = toggle(root, items[cursor]);
        refresh();
      } else if (key === '\r') {
        mode = 'prompt';
        await renderPrompt();
        return;
      }
      renderList();
      } catch (err) {
        note = `error: ${err.message}`;
        renderList();
      }
    });
  });
  process.stdin.pause();
}

module.exports.run = run;
