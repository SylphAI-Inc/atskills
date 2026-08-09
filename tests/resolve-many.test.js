'use strict';
// resolveSkills — composition resolved concurrently.
//
// Hosts were resolving a message's references in a `for` loop with an `await`
// inside, so N cloud references cost N SEQUENTIAL round trips: a four-reference
// chain paid four latencies for work that is entirely independent. These tests
// pin both halves of the fix — that it IS concurrent, and that it kept every
// guarantee the sequential loop gave for free.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSkills } = require('../dist/index.js');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-many-'));
  fs.mkdirSync(path.join(root, '.atskills'), { recursive: true });
  return root;
}

function skill(workingDir, rel, name) {
  const dir = path.join(workingDir, '.atskills', ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: about ${name}\n---\nbody of ${name}\n`,
  );
}

const optsFor = (workingDir) => ({
  workingDir,
  cacheDir: path.join(workingDir, '.cache'),
});

test('results are positionally aligned with the ids given', async () => {
  const wd = project();
  skill(wd, 'alpha', 'alpha');
  skill(wd, 'beta', 'beta');
  skill(wd, 'gamma', 'gamma');

  const out = await resolveSkills(['gamma', 'alpha', 'beta'], optsFor(wd));

  // Order is not incidental: the host injects each reference at its own point
  // of use, so a reordered batch would put the wrong skill in the wrong place.
  assert.equal(out.length, 3);
  assert.match(out[0].content, /body of gamma/);
  assert.match(out[1].content, /body of alpha/);
  assert.match(out[2].content, /body of beta/);
});

test('a repeated id resolves once and is shared', async () => {
  const wd = project();
  skill(wd, 'alpha', 'alpha');

  const out = await resolveSkills(['alpha', 'alpha', 'alpha'], optsFor(wd));

  assert.equal(out.length, 3);
  for (const r of out) assert.ok(r.success);
  // Same resolution object for every occurrence — proof one lookup was shared
  // rather than three racing. For a cloud id that also prevents two concurrent
  // saves racing on the same directory.
  assert.strictEqual(out[0], out[1]);
  assert.strictEqual(out[1], out[2]);
});

test('one failure is isolated — the rest of the message survives', async () => {
  const wd = project();
  skill(wd, 'alpha', 'alpha');
  skill(wd, 'beta', 'beta');

  const out = await resolveSkills(['alpha', 'no-such-skill', 'beta'], optsFor(wd));

  assert.ok(out[0].success, 'first survived');
  assert.equal(out[1].success, false, 'the bad one failed in its own slot');
  assert.ok(out[2].success, 'the one AFTER the failure still resolved');
});

test('an empty message resolves to nothing, without touching disk', async () => {
  const wd = project();
  assert.deepEqual(await resolveSkills([], optsFor(wd)), []);
});

// NOTE — there is deliberately no wall-clock concurrency test here.
//
// Local resolution is synchronous filesystem work, and this package exposes no
// seam to inject latency into a read, so any timing assertion written at this
// level would either measure the test's own Promise.all or be too loose to
// mean anything. The concurrency claim is pinned where latency IS injectable:
// the CLI passes its own `loadWorkflow`, so
// adal-cli/.../skillComposition.test.ts stubs it with a timer and asserts the
// batch overlaps. What this file pins is the CONTRACT the concurrency must not
// break — order, dedup, isolation, and serialized writes.

test('writes stay serialized — concurrent installs do not interleave', async () => {
  const wd = project();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(`w${i}`);
    skill(wd, `w${i}`, `w${i}`);
  }

  await resolveSkills(
    ids,
    optsFor(wd),
    ids.map(() => ({ install: true })),
  );

  // `.autotrigger` is ONE file appended to per install. Parallelising those
  // writes interleaves them and drops lines, which is why only the read path
  // is concurrent. Every line must be present, exactly once.
  const lines = fs
    .readFileSync(path.join(wd, '.atskills', '.autotrigger'), 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  assert.equal(lines.length, ids.length, `expected ${ids.length} lines, got ${lines.length}`);
  for (const id of ids) assert.ok(lines.includes(id), `missing line for ${id}`);
});
