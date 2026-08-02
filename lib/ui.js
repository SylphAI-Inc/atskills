'use strict';
// /skills — the interactive console, part of the protocol. One CLI app to
// test and manage everything without touching a dotfile:
//
//   up/down  move            space  toggle auto-trigger (writes .autotrigger)
//   g        read the skill  s      save it (= adapt + detach)
//   o        open any path   enter  view prompt (the exact injected text)
//   q        quit
//
// No state of its own — every keystroke writes the same files a hand edit
// would, and every screen is built from the files.

const fs = require('fs');
const path = require('path');
const { walkSkills, frontmatter, nearestSource } = require('./fsx');
const { normalizeId, diskPath } = require('./ids');
const trigger = require('./autotrigger');
const { buildPrompt } = require('./prompt');
const { resolve } = require('./resolve');
const { save } = require('./save');

const CSI = '\x1b[';
const hide = () => process.stdout.write(CSI + '?25l');
const show = () => process.stdout.write(CSI + '?25h');
const clear = () => process.stdout.write(CSI + '2J' + CSI + 'H');
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

function rows() {
  return process.stdout.rows || 30;
}

function collectItems(root, browsed) {
  const items = [];
  const localPaths = new Set();

  for (const s of walkSkills(root)) {
    const fm = frontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'));
    const src = nearestSource(s.dir, root);
    localPaths.add(s.rel);
    items.push({
      line: s.rel,
      id: s.rel,
      sourceId: src ? src.id : null,
      label: s.rel,
      description: fm.description || '',
      origin: src ? `from ${src.id} (${src.taken})` : 'yours',
      kind: src ? 'saved' : 'yours',
    });
  }

  for (const e of trigger.parse(root)) {
    if (e.error) {
      items.push({ line: e.line, label: e.line, description: e.error, origin: 'invalid', kind: 'error' });
      continue;
    }
    if (!e.cloud && localPaths.has(e.line.replace(/\/$/, ''))) continue;
    if (!e.cloud && e.wholeDir) continue;
    if (e.cloud && localPaths.has(diskPath(e.id))) continue; // saved copy already listed
    if (e.cloud) {
      items.push({
        line: e.line,
        id: e.id,
        label: e.line,
        description: e.wholeDir ? 'every skill under this directory' : "follows the provider's latest",
        origin: e.id.startsWith('gh:') ? 'github · auto-updates' : 'hub · auto-updates',
        kind: 'cloud',
      });
    }
  }

  for (const b of browsed) {
    if (items.some((i) => i.id === b.id)) continue;
    items.push(b);
  }
  return items;
}

function isChecked(root, item) {
  if (item.line && trigger.hasLine(root, item.line)) return 'direct';
  if (item.kind === 'browsed' && trigger.hasLine(root, '@' + item.id)) return 'direct';
  const rel = item.kind === 'browsed' ? diskPath(item.id) : item.line;
  if (!rel) return false;
  const segments = rel.split('/');
  for (let i = 1; i < segments.length; i++) {
    if (trigger.hasLine(root, segments.slice(0, i).join('/') + '/')) return 'via-dir';
  }
  return false;
}

module.exports.collectItems = (root) => collectItems(root, []);
module.exports.isChecked = isChecked;

