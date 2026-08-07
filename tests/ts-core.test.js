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

test('a bare path never reaches the network — the prefix decides (§5.0)', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();

  // A registry IS configured, pointed at a port nothing listens on: under the
  // old local-first-then-cloud rule this shape fell through and fetched. Now
  // the miss is terminal, so no connection is ever attempted.
  const r = await core.resolveSkill('someone/elses-skill', false, {
    ...resolverOpts(workingDir),
    registryBaseUrl: 'http://127.0.0.1:1/should-never-be-called',
  });

  assert.equal(r.success, false);
  assert.match(r.error, /\.atskills\/someone\/elses-skill/); // says where it looked
  assert.match(r.error, /hub:owner\/name/);                  // and how to reach the cloud
  assert.match(r.error, /gh:owner\/repo\/path/);
  assert.doesNotMatch(r.error, /registry|HTTP|ECONN|fetch/i); // no fetch was attempted
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
  makeLocalSkill(workingDir, 'sec-check', 'Reviews security');
  fs.writeFileSync(path.join(workingDir, '.atskills', '.autotrigger'), 'sec-check\n');

  const block = await core.buildAutotriggerIndex(resolverOpts(workingDir));
  // Project rows carry PROJECT-RELATIVE paths: stable across machines, no
  // username in the prompt, readable from the project cwd.
  assert.equal(
    block,
    'Auto-triggered Skills (.atskills/.autotrigger):\n- sec-check: Reviews security (.atskills/sec-check/SKILL.md)',
  );
});

// ── Hub auth (§5.0) ──────────────────────────────────────────────────────────
// A private skill belongs to an account, so reading one carries that account's
// token. The registry answers 404 — never 401 — for a private skill you cannot
// read, so "missing" and "not yours" are indistinguishable to the client; the
// error text has to serve both, or a signed-out owner is told their own skill
// does not exist.

/** A registry on a real port, so we can see exactly what the resolver sent. */
function stubRegistry(handler) {
  const http = require('node:http');
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

test('hub read sends the bearer token the host supplies', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  let seen = 'UNSET';

  const reg = await stubRegistry((req, res) => {
    seen = req.headers.authorization ?? 'NONE';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entry: { content: '---\nname: p\ndescription: d\n---\nbody\n' } }));
  });

  try {
    const r = await core.resolveSkill('hub:acme/private-one', false, {
      ...resolverOpts(workingDir),
      registryBaseUrl: reg.url,
      registryAuth: () => 'tok-123',
    });
    assert.equal(r.success, true);
    assert.equal(seen, 'Bearer tok-123');
  } finally {
    reg.close();
  }
});

test('registryAuth is called per request, so a refreshed token is used', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  const sent = [];
  let n = 0;

  const reg = await stubRegistry((req, res) => {
    sent.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ entry: { content: '---\nname: p\ndescription: d\n---\nbody\n' } }));
  });

  try {
    const o = {
      ...resolverOpts(workingDir),
      registryBaseUrl: reg.url,
      // Rotates, as a real session's token does.
      registryAuth: () => `tok-${++n}`,
    };
    await core.resolveSkill('hub:acme/one', false, o);
    await core.resolveSkill('hub:acme/two', false, o);
    assert.deepEqual(sent, ['Bearer tok-1', 'Bearer tok-2']);
  } finally {
    reg.close();
  }
});

test('no token → anonymous request, and 404 says a private skill needs sign-in', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();
  let seen = 'UNSET';

  const reg = await stubRegistry((req, res) => {
    seen = req.headers.authorization ?? 'NONE';
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  try {
    const r = await core.resolveSkill('hub:acme/secret', false, {
      ...resolverOpts(workingDir),
      registryBaseUrl: reg.url,
    });
    assert.equal(seen, 'NONE');            // no Authorization header invented
    assert.equal(r.success, false);
    assert.match(r.error, /private/i);     // tells a signed-out owner what to do
    assert.match(r.error, /sign in/i);
  } finally {
    reg.close();
  }
});

test('404 WITH a token does not suggest signing in — they already are', opts, async () => {
  const core = await import(DIST);
  const workingDir = project();

  const reg = await stubRegistry((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  try {
    const r = await core.resolveSkill('hub:acme/missing', false, {
      ...resolverOpts(workingDir),
      registryBaseUrl: reg.url,
      registryAuth: () => 'tok-123',
    });
    assert.equal(r.success, false);
    assert.doesNotMatch(r.error, /sign in/i);
  } finally {
    reg.close();
  }
});
