'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeId, isGh, diskPath, ghParts, parseReference } = require('../lib/ids');

test('normalizeId: hub IDs fold case; gh: paths preserve it (GitHub paths are case-sensitive)', () => {
  assert.equal(normalizeId('GH:SylphAI-Inc/Skills/Deploy/'), 'gh:SylphAI-Inc/Skills/Deploy');
  assert.equal(normalizeId('Stripe/Payments'), 'stripe/payments');
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

test('gh/ disk spelling folds back to gh: (screenshot bug)', () => {
  assert.equal(normalizeId('gh/anthropics/skills/skills/docx'), 'gh:anthropics/skills/skills/docx');
  assert.equal(diskPath(normalizeId('gh/anthropics/skills/skills/docx')), 'gh/anthropics/skills/skills/docx');
});
