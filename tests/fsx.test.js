'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frontmatter, walkSkills, nearestSource, safeJoin, findAtskills } = require('../dist/index.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-test-'));
}

test('frontmatter parses name/description, tolerates CRLF and quotes', () => {
  assert.deepEqual(frontmatter('---\nname: tdd\ndescription: "Do TDD"\n---\nbody'), { name: 'tdd', description: 'Do TDD' });
  assert.deepEqual(frontmatter('---\r\nname: a\r\ndescription: b\r\n---\r\nbody'), { name: 'a', description: 'b' });
  assert.deepEqual(frontmatter('no frontmatter'), { name: null, description: null });
});

test('walkSkills: leaf rule stops at SKILL.md; dot-dirs ARE walked, .git is not', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a/SKILL.md'), '---\nname: a\ndescription: d\n---');
  fs.writeFileSync(path.join(root, 'a/nested/SKILL.md'), 'should not be reached');
  fs.mkdirSync(path.join(root, 'b/c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b/c/SKILL.md'), '---\nname: c\ndescription: d\n---');
  // `.claude/skills/` and friends are where most of the ecosystem publishes —
  // skipping every dot-dir hid ~12% of all skills and made local resolution
  // disagree with remote listing, so a saved skill could vanish.
  fs.mkdirSync(path.join(root, '.claude/skills/d'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/d/SKILL.md'), '---\nname: d\ndescription: d\n---');
  // git's object store is the one directory that is never content.
  fs.mkdirSync(path.join(root, '.git/objects/x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/objects/x/SKILL.md'), 'never a skill');

  const rels = walkSkills(root).map((s) => s.rel).sort();
  assert.deepEqual(rels, ['.claude/skills/d', 'a', 'b/c']);
});

test('nearestSource finds the closest .source above, stops at root', () => {
  const root = tmp();
  const deep = path.join(root, 'gh/acme/skills/deploy');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'gh/acme/skills', '.source'), 'gh:acme/skills\n2026-08-01 rev:abc123\n');
  const src = nearestSource(deep, root);
  assert.equal(src.id, 'gh:acme/skills');
  assert.equal(src.revision, 'abc123');
  assert.equal(src.taken, '2026-08-01');

  const own = path.join(root, 'my-own');
  fs.mkdirSync(own);
  assert.equal(nearestSource(own, root), null);
});

test('safeJoin refuses escapes', () => {
  const root = tmp();
  assert.throws(() => safeJoin(root, '../out'));
  assert.ok(safeJoin(root, 'a/b').startsWith(root));
});

test('findAtskills walks up', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.atskills/x'), { recursive: true });
  assert.equal(findAtskills(path.join(root, '.atskills/x')), path.join(root, '.atskills'));
  assert.equal(findAtskills(root), path.join(root, '.atskills'));
});

test('frontmatter handles YAML block scalars (>- folded descriptions)', () => {
  const fm = frontmatter('---\nname: clone\ndescription: >-\n  Clone any website\n  pixel perfect.\ntags: [x]\n---\nbody');
  assert.equal(fm.name, 'clone');
  assert.equal(fm.description, 'Clone any website pixel perfect.');
});
