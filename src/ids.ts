/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Skill IDs — the address half of the @skills protocol.
 *
 * THE PREFIX DECIDES. A bare path is the project's own (`.atskills/<path>`)
 * and never reaches the network; `hub:owner/name` is the hub; and
 * `gh:owner/repo/path` is GitHub. Resolution therefore never guesses, and a
 * reference cannot change meaning because a folder appeared or vanished.
 *
 * One ID, one spelling — on disk the markers are spelled `hub/` and `gh/`,
 * because folder names can't hold colons. Hub IDs are lowercase (resolvers
 * fold case); `gh:` paths keep GitHub's casing, which is significant there.
 */

/**
 * Two spellings of one address.
 *
 * CANONICAL — what `normalizeId` returns, and what git and the filesystem use:
 * the TRUE path, decoded (`gh:owner/repo/skills/API Gateway`).
 *
 * REFERENCE — what a person types and what a copy button emits: the same
 * address with the two characters the reference grammar would misread
 * percent-encoded. A space, because `@skills:<path> <prompt>` is
 * whitespace-delimited; and `:`, because it marks the `:save`/`:install`
 * suffixes (`gh:owner/repo/skills/API%20Gateway`).
 *
 * If GitHub can serve the path, the protocol accepts it — the encoding exists
 * so the grammar never has to reject a real directory name. The allowlist this
 * replaced (`[A-Za-z0-9._-]`, alphanumeric first char) blocked 6,776 of 56,825
 * published skills: everything under `.claude/`, `.agents/`, `.gemini/`,
 * `.kiro/` and `.atskills/` — this protocol's own directory — plus
 * `_official`, `@scope`, Chinese names and `API Gateway`.
 *
 * Protocol: atskills PROTOCOL.md §8.2.1 (source of truth — change it there).
 */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // a stray '%' is a legal filename character, not an escape
  }
}

/**
 * Canonical ID → reference spelling, safe to paste into a prompt. The `gh:`
 * marker is grammar, not a segment, so it stays literal.
 */
export function referenceSpelling(id: string): string {
  const text = String(id);
  const prefix = /^gh:/i.test(text) ? GH_PREFIX : /^hub:/i.test(text) ? HUB_PREFIX : '';
  return (
    prefix +
    text
      .slice(prefix.length)
      .split('/')
      .map((seg) => seg.replace(/[\s:]/g, (ch) => (ch === ':' ? '%3A' : encodeURIComponent(ch))))
      .join('/')
  );
}

/**
 * Only what cannot denote a directory is refused: the separators, the
 * traversal tokens, and control characters. Written as explicit checks rather
 * than a regex — a character class of control-code escapes is easy to corrupt
 * in transit and hard to review.
 */
