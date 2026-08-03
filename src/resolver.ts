/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Skill resolver — the `@skills:` half of the protocol.
 *
 * The whole rule is **local first, by path**: a folder at `.atskills/<path>`
 * (`gh:` spelled `gh/`) is the project's own and always answers; no folder
 * there means the path means the cloud. `.source` is NEVER consulted to
 * resolve anything — a saved copy answers its own address because it sits at
 * the ID's own path (vendoring), not because a manifest says so.
 *
 * A directory with no SKILL.md is not a failure — it's a menu: one row per
 * skill under it, each row a valid path the agent can read on demand.
 *
 * Spec: PROTOCOL.md §1–§4; agent form: SKILLS.md.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LoadResponse, Logger, OriginInfo, SkillMenuEntry } from './types.js';
import {
  GH_PREFIX,
  MAX_COLLECTION_SKILLS,
  SKILLS_DIR,
  diskPath,
  ghParts,
  isGh,
  normalizeId,
  webUrl,
} from './ids.js';
import {
  bundleEntries,
  copyDirSync,
  frontmatter,
  leafSkillDirs,
  listFiles,
  nearestSource,
  safeJoin,
  walkSkills,
  writeSource,
} from './fsx.js';
import { addTriggerLine, installLineFor } from './autotrigger.js';

export type { LoadResponse } from './types.js';

export interface SkillResolverOpts {
  /** Project root — `.atskills/` lives here. */
  workingDir: string;
  /**
   * Global validating cache root for cloud fetches. Defaults to
   * `~/.atskills/cache` — the protocol's shared location, agent-neutral: any
   * atskills implementation on the machine reads and writes the same tree
   * (`<cacheDir>/<disk path>` bodies, revision stamps under `.meta/`).
   * Entries are always safe to delete; the path re-resolves.
   */
  cacheDir?: string;
  /** Hub/registry base URL for non-`gh:` IDs. */
  registryBaseUrl?: string;
  /**
   * Base URL that `gh:owner/repo` remotes resolve under. Defaults to
   * `https://github.com`; tests point it at local repos (`file://…`), and it
   * is the seam for GitHub Enterprise hosts.
   */
  githubBaseUrl?: string;
  /** Injected log sink; the package never assumes a host logger. */
  log?: Logger;
}

const GITHUB_GIT_BASE = 'https://github.com';

/** The protocol's global cache — one tree per machine, shared by every agent. */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.atskills', 'cache');

/**
 * Hub entries have no revision probe (unlike git's ls-remote), so a cached
 * copy this fresh answers without a network round-trip.
 */
const HUB_CACHE_TTL_MS = 15 * 60 * 1000;

