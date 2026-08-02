'use strict';
// Skill IDs. `owner/path` is a hub name; `gh:owner/repo/path` is a GitHub
// address. One ID, one spelling — on disk, `gh:` is spelled `gh/` because
// folder names can't hold colons. All IDs are lowercase; resolvers fold case.

const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeId(raw) {
  const id = String(raw).trim().replace(/\/+$/, '').toLowerCase();
  if (!id) throw new Error('empty skill path');
  const body = id.startsWith('gh:') ? id.slice(3) : id;
  const segments = body.split('/');
  if (id.startsWith('gh:') && segments.length < 2) {
    throw new Error(`gh: paths need at least owner/repo: ${raw}`);
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !ID_SEGMENT.test(seg)) {
      throw new Error(`invalid path segment "${seg}" in ${raw}`);
    }
  }
  return id;
}

function isGh(id) {
  return id.startsWith('gh:');
}

// The on-disk spelling of an ID, always relative, never escaping the root.
function diskPath(id) {
  return id.replace(/^gh:/, 'gh/');
}

function ghParts(id) {
  const [owner, repo, ...rest] = id.slice(3).split('/');
  return { owner, repo, sub: rest.join('/') };
}

// `@skills:<path>[:save][:install]` — the path is greedy until trailing suffixes.
function parseReference(raw) {
  let rest = String(raw).replace(/^@?skills:/, '');
  const suffixes = { save: false, install: false };
  for (;;) {
    if (rest.endsWith(':save')) { suffixes.save = true; rest = rest.slice(0, -5); continue; }
    if (rest.endsWith(':install')) { suffixes.install = true; rest = rest.slice(0, -8); continue; }
    break;
  }
  return { id: normalizeId(rest), wholeDir: /\/\s*$/.test(raw.replace(/(:save|:install)+$/, '')), ...suffixes };
}

module.exports = { normalizeId, isGh, diskPath, ghParts, parseReference };
