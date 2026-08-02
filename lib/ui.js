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
const { diskPath } = require('./ids');
const trigger = require('./autotrigger');
const { buildPrompt } = require('./prompt');

function childLines(root, dirName) {
  return walkSkills(safeJoin(root, dirName)).map((s) => (s.rel ? `${dirName}/${s.rel}` : dirName));
}

function collectItems(root) {
  const items = [];
  const localPaths = new Set();
  const skills = walkSkills(root);

  const byDir = new Map();
  const singles = [];
  for (const s of skills) {
    localPaths.add(s.rel);
    const seg = s.rel.split('/');
    if (seg.length > 1) {
      const d = seg[0];
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(s);
    } else {
      singles.push(s);
    }
  }

  const pushSkill = (s, depth, parentDir) => {
    const fm = frontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'));
    const src = nearestSource(s.dir, root);
    items.push({
      kind: src ? 'saved' : 'yours',
      line: s.rel,
      id: s.rel,
      sourceId: src ? src.id : null,
      label: s.rel,
      display: depth ? s.rel.slice(parentDir.length + 1) : s.rel,
      depth,
      parentDir: parentDir || null,
      description: fm.description || '',
      origin: src ? `from ${src.id} (${src.taken})` : 'yours',
    });
  };

  for (const [d, list] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.push({
      kind: 'dir',
      line: `${d}/`,
      id: `${d}/`,
      label: `${d}/`,
      display: `${d}/`,
      depth: 0,
      parentDir: null,
      children: list.map((s) => s.rel),
      description: `${list.length} skills — one line covers them all`,
      origin: 'yours · directory',
    });
    for (const s of list) pushSkill(s, 1, d);
  }
  for (const s of singles) pushSkill(s, 0, null);

  for (const e of trigger.parse(root)) {
    if (e.error) {
      items.push({ kind: 'error', line: e.line, label: e.line, display: e.line, depth: 0, description: e.error, origin: 'invalid' });
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

// 'direct' | 'via-dir' | 'partial' | false
function isChecked(root, item) {
  if (item.kind === 'dir') {
    if (trigger.hasLine(root, item.line)) return 'direct';
    if ((item.children || []).some((c) => trigger.hasLine(root, c))) return 'partial';
    return false;
  }
  const line = item.kind === 'cloud' || item.kind === 'browsed' ? item.line || '@' + item.id : item.line;
  if (line && trigger.hasLine(root, line)) return 'direct';
  if (item.atLine && trigger.hasLine(root, item.atLine)) return 'direct'; // fires via its @ line
  if (item.kind === 'browsed' && trigger.hasLine(root, '@' + item.id)) return 'direct';
  const rel = item.kind === 'browsed' ? diskPath(item.id) : item.line;
  if (!rel) return false;
  const segments = rel.split('/');
  for (let i = 1; i < segments.length; i++) {
    if (trigger.hasLine(root, segments.slice(0, i).join('/') + '/')) return 'via-dir';
  }
  return false;
}

// The one toggle — filesystem-checkbox semantics. Returns a note describing
// what was written.
function toggle(root, item) {
  if (item.kind === 'error') return 'fix or remove this line in .autotrigger';

  if (item.kind === 'dir') {
    if (trigger.hasLine(root, item.line)) {
      trigger.removeLine(root, item.line);
      return `removed: ${item.line}`;
    }
    // adding the dir line covers everything — clean now-redundant leaf lines
    for (const c of item.children || childLines(root, item.line.replace(/\/$/, ''))) trigger.removeLine(root, c);
    trigger.addLine(root, item.line);
    return `added: ${item.line} (covers ${(item.children || []).length || 'all'} skills)`;
  }

  if (item.kind === 'cloud' || item.kind === 'browsed') {
    const line = item.kind === 'browsed' ? '@' + item.id : item.line;
    if (trigger.hasLine(root, line)) {
      trigger.removeLine(root, line);
      return `removed: ${line}`;
    }
    trigger.addLine(root, line);
    return `added: ${line}`;
  }

  // local leaf
  const state = isChecked(root, item);
  if (state === 'via-dir') {
    // SPLIT: the covering dir line becomes explicit lines for the siblings
    const dir = item.parentDir;
    trigger.removeLine(root, `${dir}/`);
    for (const sib of childLines(root, dir)) if (sib !== item.line) trigger.addLine(root, sib);
    return `split ${dir}/ — unchecked ${item.display}, siblings stay on`;
  }
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
  if (item.parentDir) {
    // COLLAPSE: if every sibling is now individually on, one dir line replaces them
    const sibs = childLines(root, item.parentDir);
    if (sibs.length > 1 && sibs.every((s) => trigger.hasLine(root, s))) {
      for (const s of sibs) trigger.removeLine(root, s);
      trigger.addLine(root, `${item.parentDir}/`);
      return `all of ${item.parentDir}/ on — collapsed to one line`;
    }
  }
  return `added: ${item.line}`;
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

  await new Promise((done) => {
    process.stdin.on('data', async (buf) => {
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
    });
  });
  process.stdin.pause();
}

module.exports.run = run;
