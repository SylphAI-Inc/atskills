'use strict';
// .autotrigger semantics — dist/autotrigger.js + the residency block builder.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseTriggers,
  expandLocalTriggers,
  addTriggerLine,
  removeTriggerLine,
  hasTriggerLine,
  buildAutotriggerIndex,
} = require('../dist/index.js');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-at-'));
  fs.mkdirSync(path.join(root, '.atskills'), { recursive: true });
  return path.join(root, '.atskills');
}

function skill(root, rel, name) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: about ${name}\n---\nbody of ${name}\n`);
  return dir;
}

test('parse: comments, blanks, duplicates — gitignore semantics', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.autotrigger'), [
    '# comment only',
    'alpha',
    '',
    'alpha',
    '@gh:acme/skills/deploy',
    'team/  ',
  ].join('\n'));
  const entries = parseTriggers(root);
  assert.deepEqual(entries.map((e) => e.line), ['alpha', '@gh:acme/skills/deploy', 'team/']);
  assert.equal(entries[1].cloud, true);
  assert.equal(entries[2].cloud, false); // plain = gitignore pattern
});

test('a # inside a pattern is literal (gitignore rule) — only column 1 comments', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.autotrigger'), 'c#-patterns\n  # indented comment\n');
  assert.deepEqual(parseTriggers(root).map((e) => e.line), ['c#-patterns']);
});

test('addTriggerLine/removeTriggerLine round-trip, idempotent', () => {
  const root = project();
  assert.equal(addTriggerLine(root, 'alpha'), true);
  assert.equal(addTriggerLine(root, 'alpha'), false);
  assert.equal(hasTriggerLine(root, 'alpha'), true);
  assert.equal(removeTriggerLine(root, 'alpha'), true);
  assert.equal(hasTriggerLine(root, 'alpha'), false);
  assert.equal(removeTriggerLine(root, 'alpha'), false);
});

test('expand: local skills, dir lines, saved provenance, per-line errors', () => {
  const root = project();
  skill(root, 'my-tdd', 'my-tdd');
  skill(root, 'team/deploy', 'deploy');
  skill(root, 'team/review', 'review');
  // a saved skill with .source
  skill(root, 'gh/acme/skills/deploy', 'acme-deploy');
  fs.writeFileSync(path.join(root, 'gh/acme/skills/deploy/.source'), 'gh:acme/skills/deploy\n2026-08-01 rev:abc123\n');
  // invalid: missing description
  const bad = path.join(root, 'broken');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: broken\n---\nno description');

  fs.writeFileSync(path.join(root, '.autotrigger'), [
    'my-tdd',
    'team/',
    'gh/acme/skills/deploy',
    'broken',
    'missing-skill',
    '@gh:acme/skills/deploy',
  ].join('\n'));

  const entries = expandLocalTriggers(root);
  const ok = entries.filter((e) => !e.error);
  const errs = entries.filter((e) => e.error);

  assert.deepEqual(ok.map((e) => e.fm.name).sort(), ['acme-deploy', 'deploy', 'my-tdd', 'review']);
  // the saved copy answers its own @ line — loaded once, not twice
  assert.equal(ok.filter((e) => e.fm.name === 'acme-deploy').length, 1);
  assert.equal(ok.find((e) => e.fm.name === 'acme-deploy').where, 'saved');
  assert.equal(ok.find((e) => e.fm.name === 'acme-deploy').origin, 'gh:acme/skills/deploy');
  assert.equal(ok.find((e) => e.fm.name === 'my-tdd').where, 'yours');
  // both failures reported, neither fatal
  assert.equal(errs.length, 2);
  assert.match(errs.find((e) => e.line === 'broken').error, /frontmatter/);
  assert.match(errs.find((e) => e.line === 'missing-skill').error, /matches nothing/);
});

test('buildAutotriggerIndex: header + project-relative rows', async () => {
  const root = project();
  skill(root, 'my-tdd', 'my-tdd');
  fs.writeFileSync(path.join(root, '.autotrigger'), 'my-tdd\n');

  const text = await buildAutotriggerIndex({ workingDir: path.dirname(root) });
  assert.match(text, /^Auto-triggered Skills \(\.atskills\/\.autotrigger\):/);
  // the index entry ends with the READABLE project-relative path
  assert.match(text, /- my-tdd: about my-tdd \(\.atskills\/my-tdd\/SKILL\.md\)/);
});

test('buildAutotriggerIndex: empty when nothing triggers — a real value, not an error', async () => {
  const root = project();
  assert.equal(await buildAutotriggerIndex({ workingDir: path.dirname(root) }), '');
  assert.deepEqual(expandLocalTriggers(root), []);
});

test('plain lines use real gitignore semantics: globs and ! negation', () => {
  const root = project();
  skill(root, 'writing/commit-messages', 'commit-messages');
  skill(root, 'writing/drafts', 'drafts');
  skill(root, 'sec-checklist', 'sec-checklist');
  // exactly git's rules — negating inside a fully-matched dir doesn't work
  // (same as .gitignore); the git idiom is dir/* + !dir/excluded
  fs.writeFileSync(path.join(root, '.autotrigger'), 'writing/*\n!writing/drafts\nsec-*\n');

  const entries = expandLocalTriggers(root);
  const names = entries.filter((e) => !e.error).map((e) => e.fm.name).sort();
  assert.deepEqual(names, ['commit-messages', 'sec-checklist']); // drafts negated out, glob matched
});
