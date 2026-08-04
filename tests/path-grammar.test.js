'use strict';
// The path grammar — a denylist, not an allowlist.
//
// A segment may be anything the host allows EXCEPT what the reference grammar
// cannot carry (whitespace, ':', separators, control chars). The previous rule
// required an alphanumeric first character and [A-Za-z0-9._-] throughout,
// which rejected 12% of the published ecosystem: every skill under
// `.claude/`, `.agents/`, `.gemini/`, `.kiro/` — and `.atskills/` itself, the
// protocol's own standard directory — plus `_official`, `@scope`, and every
// non-ASCII name. Measured against 56,825 real skills: 6,735 blocked by the
// leading dot alone, ~345 more by the other rules.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeId, referenceSpelling } = require('../dist/index.js');
const { walkSkills } = require('../dist/index.js');

test('accepts the ecosystem standard skill locations', () => {
  for (const dir of ['.claude', '.agents', '.gemini', '.kiro', '.atskills']) {
    const id = `gh:owner/repo/${dir}/skills/thing`;
    assert.equal(normalizeId(id), id, `${dir} must be addressable`);
  }
});

test('accepts leading underscore, @scope, and non-ASCII names', () => {
  const ok = [
    'gh:owner/repo/_official/thing',      // 231 real segments
    'gh:owner/repo/@claude-flow/thing',   // npm-style scoping
    'gh:owner/repo/oh-my-claudecode@deee3a4/x',
    'gh:owner/repo/营销技能库/thing',      // GitHub allows it, so do we
  ];
  for (const id of ok) assert.equal(normalizeId(id), id, id);
});

test('accepts spaces — the canonical form is the real directory name', () => {
  // If GitHub serves it, the protocol accepts it. `@skills:<path> <prompt>` is
  // whitespace-delimited, so the REFERENCE encodes the space; the canonical ID
  // keeps the true name, which is what git and the filesystem need.
  assert.equal(normalizeId('gh:owner/repo/Deep Research/x'), 'gh:owner/repo/Deep Research/x');
  assert.equal(normalizeId('gh:owner/repo/Deep%20Research/x'), 'gh:owner/repo/Deep Research/x');
});

test('a pasted GitHub URL with %20 resolves to the real path', () => {
  // Before decoding, this produced the segment `API%20Gateway` — accepted by
  // the grammar, then unresolvable, because no such directory exists.
  assert.equal(
    normalizeId('https://github.com/o/r/tree/main/skills/API%20Gateway'),
    'gh:o/r/skills/API Gateway'
  );
});

test('reference spelling round-trips, and keeps the gh: marker literal', () => {
  const id = normalizeId('gh:owner/repo/skills/API%20Gateway');
  const ref = referenceSpelling(id);
  assert.equal(ref, 'gh:owner/repo/skills/API%20Gateway'); // marker not encoded
  assert.equal(normalizeId(ref), id);
});

test('rejects only what cannot denote a directory', () => {
  assert.throws(() => normalizeId('gh:owner/repo//x'), /invalid path segment/);
  // Decode BEFORE validating, or an encoded separator smuggles a path apart.
  assert.throws(() => normalizeId('gh:owner/repo/a%2Fb/x'), /invalid path segment/);
  assert.throws(() => normalizeId('gh:owner/repo/%2E%2E/etc'), /invalid path segment/);
});

test('still rejects traversal — safety never rested on the character set', () => {
  assert.throws(() => normalizeId('gh:owner/repo/../etc/passwd'), /invalid path segment/);
  assert.throws(() => normalizeId('gh:owner/repo/./x'), /invalid path segment/);
  assert.throws(() => normalizeId('../../etc/passwd'), /invalid path segment/);
  // A dot-dir is fine; the traversal TOKENS are what is forbidden.
  assert.equal(normalizeId('gh:owner/repo/.config/x'), 'gh:owner/repo/.config/x');
});

test('hub paths still fold case, and share the same segment rules', () => {
  assert.equal(normalizeId('SylphAI/GlowMotion'), 'sylphai/glowmotion');
  assert.throws(() => normalizeId('owner/../etc'), /invalid path segment/);
});

test('walkSkills finds skills inside dot-dirs', () => {
  // The bug this pins: remote listing (trees API) had no dot filter, so a
  // .claude/skills/ skill was visible on GitHub and vanished once saved.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-dot-'));
  for (const dir of ['.claude/skills/alpha', '.agents/skills/beta', 'skills/gamma']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n');
  }
  // .git is the one directory that is never content.
  fs.mkdirSync(path.join(root, '.git/objects/fake'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/objects/fake/SKILL.md'), 'not a skill');

  const found = walkSkills(root).map((s) => s.rel).sort();
  assert.deepEqual(found, ['.agents/skills/beta', '.claude/skills/alpha', 'skills/gamma']);

  fs.rmSync(root, { recursive: true, force: true });
});
