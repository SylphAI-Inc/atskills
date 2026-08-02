'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const trigger = require('../lib/autotrigger');
const { buildPrompt } = require('../lib/prompt');

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

const noNetCache = { fetch: async () => { throw new Error('network disabled in test'); } };

test('parse: comments, blanks, duplicates', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.autotrigger'), [
    '# comment only',
    'alpha   # yours',
    '',
    'alpha',
    '@gh:acme/skills/deploy',
    'team/  ',
  ].join('\n'));
  const entries = trigger.parse(root);
  assert.deepEqual(entries.map((e) => e.line), ['alpha', '@gh:acme/skills/deploy', 'team/']);
  assert.equal(entries[1].cloud, true);
  assert.equal(entries[2].wholeDir, true);
});

test('addLine/removeLine round-trip, idempotent, comment-safe', () => {
  const root = project();
  assert.equal(trigger.addLine(root, 'alpha'), true);
  assert.equal(trigger.addLine(root, 'alpha'), false);
  assert.equal(trigger.hasLine(root, 'alpha'), true);
  assert.equal(trigger.removeLine(root, 'alpha'), true);
  assert.equal(trigger.hasLine(root, 'alpha'), false);
  assert.equal(trigger.removeLine(root, 'alpha'), false);
});

test('expand: local skills, dir lines, saved provenance, per-line errors', async () => {
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
    '@gh:acme/skills/deploy   # shadowed by the saved copy: resolves local',
  ].join('\n'));

  const entries = await trigger.expand(noNetCache, root);
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
  assert.match(errs.find((e) => e.line === 'missing-skill').error, /nothing at/);
});

test('buildPrompt: exact text plus read trail', async () => {
  const root = project();
  skill(root, 'my-tdd', 'my-tdd');
  fs.writeFileSync(path.join(root, '.autotrigger'), 'my-tdd\n');

  const { text, sections, tokens } = await buildPrompt(noNetCache, root);
  assert.match(text, /- my-tdd: about my-tdd \(my-tdd\)/);
  assert.ok(tokens > 0);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].ref.endsWith(path.join('my-tdd', 'SKILL.md')));
});

test('expand with empty/missing .autotrigger is empty, not an error', async () => {
  const root = project();
  assert.deepEqual(await trigger.expand(noNetCache, root), []);
});
