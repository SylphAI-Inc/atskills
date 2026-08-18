'use strict';
/**
 * The announce must not delay the CLI's EXIT.
 *
 * Separate from discovery.test.js because it can only be observed from
 * outside: every in-process test either calls process.exit or closes its
 * server, and both hide the failure. The bug this guards against — an
 * un-awaited request holding the event loop open — showed up as ~5s of dead
 * air AFTER the work finished, which a user reads as the CLI hanging.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const CLIENT = path.join(os.tmpdir(), 'atskills-exit-client.js');

function writeClient() {
  fs.writeFileSync(CLIENT, `
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {resolveSkill}=require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'index.js'))});
const port=process.argv[2];
function makeRepo(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'b-'));
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'s-'));
  const sk=path.join(work,'skills','demo'); fs.mkdirSync(sk,{recursive:true});
  fs.writeFileSync(path.join(sk,'SKILL.md'),'---\\nname: demo\\n---\\nbody\\n');
  const g=(c,...a)=>execFileSync('git',a,{cwd:c,stdio:'ignore'});
  g(work,'init','-q'); g(work,'config','user.email','t@t.t'); g(work,'config','user.name','t');
  g(work,'add','-A'); g(work,'commit','-qm','i');
  fs.mkdirSync(path.join(base,'owner'),{recursive:true});
  execFileSync('git',['clone','--bare','-q',work,path.join(base,'owner','repo.git')],{stdio:'ignore'});
  return base;
}
(async()=>{
  const base=makeRepo(); const work=fs.mkdtempSync(path.join(os.tmpdir(),'w-'));
  const r=await resolveSkill('gh:owner/repo/skills/demo',false,{
    workingDir:work,cacheDir:path.join(work,'c'),
    githubBaseUrl:'file://'+base,
    discoveryBaseUrl: port ? 'http://127.0.0.1:'+port : undefined,
  });
  if(!r.success) { console.error(r.error); process.exit(1); }
  // Deliberately NO process.exit(): the loop must drain on its own.
})();
`);
}

function runClient(port) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn('node', [CLIENT, ...(port ? [String(port)] : [])], { stdio: 'ignore' });
    child.on('close', (code) => res({ ms: Date.now() - started, code }));
  });
}

test('a catalogue that never answers does not delay the process exiting', async () => {
  writeClient();
  // The stalling server lives in THIS process; the client is a child, so the
  // only handles that can hold the child open are its own.
  const server = http.createServer(() => {});
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const withoutCatalogue = await runClient(null);
    const withDeadCatalogue = await runClient(port);

    assert.equal(withoutCatalogue.code, 0);
    assert.equal(withDeadCatalogue.code, 0);

    const added = withDeadCatalogue.ms - withoutCatalogue.ms;
    // Generous bound: this is wall-clock across two node spawns, so it is
    // noisy. The regression it catches was 5000ms — an order of magnitude
    // clear of any plausible flake.
    assert.ok(
      added < 1500,
      `a dead catalogue added ${added}ms to exit (${withoutCatalogue.ms} -> ${withDeadCatalogue.ms})`,
    );
  } finally {
    server.close();
  }
});
