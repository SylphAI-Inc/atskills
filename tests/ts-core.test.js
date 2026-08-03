'use strict';
// The TypeScript core (src/ → dist/) — protocol conformance smoke over the
// compiled output. The TS implementation is the one lifted from AdaL's
// in-production client; these tests pin that the standalone build keeps the
// protocol behaviors: local-first by path, the validating cache over real
// file:// git remotes, the collection cap, the checkbox tree, and the
// residency block a host splices in verbatim.
//
// Skips (never fails) when dist/ is absent — run `npm run build` first.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIST = path.join(__dirname, '..', 'dist', 'index.js');
const hasDist = fs.existsSync(DIST);
const opts = hasDist ? {} : { skip: 'dist/ missing — run `npm run build`' };

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-ts-'));
const remotesDir = path.join(tmpBase, 'remotes');
const gitBase = `file://${remotesDir}`;

function gitIn(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function makeRemote(owner, repo, files) {
  const dir = path.join(remotesDir, owner, `${repo}.git`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, 'init', '-q', '-b', 'main');
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
  const workingDir = fs.mkdtempSync(path.join(tmpBase, 'proj-'));
  fs.mkdirSync(path.join(workingDir, '.atskills'));
  return workingDir;
}

function resolverOpts(workingDir) {
  return {
    workingDir,
    cacheDir: path.join(tmpBase, 'cache', path.basename(workingDir)),
    githubBaseUrl: gitBase,
  };
}

function makeLocalSkill(workingDir, rel, description = `does ${rel}`) {
  const dir = path.join(workingDir, '.atskills', rel);
  fs.mkdirSync(dir, { recursive: true });
  const name = rel.split('/').pop();
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
  return dir;
}

test('local first, by path — a folder answers its own address', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  makeLocalSkill(workingDir, 'my-tdd', 'How we do TDD');

  const r = await core.resolveSkill('my-tdd', false, resolverOpts(workingDir));
  assert.equal(r.success, true);
  assert.equal(r.kind, 'skill');
  assert.equal(r.source, 'local');
  assert.match(r.content, /How we do TDD/);
});

test('the validating cache — unchanged serves the cache, changed fetches fresh', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  makeRemote('acme', 'skills', { 'mine/SKILL.md': '---\nname: mine\ndescription: v1\n---\nv1\n' });

  const first = await core.resolveSkill('gh:acme/skills/mine', false, resolverOpts(workingDir));
  assert.equal(first.success, true);
  fs.appendFileSync(first.path, 'CACHE-MARKER\n'); // a re-download would erase it

  const hit = await core.resolveSkill('gh:acme/skills/mine', false, resolverOpts(workingDir));
  assert.match(hit.content, /CACHE-MARKER/); // unchanged → served from cache

  makeRemote('acme', 'skills', { 'mine/SKILL.md': '---\nname: mine\ndescription: v2\n---\nv2\n' });
  const fresh = await core.resolveSkill('gh:acme/skills/mine', false, resolverOpts(workingDir));
  assert.match(fresh.content, /v2/); // changed → fetched fresh
});

test('the collection cap refuses before downloading, with suggestions', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  const files = {};
  for (let i = 0; i < 130; i++) {
    files[`bundles/b${i % 13}/s${String(i).padStart(3, '0')}/SKILL.md`] =
      `---\nname: s${i}\ndescription: d\n---\nb\n`;
  }
  makeRemote('mega', 'catalog', files);

  const r = await core.resolveSkill('gh:mega/catalog', false, resolverOpts(workingDir));
  assert.equal(r.success, false);
  assert.match(r.error, /130 skills/);
  assert.match(r.error, /gh:mega\/catalog\/bundles\/b/); // a usable next step
});

test('save = adapt + detach, with a two-line .source', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  const sha = makeRemote('acme', 'tosave', { 'mine/SKILL.md': '---\nname: mine\ndescription: d\n---\nb\n' });

  const r = await core.resolveSkill('gh:acme/tosave/mine', true, resolverOpts(workingDir));
  assert.equal(r.success, true);
  const src = fs.readFileSync(
    path.join(workingDir, '.atskills', 'gh', 'acme', 'tosave', 'mine', '.source'),
    'utf8',
  );
  assert.match(src, /^gh:acme\/tosave\/mine\n/);
  assert.match(src, new RegExp(`rev:${sha}`));
});

test('the checkbox tree toggles by writing .autotrigger lines', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  const root = path.join(workingDir, '.atskills');
  makeLocalSkill(workingDir, 'team/deploy');
  makeLocalSkill(workingDir, 'team/review');

  assert.match(core.toggleTreeItem(root, 'team/'), /added: team\//);
  assert.match(fs.readFileSync(path.join(root, '.autotrigger'), 'utf8'), /^team\/$/m);
  // Uncheck one leaf under the covering dir line → SPLIT.
  assert.match(core.toggleTreeItem(root, 'team/deploy'), /split team\//);
  const lines = fs.readFileSync(path.join(root, '.autotrigger'), 'utf8');
  assert.doesNotMatch(lines, /^team\/$/m);
  assert.match(lines, /^team\/review$/m);
});

test('residency builds the exact prompt block a host splices in', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  const dir = makeLocalSkill(workingDir, 'sec-check', 'Reviews security');
  fs.writeFileSync(path.join(workingDir, '.atskills', '.autotrigger'), 'sec-check\n');

  const block = await core.buildAutotriggerIndex(resolverOpts(workingDir));
  assert.equal(
    block,
    `Auto-triggered Skills (.atskills/.autotrigger):\n- sec-check: Reviews security (${path.join(dir, 'SKILL.md')})`,
  );
});
