'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeId, isGh, isCloud, isLocalOnly, diskPath, ghParts, parseReference,
} = require('../dist/index.js');

test('normalizeId: bare and hub IDs fold case; gh: preserves it (GitHub paths are case-sensitive)', () => {
  assert.equal(normalizeId('GH:SylphAI-Inc/Skills/Deploy/'), 'gh:SylphAI-Inc/Skills/Deploy');
  assert.equal(normalizeId('HUB:Stripe/Payments'), 'hub:stripe/payments');
  assert.equal(normalizeId('Team-Flows/Deploy'), 'team-flows/deploy');
});

// ── The prefix decides (PROTOCOL.md §5.0) ──

test('hub: is exactly owner/name', () => {
  assert.equal(normalizeId('hub:sylphai/glowmotion'), 'hub:sylphai/glowmotion');
  assert.throws(() => normalizeId('hub:onlyname'), /exactly owner\/name/);
  assert.throws(() => normalizeId('hub:a/b/c'), /exactly owner\/name/);
});

test('hub/ disk spelling folds back to hub:, like gh/', () => {
  assert.equal(normalizeId('hub/sylphai/glowmotion'), 'hub:sylphai/glowmotion');
  assert.equal(diskPath(normalizeId('hub:sylphai/glowmotion')), 'hub/sylphai/glowmotion');
});

test('a bare path is local; only a marker means the cloud', () => {
  assert.equal(isCloud('gh:a/b'), true);
  assert.equal(isCloud('hub:a/b'), true);
  // Both shapes below used to fall through to the network.
  assert.equal(isCloud('a/b'), false);
  assert.equal(isCloud('deploy'), false);
  assert.equal(isLocalOnly('team-flows/deploy'), true);
});

test('normalizeId accepts pasted GitHub URLs', () => {
  assert.equal(
    normalizeId('https://github.com/anthropics/skills/tree/main/skills/pdf'),
    'gh:anthropics/skills/skills/pdf'
  );
  assert.equal(
    normalizeId('github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md'),
    'gh:anthropics/skills/skills/pdf'
  );
  assert.equal(normalizeId('https://github.com/SylphAI-Inc/skills'), 'gh:SylphAI-Inc/skills');
});

test('normalizeId rejects traversal and junk', () => {
  assert.throws(() => normalizeId('../etc/passwd'));
  assert.throws(() => normalizeId('a/../b'));
  assert.throws(() => normalizeId('a/./b'));
  assert.throws(() => normalizeId('a//b'));
  assert.throws(() => normalizeId('a\\b'));
  assert.throws(() => normalizeId(''));
  assert.throws(() => normalizeId('gh:onlyowner'));
});

test('diskPath spells gh: as gh/', () => {
  assert.equal(diskPath('gh:acme/skills/deploy'), 'gh/acme/skills/deploy');
  assert.equal(diskPath('sylphai/glowmotion'), 'sylphai/glowmotion');
});

test('ghParts splits owner/repo/sub', () => {
  assert.deepEqual(ghParts('gh:acme/skills/a/b'), { owner: 'acme', repo: 'skills', sub: 'a/b' });
  assert.deepEqual(ghParts('gh:acme/skills'), { owner: 'acme', repo: 'skills', sub: '' });
});

test('parseReference handles greedy path + orthogonal suffixes', () => {
  assert.deepEqual(parseReference('@skills:a/b:save'), { id: 'a/b', wholeDir: false, save: true, install: false, index: false });
  assert.deepEqual(parseReference('@skills:a/b:save:install'), { id: 'a/b', wholeDir: false, save: true, install: true, index: false });
  assert.deepEqual(parseReference('@skills:a/b:install:save'), { id: 'a/b', wholeDir: false, save: true, install: true, index: false });
  const dir = parseReference('@skills:stripe/agent-toolkit/');
  assert.equal(dir.id, 'stripe/agent-toolkit');
  assert.equal(dir.wholeDir, true);
});

test('isGh', () => {
  assert.equal(isGh('gh:a/b'), true);
  assert.equal(isGh('a/b'), false);
});

test('gh/ disk spelling folds back to gh: (screenshot bug)', () => {
  assert.equal(normalizeId('gh/anthropics/skills/skills/docx'), 'gh:anthropics/skills/skills/docx');
  assert.equal(diskPath(normalizeId('gh/anthropics/skills/skills/docx')), 'gh/anthropics/skills/skills/docx');
});

// ── Lenient about spelling, strict about what resolves ─────────────────────
//
// A person pasting from the browser address bar is the COMMON case, not the
// exotic one. Everything below is a real paste we used to mishandle.

test('a pasted GitHub URL after the gh: marker is not read as a scheme', () => {
  // Regression. `new URL('gh:https://github.com/o/r')` parses `gh:` as the
  // scheme, leaving `https://github.com/o/r` as the PATH — so this returned
  // `gh:https:/github.com/o/r`: a well-formed id naming a repo called
  // `https:`. It produced garbage instead of failing, so nothing caught it.
  assert.equal(
    normalizeId('gh:https://github.com/itsmostafa/aws-agent-skills'),
    'gh:itsmostafa/aws-agent-skills',
  );
  assert.equal(
    normalizeId('gh:github.com/itsmostafa/aws-agent-skills'),
    'gh:itsmostafa/aws-agent-skills',
  );
});

test('every browser spelling of one repo lands on one id', () => {
  const want = 'gh:vectorize-io/hindsight/skills/hindsight-docs';
  for (const spelling of [
    'gh:vectorize-io/hindsight/skills/hindsight-docs',
    'https://github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs',
    'https://www.github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs',
    'github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs',
    'https://github.com/vectorize-io/hindsight/blob/main/skills/hindsight-docs/SKILL.md',
    'https://github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs/',
    'https://github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs?tab=readme-ov-file',
    'https://github.com/vectorize-io/hindsight/tree/main/skills/hindsight-docs#usage',
  ]) {
    assert.equal(normalizeId(spelling), want, `failed for: ${spelling}`);
  }
});

test('a .git clone URL names the same repo as the web URL', () => {
  assert.equal(normalizeId('https://github.com/SylphAI-Inc/skills.git'), 'gh:SylphAI-Inc/skills');
});

test('only github.com is github.com', () => {
  // `raw.includes('github.com/')` was true for all of these, so each used to
  // normalize into a `gh:` id — and git would then clone the ATTACKER's
  // owner/repo from the real GitHub.
  for (const host of [
    'https://evil-github.com/owner/repo',
    'https://github.com.attacker.net/owner/repo',
    'https://notgithub.com/owner/repo',
  ]) {
    // Rejected outright is the ideal answer; "not a gh: id" is the property
    // that actually matters. Either is safe, so assert the weaker one and let
    // the implementation pick.
    let id = null;
    try { id = normalizeId(host); } catch { continue; }
    assert.ok(!isGh(id), `${host} must not become a gh: id, got ${id}`);
  }
});

test('leniency stops at the segment: an encoded traversal is still refused', () => {
  // Decode-then-validate, per segment. Accepting more SPELLINGS must never
  // mean accepting more PATHS.
  assert.throws(() => normalizeId('https://github.com/owner/repo/%2E%2E/%2E%2E/etc'), /invalid path segment/);
  assert.throws(() => normalizeId('gh:owner/repo/..%2Fetc'), /invalid path segment/);
});
