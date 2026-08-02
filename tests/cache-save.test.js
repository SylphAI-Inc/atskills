'use strict';
// Cache + save against a local HTTP "hub" — real conditional requests,
// no network. ATSKILLS_HUB/ATSKILLS_CACHE are set before lib load.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-hub-'));
process.env.ATSKILLS_CACHE = path.join(tmpBase, 'cache');

let server;
let baseUrl;
const state = {
  body: '---\nname: demo\ndescription: a demo skill\n---\nversion one\n',
  hits: [],
};

before(async () => {
  server = http.createServer((req, res) => {
    state.hits.push({ url: req.url, inm: req.headers['if-none-match'] || null });
    if (req.url.startsWith('/gone')) {
      res.writeHead(404).end('nope');
      return;
    }
    const etag = '"' + crypto.createHash('sha1').update(state.body).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { ETag: etag }).end(state.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.ATSKILLS_HUB = baseUrl;
});

after(() => server.close());

function freshLib() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('atskills', 'lib'))) delete require.cache[k];
  }
  return require('../lib/index');
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-proj-'));
  fs.mkdirSync(path.join(root, '.atskills'));
  return path.join(root, '.atskills');
}

test('cache: first fetch, 304 revalidation, change detection, 404-gone', async () => {
  const { Cache } = freshLib();
  const cache = new Cache();

  const a = await cache.fetch(`${baseUrl}/demo/skill`);
  assert.equal(a.status, 'first');
  assert.match(a.text, /version one/);

  const b = await cache.fetch(`${baseUrl}/demo/skill`);
  assert.equal(b.status, 'cache'); // 304 — served from disk
  assert.match(b.text, /version one/);
  assert.ok(state.hits.at(-1).inm, 'revalidation sent If-None-Match');

  state.body = state.body.replace('version one', 'version two');
  const c = await cache.fetch(`${baseUrl}/demo/skill`);
  assert.equal(c.status, 'fresh');
  assert.match(c.text, /version two/);

  await assert.rejects(() => cache.fetch(`${baseUrl}/gone/skill`), /not found/);
});

test('cache: offline serves stale with warning', async () => {
  const { Cache } = freshLib();
  const warnings = [];
  const cache = new Cache(undefined, { log: (_l, m) => warnings.push(m) });
  const url = `${baseUrl}/demo/skill`;
  await cache.fetch(url); // warm

  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const off = await cache.fetch(url);
  assert.equal(off.status, 'stale');
  assert.match(warnings.join(' '), /offline/);
  await new Promise((r) => {
    server = http.createServer((req, res) => res.writeHead(200, {}).end(state.body));
    server.listen(port, '127.0.0.1', r);
  });
});

test('save: vendored path, two-line .source, save-again refuses', async () => {
  const lib = freshLib();
  const cache = new lib.Cache();
  const root = project();

  // first save
  const r1 = await lib.save(cache, 'demo/skill', root);
  assert.equal(r1.action, 'saved');
  const dest = path.join(root, 'demo/skill');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  const sourceLines = fs.readFileSync(path.join(dest, '.source'), 'utf8').trim().split('\n');
  assert.equal(sourceLines[0], 'demo/skill');
  assert.match(sourceLines[1], /^\d{4}-\d{2}-\d{2} rev:/);

  // resolution: the saved copy answers its own address, .source never consulted
  const res = await lib.resolve(cache, 'demo/skill', root);
  assert.equal(res.where, 'local');
  assert.equal(res.source.id, 'demo/skill');

  // save-again refuses — it's your file now; refetch = delete + save
  fs.appendFileSync(path.join(dest, 'SKILL.md'), '\nmy house rules\n');
  await assert.rejects(() => lib.save(cache, 'demo/skill', root), /conflict: .*delete the folder, then :save again/s);
  // the adaptation is untouched
  assert.match(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /my house rules/);
  // delete + save-again = the refetch path
  fs.rmSync(dest, { recursive: true, force: true });
  const r2 = await lib.save(cache, 'demo/skill', root);
  assert.equal(r2.action, 'saved');
});

test('save: refuses to overwrite the project\'s own work (no .source)', async () => {
  const lib = freshLib();
  const cache = new lib.Cache();
  const root = project();
  const own = path.join(root, 'demo/skill');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), '---\nname: mine\ndescription: mine\n---');
  await assert.rejects(() => lib.save(cache, 'demo/skill', root), /conflict: .*project's own work/s);
});

test('resolve: local wins by path; cloud path with no folder goes to the cloud', async () => {
  const lib = freshLib();
  const cache = new lib.Cache();
  const root = project();
  const remote = await lib.resolve(cache, 'demo/skill', root);
  assert.equal(remote.where, 'hub');

  const local = path.join(root, 'other/name');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'SKILL.md'), '---\nname: other\ndescription: d\n---');
  const r = await lib.resolve(cache, 'other/name', root);
  assert.equal(r.where, 'local');
  assert.equal(r.source, null); // yours — no .source
});
