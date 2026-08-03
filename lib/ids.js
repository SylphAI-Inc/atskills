'use strict';
// Skill IDs. `owner/path` is a hub name; `gh:owner/repo/path` is a GitHub
// address. One ID, one spelling — on disk, `gh:` is spelled `gh/` because
// folder names can't hold colons. Hub IDs are lowercase; `gh:` paths keep
// GitHub's casing, which is significant there.

// ── Two spellings of one address ────────────────────────────────────────────
//
// CANONICAL — what normalizeId returns, and what git, the trees API and the
// filesystem use: the TRUE path, decoded. `gh:owner/repo/skills/API Gateway`.
//
// REFERENCE — what a person types and what a copy button emits: the same
// address with the two characters the reference grammar would misread
// percent-encoded. A space, because `@skills:<path> <prompt>` is
// whitespace-delimited; and `:`, because it marks the `:save`/`:install`
// suffixes. `gh:owner/repo/skills/API%20Gateway`.
//
// If GitHub can serve the path, the protocol accepts it — the encoding exists
// so the grammar never has to reject a real directory name. Decoding on the
// way in is also what makes a pasted GitHub URL work: those already carry
// `%20`, and without it the segment stayed literally `API%20Gateway`, which
// the old grammar accepted and no repository could answer. A silently broken
// reference is worse than a refused one.

/** Percent-decode one segment; a stray '%' is a legal filename character. */
function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Canonical ID → reference spelling, safe to paste into a prompt.
 *
 * The `gh:` marker is part of the grammar, not of a segment, so it stays
 * literal — only colons and whitespace INSIDE a path segment are encoded.
 */
function referenceSpelling(id) {
  const text = String(id);
  const prefix = /^gh:/i.test(text) ? 'gh:' : '';
  return prefix + text
    .slice(prefix.length)
    .split('/')
    .map((seg) => seg.replace(/[\s:]/g, (ch) => (ch === ':' ? '%3A' : encodeURIComponent(ch))))
    .join('/');
}

// Only what cannot denote a directory is refused: the separators, the
// traversal tokens, and control characters. Everything a real directory name
// may hold is allowed — spaces, `@`, `_`, `(`, non-ASCII, a leading dot.
//
// The allowlist this replaced (`[A-Za-z0-9._-]`, alphanumeric first char)
// blocked 6,776 of 56,825 published skills: everything under `.claude/`,
// `.agents/`, `.gemini/`, `.kiro/` and `.atskills/` — this protocol's own
// directory — plus `_official`, `@scope`, Chinese names and `API Gateway`.
//
// Written as explicit checks rather than a regex: a character class of
// control-code escapes is easy to corrupt in transit and hard to review.
function badSegment(seg) {
  if (seg === '' || seg === '.' || seg === '..') return true;
  if (seg.includes('/') || seg.includes('\\')) return true;
  for (let i = 0; i < seg.length; i++) {
    const code = seg.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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

// Accept pasted GitHub URLs:
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
    // GitHub paths are case-sensitive — preserve the path's casing;
    // only the gh: marker itself folds.
    id = 'gh:' + id.slice(3);
    // Decode to the canonical form: `%20` back to a space, so what we hand git
    // is the directory that actually exists.
    const segments = id.slice(3).split('/').map(decodeSegment);
    if (segments.length < 2) throw new Error(`gh: paths need at least owner/repo: ${raw}`);
    for (const seg of segments) {
      if (badSegment(seg)) throw new Error(`invalid path segment "${seg}" in ${raw}`);
    }
    return 'gh:' + segments.join('/');
  }

  const segments = id.toLowerCase().split('/').map(decodeSegment);
  for (const seg of segments) {
    if (badSegment(seg)) throw new Error(`invalid path segment "${seg}" in ${raw}`);
  }
  return segments.join('/');
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

// `@skills:<path>[:save][:install]` — the path is greedy until trailing
// suffixes. Suffixes are stripped from the REFERENCE spelling, before
// decoding, so a literal ':' inside a directory name (written `%3A`) is never
// mistaken for one.
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

module.exports = {
  normalizeId,
  isGh,
  diskPath,
  ghParts,
  parseReference,
  referenceSpelling,
  MAX_COLLECTION_SKILLS,
};
