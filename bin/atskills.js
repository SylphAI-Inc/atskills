#!/usr/bin/env node
'use strict';
// atskills — reference CLI for the @skills protocol.
// Thin porcelain over dist/ (the ONE implementation, built from src/).
// SKILLS.md in this repo is the spec; src/ is the executable version of it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../dist/index.js');

const err = (s) => process.stderr.write(s + '\n');
const out = (s) => process.stdout.write(s + '\n');
const short = (p) => (p ? String(p).replace(os.homedir(), '~') : p);
const approxTokens = (s) => Math.ceil(String(s).length / 4);

/** SkillResolverOpts for the current directory; warnings go to stderr. */
function optsHere() {
  const root = A.findAtskills(process.cwd());
  return {
    workingDir: root ? path.dirname(root) : process.cwd(),
    // Porcelain seam only — the package itself never reads env.
    cacheDir: process.env.ATSKILLS_CACHE || undefined,
    log: { info: () => {}, warn: (m) => err(`! ${m}`) },
  };
}

function requireRoot() {
  const root = A.findAtskills(process.cwd());
  if (!root) throw new Error('no .atskills/ found here or above — create one: mkdir .atskills');
  return root;
}

// get — use a skill: prints SKILL.md; a directory prints a menu. Never installs.
async function cmdGet(rawId) {
  const id = A.normalizeId(rawId);
  const opts = optsHere();
  const res = await A.resolveSkill(id, false, opts);
  if (!res.success) throw new Error(res.error || `nothing at ${id}`);

  if (res.kind === 'skill') {
    const local = res.source === 'local';
    const dir = path.dirname(res.path);
    // The badge shows a LOCAL path — the project file, or the cached copy's
    // tree path for cloud skills.
    let where;
    if (local) {
      const stamp = A.nearestSource(dir, A.skillsRoot(opts.workingDir));
      where = `${path.relative(process.cwd(), res.path)}${stamp ? `  (saved from ${stamp.id}, ${stamp.taken})` : ''}`;
    } else {
      where = `${short(res.path)} (cloud·${res.served || 'fresh'})  ·  review: ${res.reviewUrl || A.webUrl(id)}`;
    }
    err(`⎿ read ${where} (${res.content.trimEnd().split('\n').length} lines)`);
    // ...and list the skill's directory too (read + list, the @file/@dir hybrid).
    const bundled = (res.files || []).filter((f) => f !== 'SKILL.md' && !f.startsWith('.'));
    if (bundled.length) {
      err(`⎿ listed directory ${local ? path.relative(process.cwd(), dir) : short(dir)}/ (${bundled.length + 1} items)`);
      for (const f of bundled) err(`  - ${f}`);
    }
    process.stdout.write(res.content);
    return;
  }

  const local = res.source === 'local';
  err(`⎿ read skills directory ${local ? path.relative(process.cwd(), res.dir) : short(res.dir)}/ (${res.entries.length} skills)${local ? '' : ` (cloud)  ·  review: ${res.reviewUrl || A.webUrl(id)}`}`);
  for (const e of res.entries) out(`- ${e.name}: ${e.description} (${short(e.path)}${e.bundle && e.bundle.length ? ' · dir: ' + e.bundle.join(', ') : ''})`);
}

// save — copy to .atskills/<path>/ + two-line .source. Save = adapt + detach.
async function cmdSave(rawId) {
  const id = A.normalizeId(rawId);
  const opts = optsHere();
  const res = await A.saveSkillToProject(id, opts);
  if (!res.success) throw new Error(res.error || `could not save ${id}`);

  const root = A.skillsRoot(opts.workingDir);
  const dest = A.safeJoin(root, A.diskPath(id));
  const stamp = A.nearestSource(dest, root);
  out(`saved: .atskills/${A.diskPath(id)}/ — yours now, detached`);
  // e.g. the parent-save absorption note ("… the collection copy is a superset").
  if (res.warning) out(res.warning);
  if (stamp) out(`.source records ${stamp.id} @ ${String(stamp.revision).slice(0, 7)}`);
  const executables = A.listFiles(dest).filter((f) => {
    try { return (fs.statSync(path.join(dest, f)).mode & 0o111) !== 0; } catch { return false; }
  });
  if (executables.length) out(`bundled executables (review before running): ${executables.join(', ')}`);
  if (A.hasTriggerLine(root, '@' + id)) {
    out(`note: .autotrigger has "@${id}" — your copy now answers it; flip the line to "${A.diskPath(id)}" so the file reads true`);
  }
}

