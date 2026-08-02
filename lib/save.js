'use strict';
// Save = adapt + detach. The copy lands at the ID's own path (vendoring:
// same-org skills nest together, and the copy answers its own address), with
// one two-line .source at the top of whatever was saved:
//
//   gh:stripe/agent-toolkit
//   2026-08-01 rev:abc123
//
// Line 2 is a birth certificate, written once. Save-again: an UNEDITED copy
// (verified against upstream AT line 2's revision — no stored state) is
// replaced with the new; an EDITED copy is a conflict — refuse, touch
// nothing, show the ways out. No digest, no staging, no merge machinery:
// merging is an agent's job on request, with line 2 as the base.

const fs = require('fs');
const path = require('path');
const { diskPath, isGh, ghParts } = require('./ids');
const { safeJoin, nearestSource, pool, leafSkillDirs, assertCollectionFits } = require('./fsx');
const sources = require('./sources');

function readSource(dest) {
  const f = path.join(dest, '.source');
  if (!fs.existsSync(f)) return null;
  const [id, line2 = ''] = fs.readFileSync(f, 'utf8').trim().split('\n');
  const m = /^(\S+)\s+rev:(\S+)$/.exec(line2.trim());
  return { id: id.trim(), taken: m ? m[1] : line2.trim(), revision: m ? m[2] : null };
}

function writeSource(dest, id, revision) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dest, '.source'), `${id}\n${today} rev:${revision}\n`);
}