/** `.atskills/` for a project root. */
export function skillsRoot(workingDir: string): string {
  return path.join(workingDir, SKILLS_DIR);
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a reference. `save` copies the skill into `.atskills/<id>/` with a
 * `.source` stamp; without it the resolution is a read (cloud results land in
 * the global cache, which is always safe to delete).
 *
 * `install` appends the skill's line to `.atskills/.autotrigger` — the `@`
 * cloud form on its own, the plain vendored path when a saved copy answers
 * the ID. It implies nothing about saving: the two suffixes are orthogonal.
 */
export async function resolveSkill(
  id: string,
  save: boolean,
  opts: SkillResolverOpts,
  install = false,
): Promise<LoadResponse> {
  let skillId: string;
  try {
    skillId = normalizeId(id);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  const root = skillsRoot(opts.workingDir);

  // ── Local first, by path ──
  const local = resolveLocal(skillId, root);
  let result: LoadResponse;
  if (save) {
    // Already the project's own? Then this is the save-again question, and
    // saveSkillToProject is the one place that answers it.
    result = await saveSkillToProject(skillId, opts);
  } else if (local) {
    result = local;
  } else {
    // ── Cloud, through the global validating cache ──
    try {
      result = await readThroughCache(skillId, opts.cacheDir ?? DEFAULT_CACHE_DIR, opts);
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (install && result.success) {
    try {
      const line = installLineFor(root, skillId);
      addTriggerLine(root, line);
      opts.log?.info(`[skills] install '${skillId}' → ${SKILLS_DIR}/.autotrigger line '${line}'`);
    } catch (e) {
      return { ...result, warning: `Resolved '${skillId}' but could not write ${SKILLS_DIR}/.autotrigger: ${e}` };
    }
  }
  return result;
}

/** Local resolution only — used by the resolver and by `/skills` listings. */
export function resolveLocal(skillId: string, root: string): LoadResponse | null {
  let dir: string;
  try {
    dir = safeJoin(root, diskPath(skillId));
  } catch {
    return null;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  const skillFile = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    return {
      success: true,
      kind: 'skill',
      id: skillId,
      path: skillFile,
      dir,
      content: fs.readFileSync(skillFile, 'utf-8'),
      files: listFiles(dir),
      source: 'local',
    };
  }

  try {
    assertMenuFits(skillId, dir);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  const entries = menuEntriesFrom(dir, skillId);
  if (entries.length === 0) return null; // an empty folder is not a skill — try the cloud
  return { success: true, kind: 'menu', dir, entries, source: 'local', id: skillId };
}

/** Build menu rows for every skill under a materialized directory. */
function menuEntriesFrom(dir: string, baseId: string): SkillMenuEntry[] {
  const entries: SkillMenuEntry[] = [];
  for (const s of walkSkills(dir)) {
    const file = path.join(s.dir, 'SKILL.md');
    // The cache is shared: another session may swap this entry between the
    // walk and the read. A vanished row is skipped, never a menu-wide error.
    let fm;
    try {
      fm = frontmatter(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const entryId = s.rel ? `${baseId}/${s.rel}` : baseId;
    entries.push({
      id: entryId,
      name: fm.name ?? entryId.split('/').pop() ?? entryId,
      description: fm.description ?? '(no description)',
      path: file,
      bundle: bundleEntries(s.dir),
    });
  }
  return entries;
}

// ─── Cloud fetch ─────────────────────────────────────────────────────────────

/**
 * Materialize an ID under `destRoot/<disk path>` and describe what landed:
 * a skill when SKILL.md is at the path, a menu when it is a directory of
 * skills. Throws with the reason when neither is reachable.
 */
async function fetchToDir(
  skillId: string,
  destRoot: string,
  opts: SkillResolverOpts,
  source: 'cache' | 'local',
  ref?: string,
): Promise<LoadResponse> {
  const dest = safeJoin(destRoot, diskPath(skillId));

  if (isGh(skillId)) {
    const ok = await downloadGithub(skillId, dest, opts, ref);
    if (!ok) throw new Error(`Nothing at ${skillId}${ref ? ` at rev ${ref}` : ''}`);
  } else {
    await downloadRegistry(skillId, dest, opts);
  }

  return describeMaterialized(skillId, dest, source);
}

/**
 * Describe what sits at `dest` — a skill when SKILL.md is at the path, a menu
 * when it is a directory of skills. Throws when neither is readable. Serving
 * a cache hit and describing a fresh download are the same act, so both go
 * through here.
 */
function describeMaterialized(
  skillId: string,
  dest: string,
  source: 'cache' | 'local',
): LoadResponse {
  const origin = isGh(skillId)
    ? ({ type: 'github', githubRepo: ghRepoOf(skillId), githubPath: ghParts(skillId).sub } as OriginInfo)
    : ({ type: 'marketplace', slug: skillId } as OriginInfo);

  // A cloud read carries its review page; a local copy does not — that is
  // project code, read in the editor.
  const review = source === 'local' ? {} : { reviewUrl: webUrl(skillId) ?? undefined };

  const skillFile = path.join(dest, 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    return {
      success: true,
      kind: 'skill',
      id: skillId,
      path: skillFile,
      dir: dest,
      content: fs.readFileSync(skillFile, 'utf-8'),
      files: listFiles(dest),
      source: source === 'local' ? 'local' : isGh(skillId) ? 'github' : 'platform',
      origin,
      ...review,
    };
  }

  assertMenuFits(skillId, dest);
  const entries = menuEntriesFrom(dest, skillId);
  if (entries.length === 0) throw new Error(`Nothing at ${skillId}: no SKILL.md and no skills under it`);
  return {
    success: true,
    kind: 'menu',
    id: skillId,
    dir: dest,
    entries,
    source: source === 'local' ? 'local' : 'github',
    origin,
    ...review,
  };
}

// ─── The global validating cache ─────────────────────────────────────────────
//
// Browser semantics over git: every cloud read asks the source "did this
// change?" (`ls-remote HEAD` — one sha, no clone). Unchanged serves the cache
// instantly, changed downloads fresh, unreachable serves the cache with a
// stale warning. Bodies live at `<cacheDir>/<disk path>` — the same
// human-readable tree the reference implementation uses, so every agent on
// the machine shares one cache — and the revision stamps live under `.meta/`,
// out of any listing's way.

interface CacheMeta {
  id: string;
  revision: string;
  fetchedAt: string;
}

function cacheMetaPath(cacheRoot: string, skillId: string): string {
  const hash = crypto.createHash('sha256').update(skillId).digest('hex').slice(0, 32);
  return path.join(cacheRoot, '.meta', `${hash}.json`);
}

function readCacheMeta(cacheRoot: string, skillId: string): CacheMeta | null {
  try {
    return JSON.parse(fs.readFileSync(cacheMetaPath(cacheRoot, skillId), 'utf-8')) as CacheMeta;
  } catch {
    return null;
  }
}

function writeCacheMeta(cacheRoot: string, skillId: string, revision: string): void {
  const file = cacheMetaPath(cacheRoot, skillId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: skillId, revision, fetchedAt: new Date().toISOString() }, null, 2));
}

/** Read a cloud ID through the cache: validate, serve, or refresh. */
async function readThroughCache(
  skillId: string,
  cacheRoot: string,
  opts: SkillResolverOpts,
): Promise<LoadResponse> {
  const dest = safeJoin(cacheRoot, diskPath(skillId));
  const meta = readCacheMeta(cacheRoot, skillId);
  const hasBody = meta !== null && fs.existsSync(dest);

  const serveCached = (warning?: string): LoadResponse | null => {
    try {
      const described = describeMaterialized(skillId, dest, 'cache');
      return warning ? { ...described, warning } : described;
    } catch (e) {
      // An oversized cached tree is a REAL answer, not a corrupt entry — a
      // fresh clone would only re-derive the same refusal (and offline it
      // would mask it behind a network error).
      if (e instanceof SkillCollectionTooLargeError) throw e;
      return null; // corrupt/emptied entry — fall through to a fresh download
    }
  };
  const staleWarning = () =>
    `could not reach upstream for ${skillId} — serving the cached copy from ${meta?.fetchedAt} (may be stale)`;

  if (isGh(skillId)) {
    // One sha answers "did it change?" — 'unknown' means unreachable.
    const revision = await headRevision(skillId, opts);
    if (hasBody) {
      if (revision !== 'unknown' && revision === meta?.revision) {
        const hit = serveCached();
        if (hit) return hit;
      }
      if (revision === 'unknown') {
        const stale = serveCached(staleWarning());
        if (stale) return stale;
      }
    }
    try {
      const fresh = await fetchToDir(skillId, cacheRoot, opts, 'cache');
      writeCacheMeta(cacheRoot, skillId, revision);
      return fresh;
    } catch (e) {
      // Upstream moved but the refresh failed mid-flight — the cached copy
      // still beats an error.
      if (hasBody) {
        const stale = serveCached(staleWarning());
        if (stale) return stale;
      }
      throw e;
    }
  }

  // Hub IDs have no cheap change probe, so freshness is time-based: within
  // the TTL the cache answers outright (a session start plus its mutations
  // cost ONE registry round-trip, not one per operation); past it, fetch
  // fresh and fall back to the cached copy only when the registry is
  // unreachable.
  if (hasBody && meta && Date.now() - Date.parse(meta.fetchedAt) < HUB_CACHE_TTL_MS) {
    const hit = serveCached();
    if (hit) return hit;
  }
  try {
    const fresh = await fetchToDir(skillId, cacheRoot, opts, 'cache');
    writeCacheMeta(cacheRoot, skillId, 'unknown');
    return fresh;
  } catch (e) {
    if (hasBody) {
      const stale = serveCached(staleWarning());
      if (stale) return stale;
    }
    throw e;
  }
}

function ghRepoOf(id: string): string {
  const { owner, repo } = ghParts(id);
  return `${owner}/${repo}`;
}

/**
 * Download a `gh:` path — with git, the way subtrees are meant to move: one
 * shallow, blob-filtered, (sparse) clone. No API quota (a REST route dies at
 * 60 unauthenticated requests/hour), one negotiated transfer, and private
 * repos work through the user's existing git credentials. git is REQUIRED
 * for cloud skills; a machine without it gets one clear error, not a slower
 * hand-rolled transfer.
 *
 * Only a SKILL.md at the path itself makes a skill. No other file is ever
 * treated as a skill body — not README.md, not a nested skill's SKILL.md —
 * so a repo root can never render as one phantom skill. Without one, the
 * path is a directory: its skill folders materialize at their true depth,
 * repo cruft (docs/, .github/, LICENSE) stays behind.
 */
async function downloadGithub(
  skillId: string,
  dest: string,
  opts: SkillResolverOpts,
  ref?: string,
): Promise<boolean> {
  const { owner, repo, sub } = ghParts(skillId);
  if (!owner || !repo) return false;
  if (!(await runGit(['--version']))) {
    throw new Error(`git is required to download ${skillId} — install git and retry`);
  }
  return downloadViaGit(owner, repo, sub, dest, ref, opts.githubBaseUrl ?? GITHUB_GIT_BASE);
}

/** Run one git command: no prompts, hard timeout, quiet. Resolves ok/failed. */
function runGit(args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: 'ignore',
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Run one git command and return its stdout, or null on any failure. */
function runGitOut(args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * One negotiated transfer: shallow + `--filter=blob:none` (+ sparse checkout
 * of the sub-path). A full 40-char `ref` pins that exact revision; anything
 * else clones the default branch. The clone lands in a temp dir and only a
 * successful materialization touches `dest`.
 */
async function downloadViaGit(
  owner: string,
  repo: string,
  sub: string,
  dest: string,
  ref: string | undefined,
  baseUrl: string,
): Promise<boolean> {
  const url = `${baseUrl}/${owner}/${repo}.git`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-skills-git-'));
  try {
    // Phase 1 — fetch the TREE only. `--no-checkout` keeps the working tree
    // empty, so `--filter=blob:none` actually holds: nothing lazily faults in
    // file contents. This is what lets an oversized reference be rejected for
    // the price of a listing instead of a clone.
    let treeish: string;
    if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
      if (!(await runGit(['init', '--quiet', tmp]))) return false;
      if (!(await runGit(['remote', 'add', 'origin', url], tmp))) return false;
      if (!(await runGit(['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', ref], tmp))) return false;
      treeish = 'FETCH_HEAD';
    } else {
      const branch = ref ? ['--branch', ref] : [];
      const args = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', ...branch, url, tmp];
      if (!(await runGit(args))) return false;
      treeish = 'HEAD';
    }

    // Phase 2 — count what the reference means, and refuse before paying.
    // `-l` carries each blob's size in the tree metadata, so the exact
    // download weight is known here too, still without fetching a byte.
    const listing = await runGitOut(['ls-tree', '-r', '-l', treeish], tmp);
    if (listing === null) return false;
    assertCollectionFits(parseTreeListing(listing), owner, repo, sub);

    // Phase 3 — only now materialize, narrowed to the sub-path.
    if (sub && !(await runGit(['sparse-checkout', 'set', '--no-cone', sub], tmp))) return false;
    if (!(await runGit(['checkout', '--quiet', treeish], tmp))) return false;

    const src = sub ? path.join(tmp, sub) : tmp;
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return false;
    materializeSubtree(src, dest);
    return true;
  } catch (e) {
    if (e instanceof SkillCollectionTooLargeError) throw e;
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A reference that names more skills than anyone meant to load. Carries the
 * count and the usable paths one level down, because "too big" without a next
 * step just strands the reader — the whole point is that the refusal names
 * the reference that would have worked.
 */
/**
 * The shallowest sub-paths that fit under the cap — the "you meant one of
 * these" list.
 *
 * Grouping one level down is not enough: in a real aggregator every top-level
 * child is itself oversized (`plugins/` 4,303, `skills/` 1,993), which would
 * leave a refusal with no next step. So descend until a node fits, and report
 * that node. On a catalog of ~10-skill bundles this surfaces the bundles,
 * which is exactly the unit their authors curated.
 *
 * Sorted biggest-first: the largest collection a reader can actually load is
 * the most useful thing to offer them.
 */
export function largestUsableCollections(skills: string[]): Array<{ rel: string; count: number }> {
  const out: Array<{ rel: string; count: number }> = [];

  const visit = (dirs: string[], prefix: string): void => {
    if (dirs.length <= MAX_COLLECTION_SKILLS) {
      if (prefix) out.push({ rel: prefix, count: dirs.length });
      return;
    }
    const groups = new Map<string, string[]>();
    for (const dir of dirs) {
      const rest = prefix ? dir.slice(prefix.length + 1) : dir;
      const head = rest.split('/')[0];
      if (!head) continue; // a skill AT this prefix cannot be split further
      const key = prefix ? `${prefix}/${head}` : head;
      const bucket = groups.get(key);
      if (bucket) bucket.push(dir);
      else groups.set(key, [dir]);
    }
    // No progress possible (nothing left to split on) — stop rather than recur.
    if (groups.size === 0) return;
    for (const [key, bucket] of groups) visit(bucket, key);
  };

  visit(skills, '');
  return out.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
}

export interface TreeEntry {
  path: string;
  /** Blob size in bytes. `-1` when git could not report one. */
  size: number;
}

/**
 * Parse `git ls-tree -r -l` — `<mode> <type> <sha> <size>\t<path>`. Under
 * `--filter=blob:none` the sizes still come through (they live in the tree
 * metadata, not the blob), which is what makes a pre-download weight possible.
 */
export function parseTreeListing(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(tab + 1).trim();
    if (!path) continue;
    const size = Number(line.slice(0, tab).trim().split(/\s+/)[3]);
    entries.push({ path, size: Number.isFinite(size) ? size : -1 });
  }
  return entries;
}

/** Bytes as a person reads them — the unit a download decision is made in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class SkillCollectionTooLargeError extends Error {
  constructor(
    readonly skillId: string,
    readonly count: number,
    readonly suggestions: Array<{ id: string; count: number }>,
    readonly bytes = -1,
  ) {
    const weight = bytes >= 0 ? `, ${formatBytes(bytes)}` : '';
    const head =
      `${skillId} holds ${count} skills${weight} — over the ${MAX_COLLECTION_SKILLS} a single reference may load. ` +
      `Reference a specific skill, or one of the collections inside it`;
    const list = suggestions.map((s) => `\n  ${s.id}  (${s.count})`).join('');
    super(list ? `${head}:${list}` : `${head}.`);
    this.name = 'SkillCollectionTooLargeError';
  }
}

/**
 * Enforce the cap against a repo file listing. A SKILL.md at the path itself
 * is one skill whose bundle may be any size — the cap counts skills, never
 * files, so a legitimately large single skill is never refused.
 */
function assertCollectionFits(
  entries: TreeEntry[],
  owner: string,
  repo: string,
  sub: string,
): void {
  const prefix = sub ? `${sub.replace(/\/+$/, '')}/` : '';
  const scoped: TreeEntry[] = [];
  for (const entry of entries) {
    if (prefix) {
      if (!entry.path.startsWith(prefix)) continue;
      scoped.push({ path: entry.path.slice(prefix.length), size: entry.size });
    } else {
      scoped.push(entry);
    }
  }

  const skills = leafSkillDirs(scoped.map((e) => e.path));
  // '' means SKILL.md sits at the path itself: one skill, not a collection.
  if (skills.length <= MAX_COLLECTION_SKILLS || skills.includes('')) return;

  const base = `${GH_PREFIX}${owner}/${repo}${sub ? `/${sub.replace(/\/+$/, '')}` : ''}`;
  const bytes = scoped.reduce((sum, e) => (e.size > 0 ? sum + e.size : sum), 0);
  throw new SkillCollectionTooLargeError(base, skills.length, collectionSuggestions(base, skills), bytes);
}

/**
 * The "you meant one of these" list for a refusal. Aggregator repos ship the
 * same catalog several times (one copy per target agent), so the raw list
 * offers `…/design-it` three times over and spends the whole suggestion
 * budget on duplicates. Keep the shortest path for each collection name —
 * same content, most canonical address — biggest first, top 6.
 */
function collectionSuggestions(base: string, skills: string[]): Array<{ id: string; count: number }> {
  const byName = new Map<string, { rel: string; count: number }>();
  for (const item of largestUsableCollections(skills)) {
    const name = item.rel.split('/').pop() as string;
    const seen = byName.get(name);
    if (!seen || item.rel.length < seen.rel.length) byName.set(name, item);
  }
  const ranked = [...byName.values()].sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
  // A flat oversized directory yields one singleton per skill, which would pad
  // the list with arbitrary picks (`…/s0`, `…/s1`, `…/s10`). Offer real
  // collections when any exist; fall back to individual skills only when there
  // is genuinely nothing larger to point at.
  const collections = ranked.filter((item) => item.count > 1);
  return (collections.length ? collections : ranked)
    .slice(0, 6)
    .map(({ rel, count }) => ({ id: `${base}/${rel}`, count }));
}

/**
 * The same cap, enforced on an already-materialized directory: a local tree
 * under `.atskills/`, or a cache entry written before the cap existed. The
 * pre-download check refuses the transfer; this one refuses the MENU — the
 * payload that actually enters the model's context.
 */
function assertMenuFits(skillId: string, dir: string): void {
  const rels = walkSkills(dir).map((s) => s.rel).filter(Boolean);
  if (rels.length <= MAX_COLLECTION_SKILLS) return;
  throw new SkillCollectionTooLargeError(skillId, rels.length, collectionSuggestions(skillId, rels));
}

/**
 * Move a cloned subtree into place. SKILL.md at the top → the whole tree is
 * that one skill's bundle. Otherwise it is a directory: each skill folder
 * (leaf rule — the first SKILL.md down any branch) is copied AT ITS RELATIVE
 * PATH, so `skills/cloud/aws` lands at `skills/cloud/aws`, never flattened,
 * and non-skill cruft never comes along. `.git` and symlinks never land.
 */
function materializeSubtree(src: string, dest: string): void {
  const copy = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, {
      recursive: true,
      filter: (p) => {
        if (path.basename(p) === '.git') return false;
        try {
          return !fs.lstatSync(p).isSymbolicLink();
        } catch {
          return true;
        }
      },
    });
  };

  // The cache is SHARED (one tree per machine, any number of sessions), so a
  // reader must never see a half-written skill. Build the new body next to
  // `dest` and swap in with two renames — the copy happens off to the side.
  const staging = stagingSiblingOf(dest);
  fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(path.join(src, 'SKILL.md'))) {
    copy(src, staging);
  } else {
    fs.mkdirSync(staging, { recursive: true });
    for (const s of walkSkills(src)) {
      if (!s.rel) continue;
      copy(s.dir, safeJoin(staging, s.rel));
    }
  }
  swapIntoPlace(staging, dest);
}

/**
 * A same-volume sibling path to build a new body in — a rename from here to
 * `dest` can never cross devices (os.tmpdir may; a sibling cannot).
 */
function stagingSiblingOf(dest: string): string {
  return `${dest}.new-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Replace `dest` with `staging` in two renames, so any concurrent reader sees
 * the old tree or the new one — never neither, never a mix. `staging` must
 * come from stagingSiblingOf(dest).
 */
function swapIntoPlace(staging: string, dest: string): void {
  const retired = `${dest}.old-${path.basename(staging).split('.new-')[1]}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    if (fs.existsSync(dest)) fs.renameSync(dest, retired);
    fs.renameSync(staging, dest);
  } finally {
    fs.rmSync(retired, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Is there a SKILL.md at exactly this path? The one question that decides. */
/** Resolve a hub/registry ID and materialize it at `dest`. */
async function downloadRegistry(skillId: string, dest: string, opts: SkillResolverOpts): Promise<void> {
  const base = opts.registryBaseUrl || 'https://adal.sylph.ai/api/workflows';
  let data: {
    entry?: { content?: string; github_skill_path?: string; github_repo?: string; github_path?: string };
  };
  try {
    const response = await fetch(`${base}/resolve/${skillId}`);
    if (response.status === 404) throw new Error(`Skill '${skillId}' not found in the registry`);
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status} for '${skillId}'`);
    data = (await response.json()) as typeof data;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  const entry = data?.entry ?? {};
  if (entry.content) {
    // Swap, never write in place: a previous resolution may have left a
    // different body (even a whole GitHub subtree) at this path.
    const staging = stagingSiblingOf(dest);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), entry.content, 'utf-8');
    swapIntoPlace(staging, dest);
    return;
  }
  if (entry.github_skill_path) {
    const ghId = entry.github_skill_path.startsWith(GH_PREFIX)
      ? normalizeId(entry.github_skill_path)
      : normalizeId(GH_PREFIX + entry.github_skill_path.replace(/^\/+/, ''));
    const ok = await downloadGithub(ghId, dest, opts);
    if (!ok) throw new Error(`SKILL.md not found at ${entry.github_skill_path}`);
    return;
  }
  throw new Error(`Skill '${skillId}' has no content and no GitHub path`);
}

// ─── Save ────────────────────────────────────────────────────────────────────

/**
 * Save = adapt + detach. The copy lands at the ID's own path under
 * `.atskills/` with one two-line `.source` at the top of what was saved.
 *
 * Save-again is answered by `.source` line 2, and nothing else: an UNEDITED
 * copy (still byte-identical to upstream at the recorded revision) is
 * replaced; an edited — or unverifiable — copy is a conflict, and a conflict
 * touches nothing and lists the ways out. No digests, no staging dirs, no
 * stored state beyond the two lines.
 */
export async function saveSkillToProject(
  id: string,
  opts: SkillResolverOpts,
): Promise<LoadResponse> {
  let skillId: string;
  try {
    skillId = normalizeId(id);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  const root = skillsRoot(opts.workingDir);
  const dest = safeJoin(root, diskPath(skillId));
  const rel = `${SKILLS_DIR}/${diskPath(skillId)}`;

  if (fs.existsSync(dest) && walkSkills(dest).length > 0) {
    const prior = nearestSource(dest, root);
    if (!prior) {
      return {
        success: false,
        error:
          `conflict: ${rel}/ already exists and has no .source — it is the project's own work, ` +
          `so nothing was touched. Rename your folder, or save under a different path.`,
      };
    }
    const unedited = await isUneditedSince(skillId, dest, prior.revision, opts);
    if (!unedited) {
      return {
        success: false,
        error:
          `conflict: ${rel}/ already exists (saved from ${prior.id}, ${prior.taken}) and was edited — ` +
          `your copy stays untouched. To address it:\n` +
          `  · keep yours — do nothing\n` +
          `  · refetch upstream — delete the folder, then save again (git keeps your history)\n` +
          `  · merge — ask the agent to diff and merge; rev:${prior.revision ?? 'unknown'} is the base`,
      };
    }
  }

  const revision = await headRevision(skillId, opts);
  // Download fully into a temp root FIRST, then swap into place — a failed
  // fetch can never destroy an existing copy.
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-skills-save-'));
  try {
    await fetchToDir(skillId, stagingRoot, opts, 'local', revision === 'unknown' ? undefined : revision);
    const staged = safeJoin(stagingRoot, diskPath(skillId));
    // Copy to a same-volume sibling, stamp it, then swap in two renames — an
    // interruption can never leave the user's git-tracked copy half-replaced
    // (or worse, stampless, which the conflict check would read as "the
    // project's own work" and refuse to ever overwrite again).
    const sibling = stagingSiblingOf(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyDirSync(staged, sibling);
    writeSource(sibling, skillId, revision);
    swapIntoPlace(sibling, dest);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  opts.log?.info(`[skills] saved '${skillId}' → ${rel}/ (rev ${revision})`);
  const local = resolveLocal(skillId, root);
  return local ?? { success: false, error: `Saved '${skillId}' but nothing readable landed at ${rel}/` };
}

/**
 * Is the copy untouched since it was saved? Verified against upstream AT the
 * recorded revision — nothing is stored beyond `.source`'s two lines. A hub
 * skill, or a stamp with no revision, is unverifiable and counts as edited:
 * refusing is the safe answer.
 */
async function isUneditedSince(
  skillId: string,
  dest: string,
  revision: string | null,
  opts: SkillResolverOpts,
): Promise<boolean> {
  if (!isGh(skillId) || !revision || revision === 'unknown') return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-skills-verify-'));
  try {
    const at = safeJoin(tmp, diskPath(skillId));
    const ok = await downloadGithub(skillId, at, opts, revision);
    if (!ok) return false;
    const a = listFiles(at);
    const b = listFiles(dest);
    if (a.length !== b.length || a.some((f, i) => f !== b[i])) return false;
    return a.every((f) => fs.readFileSync(path.join(at, f)).equals(fs.readFileSync(path.join(dest, f))));
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Upstream revision at save time — `git ls-remote` gives the full HEAD sha
 * (no API quota). 'unknown' when unreachable: the save still lands, its
 * stamp just can't verify "unedited" later.
 */
async function headRevision(skillId: string, opts: SkillResolverOpts): Promise<string> {
  if (!isGh(skillId)) return 'unknown';
  const { owner, repo } = ghParts(skillId);
  const base = opts.githubBaseUrl ?? GITHUB_GIT_BASE;
  const out = await runGitOut(['ls-remote', `${base}/${owner}/${repo}.git`, 'HEAD']);
  const sha = out?.split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : 'unknown';
}

// ─── Listings (autocomplete, `/skills`) ─────────────────────────────────────

/** Every skill under `.atskills/`, as IDs (`gh/` folded back to `gh:`). */
export function listLocalSkills(cwd: string): string[] {
  const root = skillsRoot(cwd);
  return walkSkills(root)
    .map((s) => (s.rel.startsWith('gh/') ? GH_PREFIX + s.rel.slice(3) : s.rel))
    .sort();
}
