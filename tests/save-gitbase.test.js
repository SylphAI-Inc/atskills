'use strict';
// Save over REAL git remotes on disk (file://) through the gitBase seam —
// the same transport GitHub speaks, no network. This is the coverage the
// live-repo run proved was missing: the cap must refuse on the SAVE path
// before anything lands, and a refusal must never fall through to the
// per-file fallback (a refusal is a verdict, not a transport failure).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-gitbase-'));
process.env.ATSKILLS_CACHE = path.join(tmpBase, 'cache');

const { Cache } = require('../lib/cache');
const { save } = require('../lib/save');
const { diskPath } = require('../lib/ids');

const remotesDir = path.join(tmpBase, 'remotes');
const gitBase = `file://${remotesDir}`;

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

function project() {
  const root = fs.mkdtempSync(path.join(tmpBase, 'proj-'));
  fs.mkdirSync(path.join(root, '.atskills'));
  return path.join(root, '.atskills');
}

const SKILL = '---\nname: mine\ndescription: v1\n---\nv1 body\n';

test('save via gitBase: lands at the vendored path with a two-line .source', async () => {
  const sha = makeRemote('acme', 'skills', { 'mine/SKILL.md': SKILL });
  const root = project();

  const r = await save(new Cache(), 'gh:acme/skills/mine', root, { gitBase });

  assert.equal(r.action, 'saved');
  assert.equal(r.revision, sha);
  const dest = path.join(root, diskPath('gh:acme/skills/mine'));
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), SKILL);
  const [line1, line2] = fs.readFileSync(path.join(dest, '.source'), 'utf8').trim().split('\n');
  assert.equal(line1, 'gh:acme/skills/mine');
  assert.match(line2, new RegExp(`rev:${sha}$`));
});

test('save-again: unedited copy is replaced when upstream moves', async () => {
  makeRemote('acme', 'again', { 'mine/SKILL.md': SKILL });
  const root = project();
  await save(new Cache(), 'gh:acme/again/mine', root, { gitBase });

  const next = SKILL.replace(/v1/g, 'v2');
  const shaB = makeRemote('acme', 'again', { 'mine/SKILL.md': next });
  const r = await save(new Cache(), 'gh:acme/again/mine', root, { gitBase });

  assert.equal(r.action, 'updated');
  assert.equal(r.revision, shaB);
  const dest = path.join(root, diskPath('gh:acme/again/mine'));
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), next);
});

test('save-again: edited copy is a conflict — nothing touched', async () => {
  makeRemote('acme', 'edited', { 'mine/SKILL.md': SKILL });
  const root = project();
  await save(new Cache(), 'gh:acme/edited/mine', root, { gitBase });

  const dest = path.join(root, diskPath('gh:acme/edited/mine'));
  const mine = `${SKILL}\nhouse rules\n`;
  fs.writeFileSync(path.join(dest, 'SKILL.md'), mine);
  makeRemote('acme', 'edited', { 'mine/SKILL.md': SKILL.replace(/v1/g, 'v3') });

  await assert.rejects(
    () => save(new Cache(), 'gh:acme/edited/mine', root, { gitBase }),
    /conflict/,
  );
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), mine);
});

test('cap on the save path: refusal is a verdict — no fallback, nothing created', async () => {
  const files = {};
  for (let i = 0; i < 130; i++) {
    files[`skills/s${String(i).padStart(3, '0')}/SKILL.md`] = `---\nname: s${i}\ndescription: d\n---\nb\n`;
  }
  makeRemote('mega', 'catalog', files);
  const root = project();

  // TOO_LARGE must surface AS TOO_LARGE: the per-file fallback would have hit
  // the network and re-downloaded exactly what the cap rejected. With a
  // file:// base the fallback CANNOT succeed, so reaching it would also turn
  // the honest refusal into a bogus transport error.
  await assert.rejects(
    () => save(new Cache(), 'gh:mega/catalog', root, { gitBase }),
    (err) => err.code === 'TOO_LARGE' && /130 skills/.test(err.message),
  );
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => !n.startsWith('.')),
    [],
    'nothing landed in .atskills/',
  );
});

test('a single skill with a huge bundle is never refused — the cap counts skills', async () => {
  const files = { 'solo/SKILL.md': '---\nname: solo\ndescription: one\n---\nb\n' };
  for (let i = 0; i < 200; i++) files[`solo/references/r${i}.md`] = `ref ${i}`;
  makeRemote('mega', 'bundle', files);
  const root = project();

  const r = await save(new Cache(), 'gh:mega/bundle/solo', root, { gitBase });
  assert.equal(r.action, 'saved');
  assert.ok(fs.existsSync(path.join(root, diskPath('gh:mega/bundle/solo'), 'references', 'r0.md')));
});
