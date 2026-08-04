'use strict';
// The collection cap — 128 skills per reference.
//
// A repo root holding thousands of skills is not a collection anyone chose.
// Resolving one costs a fetch per skill and yields an index that can exceed
// the context window by itself, so the reference is refused BEFORE the bodies
// are fetched. The cap counts SKILLS, never files.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  leafSkillDirs,
  largestUsableCollections,
  assertCollectionFits,
  ghParts,
  MAX_COLLECTION_SKILLS,
} = require('../dist/index.js');

const files = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}/s${i}/SKILL.md`);
// The dist check takes the raw repo listing (leafSkillDirs applies inside).
const fits = (id, paths) => {
  const { owner, repo, sub } = ghParts(id);
  return assertCollectionFits(paths.map((p) => ({ path: p, size: 1 })), owner, repo, sub);
};

test('leafSkillDirs: a SKILL.md inside a bundle is not a second skill', () => {
  const out = leafSkillDirs([
    'a/SKILL.md',
    'a/examples/nested/SKILL.md', // belongs to `a` — the walk stops at a/
    'b/c/SKILL.md',
    'b/c/README.md',
  ]);
  assert.deepEqual(out, ['a', 'b/c']);
});

test('leafSkillDirs: SKILL.md at the path itself is the root skill', () => {
  assert.deepEqual(leafSkillDirs(['SKILL.md', 'refs/x.md']), ['']);
});

test('leafSkillDirs: dot-dirs ARE skills homes (.claude/…); only .git is never content', () => {
  assert.deepEqual(
    leafSkillDirs(['.git/objects/SKILL.md', '.claude/skills/d/SKILL.md', 'real/SKILL.md']),
    ['.claude/skills/d', 'real'],
  );
});

test('cap allows exactly 128 — the boundary is inclusive', () => {
  assert.doesNotThrow(() => fits('gh:o/r', files(MAX_COLLECTION_SKILLS, 'skills')));
});

test('cap refuses 129', () => {
  assert.throws(() => fits('gh:o/r', files(MAX_COLLECTION_SKILLS + 1, 'skills')), (err) => {
    assert.equal(err.name, 'SkillCollectionTooLargeError');
    assert.equal(err.count, 129);
    assert.match(err.message, /129 skills/);
    assert.match(err.message, /128/);
    return true;
  });
});

test('cap counts skills, not files — one skill with a huge bundle is fine', () => {
  const paths = ['solo/SKILL.md', ...Array.from({ length: 500 }, (_, i) => `solo/refs/r${i}.md`)];
  assert.doesNotThrow(() => fits('gh:o/r', paths));
});

// The shape that motivated the cap: every top-level child is ALSO oversized,
// so a one-level grouping would offer nothing at all.
test('suggestions descend past oversized parents to reach bundles that fit', () => {
  const paths = [
    ...files(400, 'plugins/mega-catalog/skills'),
    ...files(12, 'plugins/bundle-design-it'),
    ...files(12, 'plugins/bundle-super-code'),
  ];
  assert.throws(() => fits('gh:sickn33/catalog', paths), (err) => {
    const ids = err.suggestions.map((s) => s.id);
    assert.ok(ids.includes('gh:sickn33/catalog/plugins/bundle-design-it'), ids.join(','));
    assert.ok(ids.includes('gh:sickn33/catalog/plugins/bundle-super-code'), ids.join(','));
    // `plugins/` (424) is oversized — it must never be offered.
    assert.ok(!ids.includes('gh:sickn33/catalog/plugins'));
    // Real collections crowd out the singleton skills of the mega-catalog.
    assert.ok(err.suggestions.every((s) => s.count > 1));
    return true;
  });
});

// Aggregator repos vendor the same catalog once per target agent, so the raw
// list offers `…/design-it` three times and burns the whole suggestion budget.
test('a repeated collection is offered once, at its shortest path', () => {
  const paths = [];
  for (const copy of ['skills', 'plugins/claude-copy', 'plugins/codex-copy']) {
    paths.push(...files(200, `${copy}/dump`), ...files(10, `${copy}/design-it`));
  }
  assert.throws(() => fits('gh:o/r', paths), (err) => {
    const designIt = err.suggestions.filter((s) => s.id.endsWith('/design-it'));
    assert.equal(designIt.length, 1);
    assert.equal(designIt[0].id, 'gh:o/r/skills/design-it'); // the shortest path
    return true;
  });
});

test('largestUsableCollections: biggest loadable collection first', () => {
  const skills = [
    ...Array.from({ length: 200 }, (_, i) => `a/big/s${i}`),
    ...Array.from({ length: 100 }, (_, i) => `a/medium/s${i}`),
    ...Array.from({ length: 5 }, (_, i) => `a/small/s${i}`),
  ];
  assert.deepEqual(largestUsableCollections(skills)[0], { rel: 'a/medium', count: 100 });
});

test('largestUsableCollections: terminates on a flat directory it cannot split', () => {
  const skills = Array.from({ length: 200 }, (_, i) => `s${i}`);
  const out = largestUsableCollections(skills);
  assert.equal(out.length, 200);
  assert.ok(out.every((o) => o.count === 1));
});

// With nothing larger to point at, individual skills are still better than
// an empty list — the refusal must always name a next step.
test('a flat oversized directory still suggests individual skills', () => {
  assert.throws(() => fits('gh:o/r', files(200, '.').map((f) => f.slice(2))), (err) => {
    assert.ok(err.suggestions.length > 0);
    assert.ok(err.suggestions.every((s) => s.count === 1));
    return true;
  });
});
