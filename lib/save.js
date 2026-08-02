'use strict';
// Save = adapt + detach. The copy lands at the ID's own path (vendoring:
// same-org skills nest together, and the copy answers its own address), with
// one two-line .source at the top of whatever was saved:
//
//   gh:stripe/agent-toolkit
//   2026-08-01 rev:abc123
//
// Line 2 is a birth certificate, written once. There is no update lifecycle;
// saving the same path again is the only refresh, and only on the user's ask.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diskPath, isGh } = require('./ids');
const { safeJoin } = require('./fsx');
const sources = require('./sources');

// Digest of a saved tree (excluding dotfiles) — lets save-again tell an
// unedited copy (replace silently) from an adapted one (never overwrite).
function treeDigest(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const p = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(p, r);
      else {
        hash.update(r + '\0');
        hash.update(fs.readFileSync(p));
        hash.update('\0');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex').slice(0, 16);
}

function readSource(dest) {
  const f = path.join(dest, '.source');
  if (!fs.existsSync(f)) return null;
  const [id, line2 = '', digestLine = ''] = fs.readFileSync(f, 'utf8').trim().split('\n');
  const m = /^(\S+)\s+rev:(\S+)$/.exec(line2.trim());
  const d = /^digest:(\S+)$/.exec(digestLine.trim());
  return { id: id.trim(), taken: m ? m[1] : line2.trim(), revision: m ? m[2] : null, digest: d ? d[1] : null };
}

function writeSource(dest, id, revision, digest) {
  const today = new Date().toISOString().slice(0, 10);
  // Two lines are the protocol; the digest line is this implementation's own
  // note-to-self for save-again edit detection. Extra lines are ignored.
  fs.writeFileSync(path.join(dest, '.source'), `${id}\n${today} rev:${revision}\ndigest:${digest}\n`);
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

// save(cache, id, root) → { dest, revision, executables, action }
// action: 'saved' | 'updated' (was pristine) — an edited copy throws EDITED
// with the staged fresh copy's path, so the caller (or an agent) can merge.
async function save(cache, id, root) {
  const dest = safeJoin(root, diskPath(id));
  const prior = readSource(dest);

  if (fs.existsSync(dest) && !prior) {
    throw new Error(
      `.atskills/${diskPath(id)} already exists and has no .source — it's the project's own work; refusing to overwrite`
    );
  }

  if (prior) {
    const edited = prior.digest && treeDigest(dest) !== prior.digest;
    if (edited) {
      // Never overwrite an adaptation. Stage the fresh copy under the
      // dot-dir .upstream/ (dotfiles are metadata — never walked as skills)
      // and hand the merge to the user/agent; line 2's revision is the base.
      const staging = safeJoin(root, path.join('.upstream', diskPath(id)));
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(staging), { recursive: true });
      const executables = await downloadTo(cache, id, staging);
      const err = new Error(
        `your copy is adapted (since ${prior.taken} rev:${prior.revision}). ` +
        `Fresh upstream staged at ${staging} — diff, merge what you want, delete the staging dir.`
      );
      err.code = 'EDITED';
      err.staging = staging;
      err.executables = executables;
      throw err;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const tmp = dest + '.saving';
  fs.rmSync(tmp, { recursive: true, force: true });
  const executables = await downloadTo(cache, id, tmp);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmp, dest);

  const revision = await sources.headRevision(cache, id);
  writeSource(dest, id, revision, treeDigest(dest));

  return { dest, revision, executables, action: prior ? 'updated' : 'saved' };
}

module.exports = { save, readSource, treeDigest };
