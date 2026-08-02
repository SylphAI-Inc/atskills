'use strict';
// /skills — the management UI, part of the protocol. A checkbox tree over
// .autotrigger and .atskills/ for people who will never hand-edit a dotfile,
// plus "view prompt": the exact injected text, with the file/URL each entry
// was read from. No state of its own — every keystroke writes the same files
// a hand edit would.
//
// Keys:  up/down move · space toggle auto-trigger · enter view prompt · q quit

const fs = require('fs');
const path = require('path');
const { walkSkills, frontmatter, nearestSource } = require('./fsx');
const trigger = require('./autotrigger');
const { buildPrompt } = require('./prompt');

const CSI = '\x1b[';
const hide = () => process.stdout.write(CSI + '?25l');
const show = () => process.stdout.write(CSI + '?25h');
const clear = () => process.stdout.write(CSI + '2J' + CSI + 'H');
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;

function collectItems(root) {
  const items = [];
  const localPaths = new Set();

  for (const s of walkSkills(root)) {
    const fm = frontmatter(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'));
    const src = nearestSource(s.dir, root);
    localPaths.add(s.rel);
    items.push({
      line: s.rel,
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
    if (!e.cloud && localPaths.has(e.line.replace(/\/$/, ''))) continue; // already listed as a local skill
    if (!e.cloud && e.wholeDir) continue; // directory lines cover their children above
    if (e.cloud) {
      items.push({
        line: e.line,
        label: e.line,
        description: e.wholeDir ? 'every skill under this directory' : "follows the provider's latest",
        origin: e.id.startsWith('gh:') ? 'github · auto-updates' : 'hub · auto-updates',
        kind: 'cloud',
      });
    }
  }
  return items;
}

function isChecked(root, item) {
  if (trigger.hasLine(root, item.line)) return 'direct';
  // A parent directory line covers this skill.
  const segments = item.line.split('/');
  for (let i = 1; i < segments.length; i++) {
    if (trigger.hasLine(root, segments.slice(0, i).join('/') + '/')) return 'via-dir';
  }
  return false;
}

function renderList(root, items, cursor, note) {
  clear();
  const out = [];
  out.push(bold('/skills') + dim('  — what fires on its own (writes .atskills/.autotrigger)'));
  out.push('');
  items.forEach((item, i) => {
    const checked = isChecked(root, item);
    const box = checked === 'direct' ? green('[x]') : checked === 'via-dir' ? green('[#]') : '[ ]';
    const cur = i === cursor ? bold('> ') : '  ';
    const origin = item.kind === 'cloud' ? yellow(item.origin) : dim(item.origin);
    out.push(`${cur}${box} ${item.label.padEnd(36)} ${origin}`);
    if (i === cursor && item.description) out.push(dim(`      ${item.description}`));
  });
  out.push('');
  if (note) out.push(yellow(note));
  out.push(dim('up/down move · space toggle · enter view prompt · q quit'));
  process.stdout.write(out.join('\n') + '\n');
}

async function renderPrompt(cache, root) {
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

async function run(cache, root) {
  if (!process.stdin.isTTY) throw new Error('/skills needs an interactive terminal (try: atskills prompt)');
  let items = collectItems(root);
  if (!items.length) {
    process.stdout.write(
      'no skills yet — write one at .atskills/<name>/SKILL.md, or save one:\n  atskills save gh:owner/repo/path\n'
    );
    return;
  }
  let cursor = 0;
  let mode = 'list';
  let note = '';

  process.stdin.setRawMode(true);
  process.stdin.resume();
  hide();
  const restore = () => {
    show();
    try { process.stdin.setRawMode(false); } catch { /* already closed */ }
    process.stdout.write('\n');
  };
  process.on('SIGINT', () => { restore(); process.exit(130); });

  renderList(root, items, cursor, note);

  await new Promise((done) => {
    process.stdin.on('data', async (buf) => {
      const key = buf.toString();
      if (mode === 'prompt') {
        mode = 'list';
        renderList(root, items, cursor, note);
        return;
      }
      if (key === 'q' || key === '\x03') {
        restore();
        done();
        return;
      }
      if (key === CSI + 'A' || key === 'k') cursor = (cursor - 1 + items.length) % items.length;
      else if (key === CSI + 'B' || key === 'j') cursor = (cursor + 1) % items.length;
      else if (key === ' ') {
        const item = items[cursor];
        const checked = isChecked(root, item);
        if (checked === 'via-dir') {
          note = `covered by a directory line — uncheck the ${item.line.split('/')[0]}/ line instead`;
        } else if (checked === 'direct') {
          trigger.removeLine(root, item.line);
          note = `removed: ${item.line}`;
        } else {
          trigger.addLine(root, item.line);
          note = `added: ${item.line}`;
        }
        items = collectItems(root);
        if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
      } else if (key === '\r') {
        mode = 'prompt';
        await renderPrompt(cache, root);
        return;
      }
      renderList(root, items, cursor, note);
    });
  });
  process.stdin.pause();
}

module.exports = { run, collectItems, isChecked };
