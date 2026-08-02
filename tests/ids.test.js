'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeId, isGh, diskPath, ghParts, parseReference } = require('../lib/ids');

test('normalizeId folds case and strips trailing slash', () => {
  assert.equal(normalizeId('GH:SylphAI-Inc/Skills/Deploy/'), 'gh:sylphai-inc/skills/deploy');
  assert.equal(normalizeId('Stripe/Payments'), 'stripe/payments');
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
  assert.deepEqual(parseReference('@skills:a/b:save'), { id: 'a/b', wholeDir: false, save: true, install: false });
  assert.deepEqual(parseReference('@skills:a/b:save:install'), { id: 'a/b', wholeDir: false, save: true, install: true });
  assert.deepEqual(parseReference('@skills:a/b:install:save'), { id: 'a/b', wholeDir: false, save: true, install: true });
  const dir = parseReference('@skills:stripe/agent-toolkit/');
  assert.equal(dir.id, 'stripe/agent-toolkit');
  assert.equal(dir.wholeDir, true);
});

test('isGh', () => {
  assert.equal(isGh('gh:a/b'), true);
  assert.equal(isGh('a/b'), false);
});