async function run(cache, root) {
  if (!process.stdin.isTTY) throw new Error('/skills needs an interactive terminal (try: atskills prompt)');

  const browsed = [];
  let items = collectItems(root, browsed);
  let cursor = 0;
  let mode = 'list'; // list | prompt | reader | input
  let note = '';
  let input = '';
  let reader = null; // { title, lines, offset }
  let busy = false;

  // The cursor follows the selected ITEM, not its index — lists reorder when
  // toggles/saves move items between groups, and the selection must not jump.
  const refresh = () => {
    const keepId = items[cursor] ? items[cursor].id : null;
    items = collectItems(root, browsed);
    const idx = keepId ? items.findIndex((i) => i.id === keepId) : -1;
    cursor = idx >= 0 ? idx : Math.min(cursor, Math.max(0, items.length - 1));
  };

  function renderList() {
    clear();
    const out = [];
    out.push(bold('/skills') + dim('  — the @skills console (writes .atskills/.autotrigger)'));
    out.push('');
    if (!items.length) out.push(dim('  no skills yet — press o and open one, e.g. gh:sylphai-inc/skills/skills'));
    items.forEach((item, i) => {
      const checked = isChecked(root, item);
      const box = checked === 'direct' ? green('[x]') : checked === 'via-dir' ? green('[#]') : '[ ]';
      const cur = i === cursor ? bold('> ') : '  ';
      const origin = item.kind === 'cloud' || item.kind === 'browsed' ? yellow(item.origin) : dim(item.origin);
      out.push(`${cur}${box} ${item.label.padEnd(44)} ${origin}`);
      if (i === cursor && item.description) out.push(dim(`      ${String(item.description).slice(0, 90)}`));
    });
    out.push('');
    if (mode === 'input') out.push(bold('open path: ') + input + '█');
    else if (busy) out.push(yellow('working…'));
    else if (note) out.push(yellow(note));
    out.push(dim('up/down move · space toggle · g read · s save · o open path · enter view prompt · q quit'));
    process.stdout.write(out.join('\n') + '\n');
  }

  function renderReader() {
    clear();
    const page = rows() - 4;
    const total = reader.lines.length;
    const slice = reader.lines.slice(reader.offset, reader.offset + page);
    const out = [];
    out.push(bold(reader.title) + dim(`  (${Math.min(reader.offset + page, total)}/${total} lines)`));
    out.push('');
    out.push(...slice);
    out.push('');
    out.push(dim('up/down scroll · q/esc back'));
    process.stdout.write(out.join('\n') + '\n');
  }

  async function renderPrompt() {
    clear();
    const { text, tokens, sections } = await buildPrompt(cache, root);
    const out = [];
    out.push(bold('view prompt') + dim(`  — the exact text the model sees at session start (~${tokens} tokens)`));
    out.push('');
    out.push(text.trim() ? text.trimEnd() : dim('(nothing auto-triggers — the prompt is empty)'));
    out.push('');
    out.push(bold('read from:'));
    for (const s of sections) {
      if (s.error) out.push(`  x ${s.line}  ${yellow(s.error)}`);
      else out.push(dim(`  | ${s.ref}`));
    }
    out.push('');
    out.push(dim('any key to go back'));
    process.stdout.write(out.join('\n') + '\n');
  }

  // Open any path: a skill opens the reader; a directory adds its menu to the
  // list as browsed entries you can read, save, or toggle.
  async function openPath(raw) {
    const id = normalizeId(raw);
    const res = await resolve(cache, id, root);
    if (res.kind === 'skill') {
      const where = res.where === 'local'
        ? path.join('.atskills', path.relative(root, res.dir), 'SKILL.md')
        : `${res.url} (${res.status || res.where})`;
      reader = { title: id, lines: [dim(`| read ${where}`), ''].concat(res.text.split('\n')), offset: 0 };
      mode = 'reader';
      return;
    }
    for (const e of res.entries) {
      if (browsed.some((b) => b.id === e.id)) continue;
      browsed.push({
        line: null,
        id: e.id,
        label: e.id,
        description: e.description,
        origin: `${res.where} · browsed`,
        kind: 'browsed',
      });
    }
    note = `opened ${id}/ — ${res.entries.length} skills (${res.where})`;
    refresh();
  }

  async function readItem(item) {
    if (item.kind === 'error') { note = item.description; return; }
    await openPath(item.id);
  }

  async function saveItem(item) {
    const id = item.kind === 'saved' ? item.sourceId : item.kind === 'yours' ? null : item.id;
    if (!id) { note = `${item.label} is the project's own — nothing to save`; return; }
    try {
      const r = await save(cache, id, root);
      note = `${r.action}: .atskills/${diskPath(id)}/ — yours now, detached (rev ${r.revision}` +
        (r.executables.length ? `; scripts: ${r.executables.join(', ')}` : '') + ')';
      if (trigger.hasLine(root, '@' + id)) {
        trigger.removeLine(root, '@' + id);
        trigger.addLine(root, diskPath(id));
        note += ' · flipped @ line to plain';
      }
      refresh();
    } catch (err) {
      note = err.code === 'EDITED' ? err.message : `save failed: ${err.message}`;
    }
  }

  function toggleItem(item) {
    if (item.kind === 'error') { note = 'fix or remove this line in .autotrigger'; return; }
    const line = item.kind === 'browsed' ? '@' + item.id : item.line;
    const checked = isChecked(root, item);
    if (checked === 'via-dir') {
      note = 'covered by a directory line — uncheck that line instead';
    } else if (checked === 'direct') {
      trigger.removeLine(root, item.kind === 'browsed' ? '@' + item.id : item.line);
      note = `removed: ${line}`;
    } else {
      trigger.addLine(root, line);
      note = `added: ${line}`;
    }
    refresh();
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
      if (busy) return;
      const key = buf.toString();

      if (mode === 'prompt') {
        mode = 'list';
        renderList();
        return;
      }

      if (mode === 'reader') {
        const page = rows() - 4;
        if (key === CSI + 'A' || key === 'k') reader.offset = Math.max(0, reader.offset - 1);
        else if (key === CSI + 'B' || key === 'j') reader.offset = Math.min(Math.max(0, reader.lines.length - page), reader.offset + 1);
        else if (key === CSI + '5~') reader.offset = Math.max(0, reader.offset - page);
        else if (key === CSI + '6~') reader.offset = Math.min(Math.max(0, reader.lines.length - page), reader.offset + page);
        else if (key === 'q' || key === '\x1b' || key === '\x03') { mode = 'list'; renderList(); return; }
        renderReader();
        return;
      }

      if (mode === 'input') {
        if (key === '\x1b') { mode = 'list'; input = ''; }
        else if (key === '\r') {
          const value = input.trim();
          mode = 'list';
          input = '';
          if (value) {
            busy = true; renderList();
            try { await openPath(value); } catch (err) { note = `open failed: ${err.message}`; }
            busy = false;
          }
        } else if (key === '\x7f' || key === '\b') input = input.slice(0, -1);
        else if (key >= ' ' && key.length === 1) input += key;
        if (mode === 'reader') renderReader(); else renderList();
        return;
      }

      // list mode
      if (key === 'q' || key === '\x03') { restore(); done(); return; }
      if (key === CSI + 'A' || key === 'k') cursor = (cursor - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
      else if (key === CSI + 'B' || key === 'j') cursor = (cursor + 1) % Math.max(1, items.length);
      else if (key === ' ' && items[cursor]) toggleItem(items[cursor]);
      else if (key === 'g' && items[cursor]) {
        busy = true; renderList();
        try { await readItem(items[cursor]); } catch (err) { note = `read failed: ${err.message}`; }
        busy = false;
        if (mode === 'reader') { renderReader(); return; }
      } else if (key === 's' && items[cursor]) {
        busy = true; renderList();
        await saveItem(items[cursor]);
        busy = false;
      } else if (key === 'o') {
        mode = 'input';
        input = '';
      } else if (key === '\r') {
        mode = 'prompt';
        busy = true;
        await renderPrompt();
        busy = false;
        return;
      }
      renderList();
    });
  });
  process.stdin.pause();
}

module.exports.run = run;
