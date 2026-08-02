'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('../lib/ui');
const trigger = require('../lib/autotrigger');

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

test('filesystem tree: dir node, split, collapse', () => {
  const root = project();
  skill(root, 'writing/commit-messages', 'commit-messages');
  skill(root, 'writing/pr-descriptions', 'pr-descriptions');
  skill(root, 'my-checklist', 'my-checklist');

  let items = ui.collectItems(root);
  const dir = items.find((i) => i.kind === 'dir');
  assert.equal(dir.line, 'writing/');
  assert.deepEqual(dir.children.sort(), ['writing/commit-messages', 'writing/pr-descriptions']);

  // check the dir node → one covering line
  ui.toggle(root, dir);
  assert.equal(trigger.hasLine(root, 'writing/'), true);
  const leaf = items.find((i) => i.line === 'writing/commit-messages');
  assert.equal(ui.isChecked(root, leaf), 'via-dir');
  assert.equal(ui.isChecked(root, dir), 'direct');

  // uncheck a covered leaf → SPLIT: dir line out, sibling line in
  assert.match(ui.toggle(root, leaf), /split writing\//);
  assert.equal(trigger.hasLine(root, 'writing/'), false);
  assert.equal(trigger.hasLine(root, 'writing/pr-descriptions'), true);
  assert.equal(ui.isChecked(root, leaf), false);
  assert.equal(ui.isChecked(root, dir), 'partial');

  // re-check the leaf → COLLAPSE back to one dir line
  assert.match(ui.toggle(root, leaf), /collapsed to one line/);
  assert.equal(trigger.hasLine(root, 'writing/'), true);
  assert.equal(trigger.hasLine(root, 'writing/pr-descriptions'), false);
});

test('conflict surfaced: saved copy + @ line for the same skill', () => {
  const root = project();
  const dir = skill(root, 'gh/acme/skills/deploy', 'deploy');
  fs.writeFileSync(path.join(dir, '.source'), 'gh:acme/skills/deploy\n2026-08-01 rev:abc123\n');
  trigger.addLine(root, '@gh:acme/skills/deploy');

  const items = ui.collectItems(root);
  assert.equal(items.some((i) => i.kind === 'cloud'), false); // no duplicate cloud row
  const saved = items.find((i) => i.line === 'gh/acme/skills/deploy');
  assert.equal(saved.atLine, '@gh:acme/skills/deploy');
  assert.match(saved.origin, /@ line answers to this copy/);
  assert.equal(ui.isChecked(root, saved), 'direct'); // effectively auto-triggered

  // unchecking removes the @ line, not the copy
  assert.match(ui.toggle(root, saved), /removed @ line/);
  assert.equal(trigger.hasLine(root, '@gh:acme/skills/deploy'), false);
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
});
