'use strict';
// Skill IDs. `owner/path` is a hub name; `gh:owner/repo/path` is a GitHub
// address. One ID, one spelling — on disk, `gh:` is spelled `gh/` because
// folder names can't hold colons. All IDs are lowercase; resolvers fold case.

const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The most skills one reference may resolve to.
//
// A path naming hundreds of skills is not a collection anyone curated — it is
// a repo root. Resolving one costs a fetch per skill and yields an index that
// can exceed the context window by itself (a real 6,296-skill catalog indexes
// at ~455k tokens). 128 is the manifest ceiling the largest catalog in the
// ecosystem already enforces on itself, so a bundle usable there is usable
// here.
//
// Enforced BEFORE any body is fetched: the tree listing is one request, and
// the count comes out of it.
const MAX_COLLECTION_SKILLS = 128;

// Accept pasted GitHub URLs, exactly like adal's @workflow resolver:
// github.com/owner/repo[/tree/<branch>|/blob/<branch>]/path → gh:owner/repo/path
// (the tree/blob + branch segments are spliced out; a trailing SKILL.md drops).
function fromGithubUrl(raw) {
  if (!raw.includes('github.com/')) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg.length > 3 && (seg[2] === 'tree' || seg[2] === 'blob')) seg.splice(2, 2);
    if (seg[seg.length - 1] === 'SKILL.md') seg.pop();
    return seg.length >= 2 ? 'gh:' + seg.join('/') : null;
  } catch {
    return null;
  }
}

function normalizeId(raw) {
  let id = String(raw).trim().replace(/\/+$/, '');
  if (!id) throw new Error('empty skill path');
  const fromUrl = fromGithubUrl(id);
  if (fromUrl) id = fromUrl;

  // gh/ is the DISK spelling of gh: — fold it back so a vendored path works
  // as a reference even when no local folder answers it (local resolution
  // converts to gh/ again via diskPath, so local behavior is unchanged).
  if (/^gh\//i.test(id)) id = 'gh:' + id.slice(3);

  if (/^gh:/i.test(id)) {
    // GitHub paths are case-sensitive — preserve the path's casing (matches
    // adal's @workflow behavior); only the gh: marker itself folds.
    id = 'gh:' + id.slice(3);
    const segments = id.slice(3).split('/');
    if (segments.length < 2) throw new Error(`gh: paths need at least owner/repo: ${raw}`);
    for (const seg of segments) {
      if (seg === '.' || seg === '..' || !GH_SEGMENT.test(seg)) {
        throw new Error(`invalid path segment "${seg}" in ${raw}`);
      }
    }
    return id;
  }

  id = id.toLowerCase();
  for (const seg of id.split('/')) {
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

module.exports = { normalizeId, isGh, diskPath, ghParts, parseReference, MAX_COLLECTION_SKILLS };