// triggers — what fires on its own, per .atskills/.autotrigger.
async function cmdTriggers() {
  const root = requireRoot();
  const opts = optsHere();
  const resident = A.expandLocalTriggers(root);
  if (!resident.length) {
    out('no .autotrigger entries — nothing fires on its own');
    return;
  }
  let tokens = 0;
  for (const e of resident) {
    if (e.error) { out(`✗ ${e.line} — ${e.error}`); continue; }
    if (e.where !== 'cloud') {
      out(`● ${e.line.padEnd(36)} [${e.where}]  ${e.fm.name}: ${e.fm.description}`);
      tokens += approxTokens(`- ${e.fm.name}: ${e.fm.description}`);
      continue;
    }
    // Cloud line with no local copy: resolve through the global cache.
    const res = await A.resolveSkill(e.id, false, opts);
    if (!res.success) { out(`✗ ${e.line} — ${res.error}`); continue; }
    if (res.kind === 'skill') {
      const fm = A.frontmatter(res.content);
      out(`● ${e.line.padEnd(36)} [cloud·${res.served || 'fresh'}]  ${fm.name}: ${fm.description}`);
      tokens += approxTokens(`- ${fm.name}: ${fm.description}`);
    } else {
      out(`● ${e.line.padEnd(36)} [cloud·${res.served || 'fresh'}]  directory: ${res.entries.length} skills`);
      for (const row of res.entries) tokens += approxTokens(`- ${row.name}: ${row.description}`);
    }
  }
  out(`— ~${tokens} resident tokens (frontmatter only; bodies load on trigger)`);
}

// prompt — the exact injected text, verbatim, plus every problem hit on the way.
async function cmdPrompt() {
  requireRoot();
  const notes = [];
  const opts = { ...optsHere(), log: { info: () => {}, warn: (m) => notes.push(m) } };
  const text = await A.buildAutotriggerIndex(opts);
  if (!text) {
    out('(nothing auto-triggers — the injected prompt is empty)');
    for (const n of notes) err(`  ✗ ${n}`);
    return;
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  err('');
  err(`— ~${approxTokens(text)} tokens`);
  for (const n of notes) err(`  ✗ ${n}`);
}

// skills — the interactive console (non-technical users). Prefers the
// OpenTUI app (ui/, Bun runtime); falls back to the built-in ANSI TUI when
// Bun isn't around. ATSKILLS_UI=basic forces the fallback.
async function cmdSkills() {
  const root = requireRoot();
  if (process.env.ATSKILLS_UI !== 'basic') {
    const { spawnSync } = require('child_process');
    const uiDir = path.join(__dirname, '..', 'ui');
    const app = path.join(uiDir, 'skills.tsx');
    const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
    if (hasBun && fs.existsSync(app)) {
      if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
        err('first run — installing the console UI (bun install)…');
        const install = spawnSync('bun', ['install'], { cwd: uiDir, stdio: 'inherit' });
        if (install.status !== 0) {
          err('install failed — falling back to the basic console');
          return require('./ui-basic.js').run(root);
        }
      }
      const run = spawnSync('bun', [app], { stdio: 'inherit', cwd: process.cwd() });
      process.exit(run.status || 0);
    }
  }
  await require('./ui-basic.js').run(root);
}

const HELP = `atskills — reference CLI for the @skills protocol

  atskills get <path>      use a skill (prints SKILL.md; a directory prints a menu)
  atskills save <path>     copy to .atskills/<path>/ + .source   save = adapt + detach
  atskills triggers        what fires on its own (.atskills/.autotrigger)
  atskills prompt          the exact injected prompt, with the files/URLs it read
  atskills skills          interactive tree: toggle auto-trigger, view prompt
  atskills help

paths   owner/path = hub · gh:owner/repo/path = github (on disk: gh/…) · lowercase
rules   local path answers first · using never installs · follow theirs, own yours
cache   ~/.cache/atskills  (validating, like a browser; always safe to delete)
`;

/**
 * `atskills paths` — normalize/validate references, one per line on stdin,
 * one JSON object per line on stdout: {path, ok, id?, error?}.
 *
 * This exists so other languages can USE the grammar instead of restating it.
 * The indexing pipeline is Python and previously re-implemented the path rules,
 * the leaf rule, and the collection cap — three chances to disagree with the
 * resolver, which is how unreferenceable paths reached the catalog. Batched:
 * one process for the whole corpus, not one per path.
 */
async function cmdPaths() {
  const input = await new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buffer += chunk; });
    process.stdin.on('end', () => resolve(buffer));
  });
  let ok = 0;
  let bad = 0;
  const lines = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      lines.push(JSON.stringify({ path: line, ok: true, id: A.normalizeId(line) }));
      ok++;
    } catch (e) {
      lines.push(JSON.stringify({ path: line, ok: false, error: e.message }));
      bad++;
    }
  }
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
  err(`⎿ paths: ${ok} valid, ${bad} rejected`);
  if (bad) process.exitCode = 2;
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'get' && arg) await cmdGet(arg);
    else if (cmd === 'save' && arg) await cmdSave(arg);
    else if (cmd === 'triggers') await cmdTriggers();
    else if (cmd === 'prompt') await cmdPrompt();
    else if (cmd === 'skills') await cmdSkills();
    else if (cmd === 'paths') await cmdPaths();
    else process.stdout.write(HELP);
  } catch (e) {
    err(`✗ ${e.message}`);
    process.exit(1);
  }
})();
