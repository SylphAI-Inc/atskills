/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Skill IDs — the address half of the @skills protocol.
 *
 * `owner/path` is a hub name; `gh:owner/repo/path` is a GitHub address. One ID,
 * one spelling — on disk `gh:` is spelled `gh/`, because folder names can't
 * hold colons. Hub IDs are lowercase (resolvers fold case); `gh:` paths keep
 * GitHub's casing, which is significant there.
 *
 * Ported from SylphAI-Inc/atskills lib/ids.js.
 */

const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const GH_PREFIX = 'gh:';
export const SKILLS_DIR = '.atskills';

/**
 * The most skills one reference may resolve to.
 *
 * A path that names hundreds of skills is not a collection anyone chose — it
 * is a repo root, and resolving it costs a full clone plus a menu that can
 * exceed the context window on its own (a 6,296-skill catalog lists at ~455k
 * tokens). 128 is not our number: it is the manifest ceiling the largest
 * catalog in the ecosystem (AAS / agentic-awesome-skills) already enforces on
 * itself, so a bundle usable there is usable here.
 *
 * Enforced BEFORE any download — the tree is counted from git's index, so an
 * oversized reference costs a tree listing, not a transfer.
 */
export const MAX_COLLECTION_SKILLS = 128;
export const AUTOTRIGGER_FILE = '.autotrigger';
export const SOURCE_FILE = '.source';

/**
 * Accept pasted GitHub URLs:
 * `github.com/owner/repo[/tree/<branch>|/blob/<branch>]/path` → `gh:owner/repo/path`
 * (the tree/blob + branch pair is spliced out; a trailing SKILL.md drops).
 */
export function fromGithubUrl(raw: string): string | null {
  if (!raw.includes('github.com/')) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg.length > 3 && (seg[2] === 'tree' || seg[2] === 'blob')) seg.splice(2, 2);
    if (seg[seg.length - 1] === 'SKILL.md') seg.pop();
    return seg.length >= 2 ? GH_PREFIX + seg.join('/') : null;
  } catch {
    return null;
  }
}

/**
 * Normalize any accepted spelling to the canonical ID. Throws on an empty
 * path, a `gh:` address shorter than owner/repo, or any segment that could
 * escape the skills tree.
 */
export function normalizeId(raw: string): string {
  let id = String(raw).trim().replace(/\/+$/, '');
  if (!id) throw new Error('empty skill path');
  if (id.includes('\\')) throw new Error(`invalid skill path: ${raw}`);

  const fromUrl = fromGithubUrl(id);
  if (fromUrl) id = fromUrl;

  // `gh/` is the DISK spelling of `gh:` — fold it back, so a vendored path
  // works as a reference even when no local folder answers it. (Local
  // resolution spells it `gh/` again via diskPath, so behavior is unchanged.)
  if (/^gh\//i.test(id)) id = GH_PREFIX + id.slice(3);

  if (/^gh:/i.test(id)) {
    // Only the `gh:` marker folds; GitHub paths are case-sensitive.
    id = GH_PREFIX + id.slice(3);
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

export function isGh(id: string): boolean {
  return id.startsWith(GH_PREFIX);
}

/** The on-disk spelling of an ID — always relative, never escaping the root. */
export function diskPath(id: string): string {
  return id.replace(/^gh:/, 'gh/');
}

/**
 * The human review page for a `gh:` ID — where a person reads a cloud skill
 * before trusting it. Cloud badges carry this so reviewing is one click, not
 * a URL you have to reconstruct. Null for anything not hosted on GitHub.
 */
export function webUrl(id: string): string | null {
  if (!isGh(id)) return null;
  const { owner, repo, sub } = ghParts(id);
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}${sub ? `/tree/HEAD/${sub}` : ''}`;
}

export function ghParts(id: string): { owner: string; repo: string; sub: string } {
  const [owner, repo, ...rest] = id.slice(3).split('/');
  return { owner: owner ?? '', repo: repo ?? '', sub: rest.join('/') };
}

export interface SkillReference {
  id: string;
  /** Trailing `/` on the typed path — "the whole directory". */
  wholeDir: boolean;
  save: boolean;
  install: boolean;
}

/**
 * `@skills:<path>[:save][:install]` — the path is greedy until the trailing
 * suffixes, which combine in any order. Throws (via normalizeId) on an
 * unusable path.
 */
export function parseReference(raw: string): SkillReference {
  let rest = String(raw).replace(/^@?skills:/, '');
  const suffixes = { save: false, install: false };
  for (;;) {
    if (rest.endsWith(':save')) { suffixes.save = true; rest = rest.slice(0, -5); continue; }
    if (rest.endsWith(':install')) { suffixes.install = true; rest = rest.slice(0, -8); continue; }
    break;
  }
  const wholeDir = /\/\s*$/.test(rest);
  return { id: normalizeId(rest), wholeDir, ...suffixes };
}