function badSegment(seg: string): boolean {
  if (seg === '' || seg === '.' || seg === '..') return true;
  if (seg.includes('/') || seg.includes('\\')) return true;
  for (let i = 0; i < seg.length; i++) {
    const code = seg.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const GH_PREFIX = 'gh:';
export const HUB_PREFIX = 'hub:';
export const SKILLS_DIR = '.atskills';

/** Every marker that means "not local". A bare path is the project's own. */
const CLOUD_PREFIXES = [GH_PREFIX, HUB_PREFIX];

/** True when the ID names the cloud — i.e. it carries a marker. */
export function isCloud(id: string): boolean {
  return CLOUD_PREFIXES.some((p) => id.startsWith(p));
}

/** True when the ID is the project's own: no marker, so never a fetch. */
export function isLocalOnly(id: string): boolean {
  return !isCloud(id);
}

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
 * Accept pasted GitHub URLs, exactly like the old @workflow resolver did:
 * `github.com/owner/repo[/tree/<branch>|/blob/<branch>]/path` → `gh:owner/repo/path`
 * (the tree/blob + branch pair is spliced out; a trailing SKILL.md drops).
 */
export function fromGithubUrl(raw: string): string | null {
  // Strip a `gh:` / `gh/` marker before looking for a URL. People paste the
  // whole browser address after the prefix (`gh:https://github.com/o/r`), and
  // without this the URL parser read `gh:` as the SCHEME and the rest as a
  // path — yielding `gh:https:/github.com/o/r`, a "valid" id pointing at a
  // repo named `https:`. It failed by producing garbage rather than by
  // returning null, so nothing caught it.
  const withoutPrefix = raw.replace(/^\s*gh[:/]/i, '').trim();
  if (!withoutPrefix.includes('github.com/')) return null;

  try {
    const url = new URL(
      withoutPrefix.startsWith('http') ? withoutPrefix : `https://${withoutPrefix}`,
    );

    // Check the HOST, not the string. `github.com/` appears in
    // `evil-github.com/` and `github.com.attacker.net/`, both of which used to
    // normalize into a `gh:` id that git would then clone from the real
    // GitHub under an attacker-chosen owner/repo.
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;

    const seg = url.pathname.split('/').filter(Boolean);
    // `/tree/<ref>/` and `/blob/<ref>/` are viewer chrome, not path.
    if (seg.length > 3 && (seg[2] === 'tree' || seg[2] === 'blob')) seg.splice(2, 2);
    // A clone URL names the repo `<repo>.git`; the skill path does not.
    if (seg.length >= 2) seg[1] = seg[1].replace(/\.git$/i, '');
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
    // Decode to the canonical form — `%20` back to a space — so what reaches
    // git is the directory that actually exists. Decode BEFORE validating, or
    // an encoded separator (`%2F`) would smuggle a path apart.
    const segments = id.slice(3).split('/').map(decodeSegment);
    if (segments.length < 2) throw new Error(`gh: paths need at least owner/repo: ${raw}`);
    for (const seg of segments) {
      if (badSegment(seg)) throw new Error(`invalid path segment "${seg}" in ${raw}`);
    }
    return GH_PREFIX + segments.join('/');
  }

  // `hub/` is the DISK spelling of `hub:` — fold it back, so a vendored hub
  // skill works as a reference even when no local folder answers it.
  if (/^hub\//i.test(id)) id = HUB_PREFIX + id.slice(4);

  if (/^hub:/i.test(id)) {
    // Hub IDs are lowercase throughout; the marker folds with the rest.
    const segments = id.slice(4).toLowerCase().split('/').map(decodeSegment);
    if (segments.length !== 2) {
      throw new Error(`hub: paths are exactly owner/name: ${raw}`);
    }
    for (const seg of segments) {
      if (badSegment(seg)) throw new Error(`invalid path segment "${seg}" in ${raw}`);
    }
    return HUB_PREFIX + segments.join('/');
  }

  const segments = id.toLowerCase().split('/').map(decodeSegment);
  for (const seg of segments) {
    if (badSegment(seg)) throw new Error(`invalid path segment "${seg}" in ${raw}`);
  }
  return segments.join('/');
}

export function isGh(id: string): boolean {
  return id.startsWith(GH_PREFIX);
}

/** The on-disk spelling of an ID — always relative, never escaping the root. */
export function diskPath(id: string): string {
  return id.replace(/^gh:/, 'gh/').replace(/^hub:/, 'hub/');
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
  /** Legacy `@workflow:…:index` — frontmatter only. Undocumented, still honored. */
  index: boolean;
}

/**
 * `@skills:<path>[:save][:install]` — the path is greedy until the trailing
 * suffixes, which combine in any order. `@workflow:` is a silent alias for the
 * same grammar. Throws (via normalizeId) on an unusable path.
 */
export function parseReference(raw: string): SkillReference {
  let rest = String(raw).replace(/^@?(skills|workflow):/, '');
  const suffixes = { save: false, install: false, index: false };
  for (;;) {
    if (rest.endsWith(':save')) { suffixes.save = true; rest = rest.slice(0, -5); continue; }
    if (rest.endsWith(':install')) { suffixes.install = true; rest = rest.slice(0, -8); continue; }
    if (rest.endsWith(':index')) { suffixes.index = true; rest = rest.slice(0, -6); continue; }
    break;
  }
  const wholeDir = /\/\s*$/.test(rest);
  return { id: normalizeId(rest), wholeDir, ...suffixes };
}
