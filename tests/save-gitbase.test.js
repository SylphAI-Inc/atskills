'use strict';
// Save over REAL git remotes on disk (file://) through the githubBaseUrl seam —
// the same transport GitHub speaks, no network. This is the coverage the
// live-repo run proved was missing: the cap must refuse on the SAVE path
// before anything lands, and a refusal must never fall through to a transport
// error (a refusal is a verdict).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-gitbase-'));

const { saveSkillToProject, diskPath } = require('../dist/index.js');

const remotesDir = path.join(tmpBase, 'remotes');
const githubBaseUrl = `file://${remotesDir}`;

function gitIn(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/** Create (or advance) <remotes>/<owner>/<repo>.git; returns the new HEAD sha. */
function makeRemote(owner, repo, files) {
  const dir = path.join(remotesDir, owner, `${repo}.git`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-q', '-b', 'main');
    // What GitHub's servers allow, ours allows: filters and by-sha fetches.
    gitIn(dir, 'config', 'uploadpack.allowFilter', 'true');
    gitIn(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  }
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'update', '--allow-empty');
  return gitIn(dir, 'rev-parse', 'HEAD');
}

/** A fresh project; returns per-project resolver opts (isolated cache too). */
function project() {
  const workingDir = fs.mkdtempSync(path.join(tmpBase, 'proj-'));
  fs.mkdirSync(path.join(workingDir, '.atskills'));
  return {
    root: path.join(workingDir, '.atskills'),
    opts: { workingDir, cacheDir: path.join(workingDir, '.cache'), githubBaseUrl },
  };
}

const SKILL = '---\nname: mine\ndescription: v1\n---\nv1 body\n';

test('save via githubBaseUrl: lands at the vendored path with a two-line .source', async () => {
  const sha = makeRemote('acme', 'skills', { 'mine/SKILL.md': SKILL });
  const { root, opts } = project();

  const r = await saveSkillToProject('gh:acme/skills/mine', opts);

  assert.equal(r.success, true);
  const dest = path.join(root, diskPath('gh:acme/skills/mine'));
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), SKILL);
  const [line1, line2] = fs.readFileSync(path.join(dest, '.source'), 'utf8').trim().split('\n');
  assert.equal(line1, 'gh:acme/skills/mine');
  assert.match(line2, new RegExp(`rev:${sha}$`));
});

test('save-again: unedited copy is replaced when upstream moves', async () => {
  makeRemote('acme', 'again', { 'mine/SKILL.md': SKILL });
  const { root, opts } = project();
  await saveSkillToProject('gh:acme/again/mine', opts);

  const next = SKILL.replace(/v1/g, 'v2');
  const shaB = makeRemote('acme', 'again', { 'mine/SKILL.md': next });
  const r = await saveSkillToProject('gh:acme/again/mine', opts);

  assert.equal(r.success, true);
  const dest = path.join(root, diskPath('gh:acme/again/mine'));
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), next);
  assert.match(fs.readFileSync(path.join(dest, '.source'), 'utf8'), new RegExp(`rev:${shaB}`));
});

test('save-again: edited copy is a conflict — nothing touched', async () => {
  makeRemote('acme', 'edited', { 'mine/SKILL.md': SKILL });
  const { root, opts } = project();
  await saveSkillToProject('gh:acme/edited/mine', opts);

  const dest = path.join(root, diskPath('gh:acme/edited/mine'));
  const mine = `${SKILL}\nhouse rules\n`;
  fs.writeFileSync(path.join(dest, 'SKILL.md'), mine);
  makeRemote('acme', 'edited', { 'mine/SKILL.md': SKILL.replace(/v1/g, 'v3') });

  const r = await saveSkillToProject('gh:acme/edited/mine', opts);
  assert.equal(r.success, false);
  assert.match(r.error, /conflict/);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), mine);
});

test('cap on the save path: refusal is a verdict — no fallback, nothing created', async () => {
  const files = {};
  for (let i = 0; i < 130; i++) {
    files[`skills/s${String(i).padStart(3, '0')}/SKILL.md`] = `---\nname: s${i}\ndescription: d\n---\nb\n`;
  }
  makeRemote('mega', 'catalog', files);
  const { root, opts } = project();

  // TOO_LARGE must surface AS the cap refusal, with the real count — with a
  // file:// base any per-file fallback CANNOT succeed, so a transport error
  // here would mean the refusal fell through instead of being a verdict.
  const r = await saveSkillToProject('gh:mega/catalog', opts);
  assert.equal(r.success, false);
  assert.match(r.error, /130 skills/);
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => !n.startsWith('.')),
    [],
    'nothing landed in .atskills/',
  );
});

test('parent save ABSORBS unedited saved children — the collection is a superset', async () => {
  makeRemote('acme', 'nest', {
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\nb\n',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: b\n---\nb\n',
  });
  const { root, opts } = project();

  // Save ONE child — this creates the parent namespace with no .source of its own.
  const child = await saveSkillToProject('gh:acme/nest/skills/alpha', opts);
  assert.equal(child.success, true);

  // Saving the PARENT widens the copy: the unedited child is absorbed, the
  // whole collection lands, provenance moves to ONE stamp at the parent.
  const parent = await saveSkillToProject('gh:acme/nest/skills', opts);
  assert.equal(parent.success, true);
  assert.match(parent.warning, /superset/);
  const dest = path.join(root, diskPath('gh:acme/nest/skills'));
  assert.ok(fs.existsSync(path.join(dest, '.source')), 'parent-level .source');
  assert.ok(!fs.existsSync(path.join(dest, 'alpha', '.source')), 'child stamp replaced by the parent stamp');
  assert.ok(fs.existsSync(path.join(dest, 'alpha', 'SKILL.md')), 'absorbed child present');
  assert.ok(fs.existsSync(path.join(dest, 'beta', 'SKILL.md')), 'sibling gained by the superset');
});

test('parent save refuses when a saved child was EDITED — and names it', async () => {
  makeRemote('acme', 'nest2', {
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\nb\n',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: b\n---\nb\n',
  });
  const { root, opts } = project();
  await saveSkillToProject('gh:acme/nest2/skills/alpha', opts);
  fs.appendFileSync(path.join(root, diskPath('gh:acme/nest2/skills/alpha'), 'SKILL.md'), '\nhouse rules\n');

  const parent = await saveSkillToProject('gh:acme/nest2/skills', opts);
  assert.equal(parent.success, false);
  assert.match(parent.error, /edited saved skill/);
  assert.match(parent.error, /alpha/);
  // The edited copy stays untouched.
  assert.match(fs.readFileSync(path.join(root, diskPath('gh:acme/nest2/skills/alpha'), 'SKILL.md'), 'utf8'), /house rules/);
});

test('a single skill with a huge bundle is never refused — the cap counts skills', async () => {
  const files = { 'solo/SKILL.md': '---\nname: solo\ndescription: one\n---\nb\n' };
  for (let i = 0; i < 200; i++) files[`solo/references/r${i}.md`] = `ref ${i}`;
  makeRemote('mega', 'bundle', files);
  const { root, opts } = project();

  const r = await saveSkillToProject('gh:mega/bundle/solo', opts);
  assert.equal(r.success, true);
  assert.ok(fs.existsSync(path.join(root, diskPath('gh:mega/bundle/solo'), 'references', 'r0.md')));
});