// Downloading a gh: subtree is a solved problem — use git itself:
// shallow clone, blob:none filter, sparse checkout of the sub-path. One
// round-trip negotiation, only the needed blobs, private repos work through
// the user's existing git credentials. No hand-rolled transfer code.
// `gitBase` is the test seam (file:// remotes) and the GitHub Enterprise seam;
// it defaults to the real thing.
function gitCloneTo(id, ref, dest, gitBase) {
  const { owner, repo, sub } = ghParts(id);
  const os = require('os');
  const { spawnSync } = require('child_process');
  const url = `${gitBase || 'https://github.com'}/${owner}/${repo}.git`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-git-'));
  const run = (args, cwd) => {
    // never hang on a credential prompt; never wait forever
    const r = spawnSync('git', args, {
      cwd,
      stdio: 'ignore',
      timeout: 120000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed for ${url}`);
  };
  // A tree listing for the repos this cap exists to stop is MEGABYTES of
  // paths: node's 1 MB default buffer overflows with ENOBUFS on exactly those,
  // and an empty listing would read as "0 skills — allowed". So: a big buffer,
  // and a hard failure rather than a silent pass. Fail closed, always.
  const capture = (args, cwd) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    if (r.status !== 0) {
      throw new Error(`git ${args[0]} failed for ${url}${r.error ? ` (${r.error.code})` : ''}`);
    }
    return String(r.stdout);
  };
  try {
    // Phase 1 — fetch the TREE only. `--no-checkout` is what makes
    // `--filter=blob:none` actually hold: given a working tree to populate,
    // git lazily faults in every blob anyway. Empty tree, no file contents.
    let treeish;
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      // pinned revision: fetch exactly that sha
      run(['init', '--quiet', tmp]);
      run(['remote', 'add', 'origin', url], tmp);
      run(['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', ref], tmp);
      treeish = 'FETCH_HEAD';
    } else {
      run(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', url, tmp]);
      treeish = 'HEAD';
    }

    // Phase 2 — refuse an oversized reference before paying for it. Saving
    // VENDORS the tree into the project, so this is the copy that would
    // otherwise drop thousands of skill folders into someone's repo.
    const listed = capture(['ls-tree', '-r', '--name-only', treeish], tmp)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const prefix = sub ? `${sub.replace(/\/+$/, '')}/` : '';
    const scoped = prefix
      ? listed.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
      : listed;
    const skillDirs = leafSkillDirs(scoped);
    // '' means SKILL.md sits at the path itself: one skill, bundle any size.
    if (!skillDirs.includes('')) assertCollectionFits(id, skillDirs);

    // Phase 3 — only now materialize, narrowed to the sub-path.
    if (sub) run(['sparse-checkout', 'set', '--no-cone', sub], tmp);
    run(['checkout', '--quiet', treeish], tmp);

    const srcDir = sub ? path.join(tmp, sub) : tmp;
    if (!fs.existsSync(srcDir)) throw new Error(`no ${sub || 'content'} at ${id}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(srcDir, dest, {
      recursive: true,
      filter: (p2) => {
        if (p2.split(path.sep).includes('.git')) return false;
        try {
          return !fs.lstatSync(p2).isSymbolicLink(); // never vendor symlinks
        } catch {
          return true;
        }
      },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findExecutables(dest) {
  return localFiles(dest).filter((rel) => /(^|\/)scripts\//.test(rel) || /\.(sh|bash|py|js|ts|rb|pl)$/.test(rel));
}

async function downloadTo(cache, id, dest, ref, opts = {}) {
  if (isGh(id)) {
    try {
      gitCloneTo(id, ref || 'HEAD', dest, opts.gitBase);
    } catch (err) {
      // A refusal is a verdict, not a transport failure — retrying it over a
      // slower path would download the very thing the cap just rejected.
      if (err && err.code === 'TOO_LARGE') throw err;
      // fallback: per-file fetches, bounded fan-out
      const files = await sources.listGhFiles(cache, id);
      if (!files.length) throw new Error(`nothing at ${id}`);
      // Same cap on the fallback: this path costs one request per FILE, so an
      // oversized reference is worse here than through git, not better.
      const fallbackDirs = leafSkillDirs(files);
      if (!fallbackDirs.includes('')) assertCollectionFits(id, fallbackDirs);
      await pool(files, 8, async (rel) => {
        const { buffer } = await sources.fetchFile(cache, id, rel);
        const out = safeJoin(dest, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buffer); // binary-safe
      });
    }
    if (!fs.existsSync(path.join(dest, 'SKILL.md')) && !localFiles(dest).some((f) => f.endsWith('SKILL.md'))) {
      throw new Error(`nothing at ${id}`);
    }
    return findExecutables(dest);
  }
  const { buffer } = await sources.fetchSkill(cache, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), buffer);
  return findExecutables(dest);
}

// Non-dot files of a saved tree, relative paths.
function localFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...localFiles(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

// Is the copy untouched since save? Verified against upstream AT the saved
// revision (immutable, fetchable by sha) — nothing stored beyond .source's
// two lines. Unverifiable (hub, unknown rev) counts as edited: refuse safely.
async function isUnedited(cache, id, dest, revision, opts = {}) {
  // needs the FULL sha .source records at save time (short/legacy = unverifiable → conflict, safely)
  if (!isGh(id) || !revision || !/^[0-9a-f]{40}$/i.test(revision)) return false;
  const os = require('os');
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), 'atskills-verify-'));
  try {
    // git fetches exactly the saved revision; compare tree-to-tree locally
    gitCloneTo(id, revision, path.join(ref, 'tree'), opts.gitBase);
    const a = localFiles(path.join(ref, 'tree')).sort();
    const b = localFiles(dest).sort();
    if (a.length !== b.length || a.some((f, i) => f !== b[i])) return false;
    return a.every((rel) => fs.readFileSync(path.join(ref, 'tree', rel)).equals(fs.readFileSync(path.join(dest, rel))));
  } catch {
    return false;
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
}

// save(cache, id, root, opts) → { dest, revision, executables, action }
// action: 'saved' (new) | 'updated' (unedited copy replaced with the new).
// An edited copy — or one that can't be verified — is a conflict: refuse.
// opts.gitBase overrides the git remote base (tests: file:// fixtures).
async function save(cache, id, root, opts = {}) {
  const dest = safeJoin(root, diskPath(id));

  if (fs.existsSync(dest)) {
    // Origin = the closest .source at or above (a directory save writes one
    // .source at the subtree top covering every child).
    const prior = nearestSource(dest, root);
    if (!prior) {
      throw new Error(
        `conflict: .atskills/${diskPath(id)} already exists and has no .source — it's the project's own work; ` +
          `refusing to overwrite. Rename your folder or pick a different path.`
      );
    }
    if (await isUnedited(cache, id, dest, prior.revision, opts)) {
      // no conflict — always replace with the new (download first, swap after)
      return { ...(await freshSave(cache, id, dest, opts)), action: 'updated' };
    }
    throw new Error(
      `conflict: .atskills/${diskPath(id)} already exists (saved from ${prior.id}, ${prior.taken}) and was edited — ` +
        `your copy stays untouched. To address it:\n` +
        `  · keep yours — do nothing\n` +
        `  · refetch upstream — delete the folder, then :save again (git keeps your history)\n` +
        `  · merge — ask your agent to diff and merge; rev:${prior.revision} is the base`
    );
  }

  // Dot-prefixed temp dir: dotfiles are metadata — never walked, never listed,
  // and an interrupted save leaves nothing that looks like a skill.
  return { ...(await freshSave(cache, id, dest, opts)), action: 'saved' };
}

// Download fully to a hidden temp dir FIRST; only then swap into place — a
// failed download can never destroy an existing copy.
async function freshSave(cache, id, dest, opts = {}) {
  const revision = await sources.headRevision(cache, id, opts.gitBase);
  const tmp = path.join(
    path.dirname(dest),
    `.saving-${path.basename(dest)}-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    // download AT the recorded revision — .source line 2 matches the bytes exactly
    const executables = await downloadTo(cache, id, tmp, revision === 'unknown' ? 'HEAD' : revision, opts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    writeSource(dest, id, revision);
    return { dest, revision, executables };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { save, readSource };
