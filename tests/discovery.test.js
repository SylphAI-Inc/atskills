'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveSkill } = require('../dist/index.js');

/**
 * A throwaway repo holding one skill, laid out the way the resolver looks for
 * it: the remote is `<base>/<owner>/<repo>.git`, so the fixture has to be a
 * BARE repo at exactly that path under a base directory.
 * Returns the base to hand to `githubBaseUrl`.
 */
function makeRepo(owner = 'owner', repo = 'repo') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-base-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-src-'));
  const skill = path.join(work, 'skills', 'demo');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo\n---\nbody\n');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  git(work, 'init', '-q');
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 't');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'init');
  fs.mkdirSync(path.join(base, owner), { recursive: true });
  execFileSync('git', ['clone', '--bare', '-q', work, path.join(base, owner, `${repo}.git`)], { stdio: 'ignore' });
  return base;
}

/** Records POST bodies; `mode` decides how badly it misbehaves. */
function makeCatalogue(mode = 'ok') {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body });
      if (mode === 'error') { res.writeHead(500); res.end('nope'); return; }
      if (mode === 'hang') return; // never responds
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('a gh: resolve announces the path to the catalogue', async () => {
  const base = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-work-'));
  const { server, seen } = makeCatalogue('ok');
  const port = await listen(server);
  try {
    const res = await resolveSkill('gh:owner/repo/skills/demo', false, {
      workingDir: work,
      cacheDir: path.join(work, 'cache'),
      githubBaseUrl: `file://${base}`,
      discoveryBaseUrl: `http://127.0.0.1:${port}`,
    });
    // The resolve is what it always was.
    assert.equal(res.success, true, res.error);
    // Fire-and-forget: give the un-awaited POST a moment to land.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 1, 'catalogue should have been told exactly once');
    assert.equal(seen[0].url, '/index');
    assert.deepEqual(JSON.parse(seen[0].body), { reference: 'gh:owner/repo/skills/demo' });
  } finally {
    server.close();
  }
});

test('no discoveryBaseUrl means no call at all — the protocol default', async () => {
  const base = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-work-'));
  const { server, seen } = makeCatalogue('ok');
  const port = await listen(server);
  try {
    const res = await resolveSkill('gh:owner/repo/skills/demo', false, {
      workingDir: work,
      cacheDir: path.join(work, 'cache'),
      githubBaseUrl: `file://${base}`,
      // discoveryBaseUrl deliberately unset
    });
    assert.equal(res.success, true, res.error);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.length, 0, 'nothing may be sent without an explicit catalogue');
    // Prove the port was reachable, so 0 means "not called", not "could not".
    await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST', body: '{}' });
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});

test('a catalogue that 500s, or hangs, cannot break or slow a resolve', async () => {
  for (const mode of ['error', 'hang']) {
    const base = makeRepo();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-work-'));
    const { server } = makeCatalogue(mode);
    const port = await listen(server);
    try {
      const started = Date.now();
      const res = await resolveSkill('gh:owner/repo/skills/demo', false, {
        workingDir: work,
        cacheDir: path.join(work, 'cache'),
        githubBaseUrl: `file://${base}`,
        discoveryBaseUrl: `http://127.0.0.1:${port}`,
      });
      const took = Date.now() - started;
      assert.equal(res.success, true, `${mode}: ${res.error}`);
      // The hang case is the load-bearing one: the POST never answers, so if
      // resolution awaited it this would sit here for the full 5s timeout.
      assert.ok(took < 4000, `${mode}: resolve waited ${took}ms on the catalogue`);
    } finally {
      server.close();
    }
  }
});

test('an unreachable catalogue is identical to no catalogue', async () => {
  const base = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-work-'));
  const res = await resolveSkill('gh:owner/repo/skills/demo', false, {
    workingDir: work,
    cacheDir: path.join(work, 'cache'),
    githubBaseUrl: `file://${base}`,
    // Nothing listens here, and the URL is junk on top.
    discoveryBaseUrl: 'http://127.0.0.1:1/not-a-real-place',
  });
  assert.equal(res.success, true, res.error);
});

test('a GitHub Enterprise host is never announced', async () => {
  // An internal install means internal repo names — `acme/payments-internal`
  // — which a public catalogue cannot index and has no business learning.
  //
  // The resolve itself fails here, since nothing serves that host, and that
  // is fine: what is under test is that NOTHING was sent, whatever git did.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-work-'));
  const { server, seen } = makeCatalogue('ok');
  const port = await listen(server);
  try {
    await resolveSkill('gh:acme/payments-internal', false, {
      workingDir: work,
      cacheDir: path.join(work, 'cache'),
      githubBaseUrl: 'https://github.acme-corp.internal',
      discoveryBaseUrl: `http://127.0.0.1:${port}`,
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 0, 'an internal repo name reached the catalogue');
  } finally {
    server.close();
  }
});
