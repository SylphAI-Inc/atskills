#!/usr/bin/env node
'use strict';
// atskills — reference CLI for the @skills protocol.
// Thin porcelain over lib/: get / save / triggers / prompt / skills.
// SKILLS.md in this repo is the spec; lib/ is the executable version of it.

const path = require('path');
const { Cache, DEFAULT_DIR } = require('../lib/cache');
const { normalizeId, diskPath, isGh } = require('../lib/ids');
const { findAtskills } = require('../lib/fsx');
const { resolve } = require('../lib/resolve');
const { save } = require('../lib/save');
const trigger = require('../lib/autotrigger');
const { buildPrompt } = require('../lib/prompt');
const ui = require('../lib/ui');

const err = (s) => process.stderr.write(s + '\n');
const out = (s) => process.stdout.write(s + '\n');

function cache() {
  return new Cache(undefined, { log: (_lvl, msg) => err(`! ${msg}`) });
}

function requireRoot() {
  const root = findAtskills(process.cwd());
  if (!root) throw new Error('no .atskills/ found here or above — create one: mkdir .atskills');
  return root;
}

// get — use a skill: prints SKILL.md; a directory prints a menu. Never installs.
async function cmdGet(rawId) {
  const id = normalizeId(rawId);
  const root = findAtskills(process.cwd());
  const res = await resolve(cache(), id, root);

  const home = require('os').homedir();
  const short = (p) => (p ? String(p).replace(home, '~') : p);
  if (res.kind === 'skill') {
    // Like adal's @workflow: the badge shows a LOCAL path — the project file,
    // or the cached copy's tree path for cloud skills.
    const where =
      res.where === 'local'
        ? `${path.relative(process.cwd(), res.dir)}/SKILL.md${res.source ? `  (saved from ${res.source.id}, ${res.source.taken})` : ''}`
        : `${short(res.cachePath)} (cloud·${res.status})  ·  review: ${require('../lib/sources').webUrl(id)}`;
    err(`⎿ read ${where} (${res.text.trimEnd().split('\n').length} lines)`);
    // ...and list the skill's directory too (read + list, the @file/@dir hybrid).
    let bundled = [];
    try {
      if (res.where === 'local') {
        const walk = (d, rel) =>
          require('fs').readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            if (e.name.startsWith('.')) return [];
            const r = rel ? `${rel}/${e.name}` : e.name;
            return e.isDirectory() ? walk(path.join(d, e.name), r) : [r];
          });
        bundled = walk(res.dir, '').filter((f) => f !== 'SKILL.md');
      } else if (isGh(id)) {
        const sources = require('../lib/sources');
        bundled = (await sources.listGhFiles(cache(), id)).filter((f) => f !== 'SKILL.md');
      }
    } catch { bundled = []; }
    if (bundled.length) {
      const localDir = res.where === 'local'
        ? path.relative(process.cwd(), res.dir)
        : short(path.dirname(res.cachePath));
      err(`⎿ listed directory ${localDir}/ (${bundled.length + 1} items)`);
      for (const f of bundled) err(`  - ${f}`);
    }
    process.stdout.write(res.text);
    return;
  }
  const dirShown = res.where === 'local' ? path.join('.atskills', diskPath(id)) : short(res.cacheDir);
  err(`⎿ read skills directory ${dirShown}/ (${res.entries.length} skills)${res.where === 'local' ? '' : ` (cloud)  ·  review: ${require('../lib/sources').webUrl(id)}`}`);
  for (const e of res.entries) out(`- ${e.name}: ${e.description} (${short(e.file) || e.id}${e.bundle && e.bundle.length ? ' · dir: ' + e.bundle.join(', ') : ''})`);
}

// save — copy to .atskills/<path>/ + two-line .source. Save = adapt + detach.
async function cmdSave(rawId) {
  const id = normalizeId(rawId);
  const root = findAtskills(process.cwd()) || path.join(process.cwd(), '.atskills');
  try {
    const r = await save(cache(), id, root);
    out(`${r.action === 'updated' ? 'updated' : 'saved'}: .atskills/${diskPath(id)}/ — yours now, detached`);
    out(`.source records ${id} @ ${r.revision}`);
    if (r.executables.length) out(`bundled executables (review before running): ${r.executables.join(', ')}`);
    if (trigger.hasLine(root, '@' + id)) {
      out(`note: .autotrigger has "@${id}" — your copy now answers it; flip the line to "${diskPath(id)}" so the file reads true`);
    }
  } catch (e) {
    if (e.code === 'EDITED') {
      err(`✗ ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

// triggers — what fires on its own, per .atskills/.autotrigger.
async function cmdTriggers() {
  const root = requireRoot();
  const entries = await trigger.expand(cache(), root);
  if (!entries.length) {
    out('no .autotrigger entries — nothing fires on its own');
    return;
  }
  for (const e of entries) {
    if (e.error) out(`✗ ${e.line} — ${e.error}`);
    else out(`● ${e.line.padEnd(36)} [${e.where}${e.status ? '·' + e.status : ''}]  ${e.fm.name}: ${e.fm.description}`);
  }
  out(`— ~${trigger.residentTokens(entries)} resident tokens (frontmatter only; bodies load on trigger)`);
}

// prompt — the exact injected text, verbatim, with the read trail.
async function cmdPrompt() {
  const root = requireRoot();
  const { text, tokens, sections } = await buildPrompt(cache(), root);
  if (!text) {
    out('(nothing auto-triggers — the injected prompt is empty)');
    return;
  }
  process.stdout.write(text);
  err('');
  err(`— ~${tokens} tokens, read from:`);
  for (const s of sections) {
    if (s.error) err(`  ✗ ${s.line}  ${s.error}`);
    else err(`  ⎿ read ${s.ref}${s.web ? '  ·  review: ' + s.web : ''}`);
  }
}

// skills — the interactive console (non-technical users). Prefers the
// OpenTUI app (ui/, Bun runtime); falls back to the built-in ANSI TUI when
// Bun isn't around. ATSKILLS_UI=basic forces the fallback.
async function cmdSkills() {
  const root = requireRoot();
  if (process.env.ATSKILLS_UI !== 'basic') {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const uiDir = path.join(__dirname, '..', 'ui');
    const app = path.join(uiDir, 'skills.tsx');
    const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
    if (hasBun && fs.existsSync(app)) {
      if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
        err('first run — installing the console UI (bun install)…');
        const install = spawnSync('bun', ['install'], { cwd: uiDir, stdio: 'inherit' });
        if (install.status !== 0) {
          err('install failed — falling back to the basic console');
          return ui.run(cache(), root);
        }
      }
      const run = spawnSync('bun', [app], { stdio: 'inherit', cwd: process.cwd() });
      process.exit(run.status || 0);
    }
  }
  await ui.run(cache(), root);
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
cache   ${DEFAULT_DIR}  (validating, like a browser; always safe to delete)
`;

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'get' && arg) await cmdGet(arg);
    else if (cmd === 'save' && arg) await cmdSave(arg);
    else if (cmd === 'triggers') await cmdTriggers();
    else if (cmd === 'prompt') await cmdPrompt();
    else if (cmd === 'skills') await cmdSkills();
    else process.stdout.write(HELP);
  } catch (e) {
    err(`✗ ${e.message}`);
    process.exit(1);
  }
})();
