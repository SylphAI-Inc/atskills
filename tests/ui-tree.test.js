'use strict';
// The management tree — dist/tree.js (the one implementation; the TUIs and
// any host dialog render exactly these items and toggle through this call).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectTreeItems, toggleTreeItem, addTriggerLine, hasTriggerLine } = require('../dist/index.js');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-tree-'));
  fs.mkdirSync(path.join(root, '.atskills'), { recursive: true });
  return path.join(root, '.atskills');
}
function skill(root, rel, name) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: about ${name}\n---\n`);
  return dir;
}
// `checked` is computed at collection time — re-collect after every toggle.
function row(root, line) {
  return collectTreeItems(root).find((i) => i.line === line);
}

test('filesystem tree: dir node, split, collapse', () => {
  const root = project();
  skill(root, 'writing/commit-messages', 'commit-messages');
  skill(root, 'writing/pr-descriptions', 'pr-descriptions');
  skill(root, 'my-checklist', 'my-checklist');

  const dir = collectTreeItems(root).find((i) => i.kind === 'dir');
  assert.equal(dir.line, 'writing/');
  assert.deepEqual(dir.children.sort(), ['writing/commit-messages', 'writing/pr-descriptions']);

  // check the dir node → one covering line
  toggleTreeItem(root, dir.id);
  assert.equal(hasTriggerLine(root, 'writing/'), true);
  assert.equal(row(root, 'writing/commit-messages').checked, 'via-dir');
  assert.equal(row(root, 'writing/').checked, 'direct');

  // uncheck a covered leaf → SPLIT: dir line out, sibling line in
  assert.match(toggleTreeItem(root, 'writing/commit-messages'), /split writing\//);
  assert.equal(hasTriggerLine(root, 'writing/'), false);
  assert.equal(hasTriggerLine(root, 'writing/pr-descriptions'), true);
  assert.equal(row(root, 'writing/commit-messages').checked, false);
  assert.equal(row(root, 'writing/').checked, 'partial');

  // re-check the leaf → its own line only. NEVER auto-collapsed to a dir line:
  // a dir/ line also covers future skills, which the user did not opt into.
  assert.match(toggleTreeItem(root, 'writing/commit-messages'), /added: writing\/commit-messages/);
  assert.equal(hasTriggerLine(root, 'writing/'), false);
  assert.equal(hasTriggerLine(root, 'writing/commit-messages'), true);
  assert.equal(hasTriggerLine(root, 'writing/pr-descriptions'), true);
  assert.equal(row(root, 'writing/').checked, 'partial'); // all children on ≠ the dir itself checked
});

test('conflict surfaced: saved copy + @ line for the same skill', () => {
  const root = project();
  const dir = skill(root, 'gh/acme/skills/deploy', 'deploy');
  fs.writeFileSync(path.join(dir, '.source'), 'gh:acme/skills/deploy\n2026-08-01 rev:abc123\n');
  addTriggerLine(root, '@gh:acme/skills/deploy');

  const items = collectTreeItems(root);
  assert.equal(items.some((i) => i.kind === 'cloud'), false); // no duplicate cloud row
  const saved = items.find((i) => i.line === 'gh/acme/skills/deploy');
  assert.equal(saved.atLine, '@gh:acme/skills/deploy');
  assert.match(saved.origin, /@ line answers to this copy/);
  assert.equal(saved.checked, 'direct'); // effectively auto-triggered

  // unchecking removes the @ line, not the copy
  assert.match(toggleTreeItem(root, saved.id), /removed @ line/);
  assert.equal(hasTriggerLine(root, '@gh:acme/skills/deploy'), false);
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
});

test('tree agrees with gitignore patterns; gh syntax untouched by matching', () => {
  const root = project();
  skill(root, 'sec-checklist', 'sec-checklist');
  skill(root, 'sec-review', 'sec-review');
  addTriggerLine(root, 'sec-*'); // a glob line — resolution semantics
  addTriggerLine(root, '@gh:acme/skills/deploy'); // gh syntax: never pattern-matched

  const items = collectTreeItems(root);
  const leaf = items.find((i) => i.line === 'sec-checklist');
  assert.equal(leaf.checked, 'via-dir'); // covered by the pattern → shown checked
  assert.match(toggleTreeItem(root, leaf.id), /covered by pattern "sec-\*"/); // can't split a glob — points at the line

  const cloud = items.find((i) => i.kind === 'cloud');
  assert.equal(cloud.id, 'gh:acme/skills/deploy'); // parsed as a cloud ID, not a pattern
  assert.equal(cloud.checked, 'direct');
});
