'use strict';
// Fallback ANSI TUI for `atskills skills` (no Bun/OpenTUI required).
// ATSKILLS_UI=basic forces this. Pure porcelain: every protocol operation is
// a dist/ call — the tree, the toggles, and the prompt block all come from
// the one implementation.

const path = require('path');
const A = require('../dist/index.js');

const CSI = '\x1b[';
const hide = () => process.stdout.write(CSI + '?25l');
const show = () => process.stdout.write(CSI + '?25h');
const clear = () => process.stdout.write(CSI + '2J' + CSI + 'H');
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

async function run(root) {
  if (!process.stdin.isTTY) throw new Error('/skills needs an interactive terminal (try: atskills prompt)');
  let items = A.collectTreeItems(root);
  if (!items.length) {
    process.stdout.write('no skills yet — write one at .atskills/<name>/SKILL.md, or save one:\n  atskills save gh:owner/repo/path\n');
    return;
  }
  let cursor = 0;
  let mode = 'list';
  let note = '';

  const refresh = () => {
    const keepId = items[cursor] ? items[cursor].id : null;
    items = A.collectTreeItems(root);
    const idx = keepId ? items.findIndex((i) => i.id === keepId) : -1;
    cursor = idx >= 0 ? idx : Math.min(cursor, Math.max(0, items.length - 1));
  };

  function renderList() {
    clear();
    const out = [];
    out.push(bold('atskills') + dim('  — the @skills console (writes .atskills/.autotrigger)'));
    out.push('');
    items.forEach((item, i) => {
      const box = A.checkboxFor(item.checked);
      const cur = i === cursor ? bold('> ') : '  ';
      const indent = '  '.repeat(item.depth || 0);
      const origin = item.kind === 'cloud' ? yellow(item.origin) : dim(item.origin || '');
      const shown = box === '[ ]' ? box : green(box);
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
    const notes = [];
    const text = await A.buildAutotriggerIndex({
      workingDir: path.dirname(root),
      cacheDir: process.env.ATSKILLS_CACHE || undefined,
      log: { info: () => {}, warn: (m) => notes.push(m) },
    });
    const out = [];
    out.push(bold('view prompt') + dim(`  — the index prompt auto-trigger makes resident (~${Math.ceil(text.length / 4)} tokens)`));
    out.push('');
    out.push(text.trim() ? text.trimEnd() : dim('(nothing auto-triggers — the prompt is empty)'));
    if (notes.length) {
      out.push('');
      out.push(bold('problems:'));
      for (const n of notes) out.push(`  x ${yellow(n)}`);
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
          note = A.toggleTreeItem(root, items[cursor].id);
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

module.exports = { run };
