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
const { diskPath, isGh } = require('./ids');
const { safeJoin, nearestSource } = require('./fsx');
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

async function downloadTo(cache, id, dest) {
  const executables = [];
  if (isGh(id)) {
    const files = await sources.listGhFiles(cache, id);
    if (!files.length) throw new Error(`nothing at ${id}`);
    for (const rel of files) {
      const { buffer } = await sources.fetchFile(cache, id, rel);
      const out = safeJoin(dest, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buffer); // binary-safe
      if (rel.startsWith('scripts/') || /\.(sh|bash|py|js|ts|rb|pl)$/.test(rel)) executables.push(rel);
    }
  } else {
    const { buffer } = await sources.fetchSkill(cache, id);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), buffer);
  }
  return executables;
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
async function isUnedited(cache, id, dest, revision) {
  if (!isGh(id) || !revision || revision === 'unknown') return false;
  try {
    const atRev = (await sources.listGhFilesAt(cache, id, revision)).sort();
    const local = localFiles(dest).sort();
    if (atRev.length !== local.length || atRev.some((f, i) => f !== local[i])) return false;
    for (const rel of atRev) {
      const { buffer } = await sources.fetchFileAt(cache, id, rel, revision);
      if (!buffer.equals(fs.readFileSync(path.join(dest, rel)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// save(cache, id, root) → { dest, revision, executables, action }
// action: 'saved' (new) | 'updated' (unedited copy replaced with the new).
// An edited copy — or one that can't be verified — is a conflict: refuse.
async function save(cache, id, root) {
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
    if (await isUnedited(cache, id, dest, prior.revision)) {
      // no conflict — always replace with the new
      fs.rmSync(dest, { recursive: true, force: true });
      const r = await save(cache, id, root);
      return { ...r, action: 'updated' };
    }
    throw new Error(
      `conflict: .atskills/${diskPath(id)} already exists (saved from ${prior.id}, ${prior.taken}) and was edited — ` +
        `your copy stays untouched. To address it:\n` +
        `  · keep yours — do nothing\n` +
        `  · refetch upstream — delete the folder, then :save again (git keeps your history)\n` +
        `  · merge — ask your agent to diff and merge; rev:${prior.revision} is the base`
    );
  }

  const tmp = dest + '.saving';
  fs.rmSync(tmp, { recursive: true, force: true });
  const executables = await downloadTo(cache, id, tmp);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmp, dest);

  const revision = await sources.headRevision(cache, id);
  writeSource(dest, id, revision);

  return { dest, revision, executables, action: 'saved' };
}

module.exports = { save, readSource };
