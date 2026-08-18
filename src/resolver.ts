/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */

/**
 * Skill resolver — the `@skills:` half of the protocol.
 *
 * The whole rule is **the prefix decides, then local first**. A bare path is
 * the project's own (`.atskills/<path>`) and NEVER reaches the network — a
 * miss is an error naming the cloud forms, not a silent fetch. `hub:` and
 * `gh:` name the cloud and still resolve local-first, so a saved copy answers
 * its own address. `.source` is NEVER consulted to resolve anything — a saved
 * copy answers because it sits at the ID's own path (vendoring), not because
 * a manifest says so.
 *
 * That asymmetry is the point: a reference cannot change meaning because a
 * folder appeared or vanished, which matters most for `.autotrigger` lines,
 * which are git-tracked and run unattended on a teammate's machine.
 *
 * A directory with no SKILL.md is not a failure — it's a menu: one row per
 * skill under it, each row a valid path the agent can read on demand.
 *
 * Design: docs/adal/workflows/fea_skills_final_design.md §2, §7.1.
 * Logic ported from SylphAI-Inc/atskills lib/resolve.js + lib/save.js.
 */

import { spawn } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { LoadResponse, Logger, OriginInfo, SkillMenuEntry } from './types.js';
import {
  GH_PREFIX,
  MAX_COLLECTION_SKILLS,
  SKILLS_DIR,
  SOURCE_FILE,
  diskPath,
  ghParts,
  isGh,
  isLocalOnly,
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
   * `~/.cache/atskills` (see DEFAULT_CACHE_DIR) — the protocol's shared
   * location, agent-neutral: any atskills implementation on the machine reads
   * and writes the same tree (`<cacheDir>/<disk path>` bodies, revision stamps
   * under `.meta/`). Never inside `.atskills/`, which is the project's.
   * Entries are always safe to delete; the path re-resolves.
   */
  cacheDir?: string;
  /**
   * Hub/registry base URL for non-`gh:` IDs — OPT-IN. The protocol needs no
   * hub: `gh:` paths and local folders resolve without one, forever. A host
   * that wants hub IDs configures its registry here; without it, a hub-style
   * reference fails fast with a message instead of a network call.
   */
  registryBaseUrl?: string;
  /**
   * Bearer token for hub reads — OPT-IN, same as the registry itself.
   *
   * A FUNCTION, not a string: tokens expire and the host refreshes them
   * mid-session, so a value captured when the resolver was built goes stale in
   * a long-running TUI. Called per hub request; returning undefined means
   * "anonymous", which is a valid answer, not an error.
   *
   * Anonymous sees only PUBLIC skills. A private skill belongs to an account,
   * so reading one requires that account's token — and the registry answers
   * 404 rather than 401 for a private skill you do not own, so that its
   * existence is not leaked to someone who cannot read it.
   */
  registryAuth?: () => string | undefined | Promise<string | undefined>;
  /**
   * Base URL that `gh:owner/repo` remotes resolve under. Defaults to
   * `https://github.com`; tests point it at local repos (`file://…`), and it
   * is the seam for GitHub Enterprise hosts.
   */
  githubBaseUrl?: string;
  /**
   * Catalogue that learns which `gh:` paths people actually reference — the
   * auto-discovery channel.
   *
   * A `gh:` path resolves entirely from git, so nothing ever learns that the
   * repo exists; a catalogue could only grow by someone submitting a repo by
   * hand. Set this and each successful `gh:` resolve also announces the path,
   * so the catalogue grows from real use.
   *
   * The guarantee that matters: this NEVER affects resolution. It is started
   * alongside the git fetch, never awaited, and every failure is swallowed —
   * offline, 500, DNS gone, wrong URL, all identical to not setting it. The
   * `gh:` path still resolves with zero involvement from this endpoint, which
   * is what PROTOCOL.md §"The Hub" promises.
   *
   * Separate from `registryBaseUrl` on purpose: that one SERVES skills and a
   * host may point it anywhere; this one only ever RECEIVES a path. Keeping
   * them apart means configuring a catalogue cannot accidentally reroute
   * where skills are read from.
   */
  discoveryBaseUrl?: string;
  /** Injected log sink; the package never assumes a host logger. */
  log?: Logger;
}

const GITHUB_GIT_BASE = 'https://github.com';

/**
 * The protocol's global cache — one tree per machine, shared by every agent.
 *
 * It lives OUTSIDE `.atskills/` on purpose. It used to be `~/.atskills/cache`,
 * which collides with the project tree whenever a project's root is the home
 * directory: `.atskills/` is then both the project's skills and the machine's
 * cache, so downloaded copies enumerate as the user's own skills (observed: 54
 * of them). Checking one would write an `.autotrigger` line — git-tracked —
 * pointing into a machine-local, evictable cache that resolves to nothing on a
 * teammate's machine. No name under `.atskills/` avoids this; only being
 * outside it does.
 *
 * `$XDG_CACHE_HOME/atskills`, falling back to `~/.cache/atskills`: a cache in
 * the place the OS already reserves for caches, which is also what makes it
 * obviously safe to delete. Entries always re-resolve; `ATSKILLS_CACHE`
 * overrides.
 */
export const DEFAULT_CACHE_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'atskills',
);

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
  } else if (isLocalOnly(skillId)) {
    // ── A bare path is the project's own, and only that ──
    // No network fallback: the prefix decides, so a reference can never change
    // meaning because a folder appeared or vanished. The miss is where
    // discovery belongs — name the forms that WOULD reach the cloud.
    result = {
      success: false,
      error:
        `No skill at ${SKILLS_DIR}/${diskPath(skillId)}. A bare path means the project's own skills; ` +
        `for the cloud, say where: 'hub:owner/name' or 'gh:owner/repo/path'.`,
    };
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
  if (origin.type === 'marketplace') {
    // The marker survives the download that learned it, so a cache hit an
    // hour later still knows. Only the explicit value is carried.
    const visibility = readVisibility(dest);
    if (visibility) origin.visibility = visibility;
  }

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
      return warning
        ? { ...described, warning, served: 'stale' as const }
        : { ...described, served: 'cache' as const };
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
      return { ...fresh, served: 'fresh' };
    } catch (e) {
      // A too-large refusal is an ANSWER, not an outage: surfacing the stale
      // menu with a "could not reach upstream" note would be false, and it
      // would hide the sub-collection suggestions the error carries.
      if (e instanceof SkillCollectionTooLargeError) throw e;
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
    return { ...fresh, served: 'fresh' };
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

  // TWO CALLS, STARTED TOGETHER — git decides the outcome, the catalogue only
  // listens. `announceDiscovery` is deliberately NOT awaited and never joined
  // back: the returned promise is the git one alone, so a slow or dead
  // catalogue cannot add a millisecond to a resolve.
  announceDiscovery(skillId, opts);

  return downloadViaGit(owner, repo, sub, dest, ref, opts.githubBaseUrl ?? GITHUB_GIT_BASE);
}

/**
 * Tell the catalogue this `gh:` path was referenced. Fire-and-forget.
 *
 * Never fires for a GitHub ENTERPRISE host. `acme-corp/payments-internal` is
 * a repo name a public catalogue cannot index and has no business learning,
 * and a host that points `githubBaseUrl` at its own install should not have
 * to remember to also unset the catalogue to stay private.
 *
 * The test is "an http(s) host that is not github.com", not "anything other
 * than the default": `file://` bases are local fixtures, never an enterprise
 * install, and excluding them would leave this whole path untestable —
 * exactly the code that most needs a test.
 *
 * Every failure path is silent by design. A resolve that printed "could not
 * reach the catalogue" would be reporting OUR problem as the user's, in the
 * middle of work that succeeded.
 */
/** A self-hosted GitHub: an http(s) origin that is not github.com itself. */
function isEnterpriseHost(githubBaseUrl?: string): boolean {
  if (!githubBaseUrl || githubBaseUrl === GITHUB_GIT_BASE) return false;
  try {
    const { protocol, hostname } = new URL(githubBaseUrl);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const host = hostname.toLowerCase();
    return host !== 'github.com' && host !== 'www.github.com';
  } catch {
    // Unparseable base: treat as not-enterprise. The announce is harmless on
    // its own, and the git fetch is what will fail loudly.
    return false;
  }
}

function announceDiscovery(skillId: string, opts: SkillResolverOpts): void {
  const base = opts.discoveryBaseUrl;
  if (!base) return;
  if (isEnterpriseHost(opts.githubBaseUrl)) return;

  try {
    const url = new URL(`${base.replace(/\/+$/, '')}/index`);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ reference: skillId });

    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      // Drain and discard. Not reading leaves the socket half-open until the
      // server gives up; the answer itself only interests the catalogue.
      (res) => res.resume(),
    );

    // node:http rather than fetch, for THIS line. A CLI resolves a skill and
    // then exits, and an un-awaited fetch still holds the event loop open
    // until its socket settles — measured at ~5s of dead air after the work
    // finished, against a catalogue that accepted the connection and never
    // answered. The user would read that as the CLI hanging. `unref` lets the
    // process exit the instant it is otherwise done; if it is still alive,
    // the request completes normally. fetch exposes no way to do this.
    req.on('socket', (socket) => {
      // ORDER MATTERS, and so does doing it twice.
      //
      // The timeout arms first because `socket.setTimeout` re-refs the
      // handle, so unref-ing before it silently undoes the unref. And the
      // socket gets re-ref'd again when the agent finishes connecting it, so
      // one call at assignment time is not enough — both were measured as a
      // live `Socket` handle keeping a finished process alive for 5.17s.
      //
      // `req.setTimeout` is NOT used: it arms a standalone timer, and a
      // pending timer holds the loop open on its own. The socket's timer dies
      // with the socket.
      socket.setTimeout(5_000, () => req.destroy());
      socket.unref();
      socket.on('connect', () => socket.unref());
    });
    // Silence is deliberate. Logger has only info/warn, both of which reach
    // the user, and "could not reach the catalogue" is OUR problem surfacing
    // in the middle of work that succeeded.
    req.on('error', () => {});
    req.end(body);
  } catch {
    // Malformed base URL, and anything else thrown synchronously. A
    // misconfigured catalogue must not break a resolve that works.
  }
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
    // Plain `ls-tree -r` reads pure tree metadata (mode/type/sha/path) from
    // the objects already fetched. NEVER add `-l`: sizes live in the BLOBS,
    // which `--filter=blob:none` did not fetch, so `-l` triggers one lazy
    // promisor fetch per file — on a catalog repo that is thousands of round
    // trips, and the listing that was supposed to avoid the download costs
    // more than the download.
    const listing = await runGitOut(['ls-tree', '-r', treeish], tmp);
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
 * Parse `git ls-tree -r` — `<mode> <type> <sha>[ <size>]\t<path>`. Accepts
 * both the plain and `-l` forms; without `-l` every size is -1 (unknown).
 * Sizes live in blobs, not tree metadata, so under `--filter=blob:none` a
 * sized listing is not available without paying per-file fetches — the cap
 * decision needs only the skill COUNT, which the plain listing gives free.
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
export function assertCollectionFits(
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
  // -1 (unknown) when the listing carried no sizes — never claim "0 B".
  const bytes = scoped.some((e) => e.size > 0)
    ? scoped.reduce((sum, e) => (e.size > 0 ? sum + e.size : sum), 0)
    : -1;
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
  // Take the suffix after the LAST '.new-': a repo-controlled dir named
  // 'foo.new-x' must not make two concurrent swaps agree on one retired path.
  const suffix = path.basename(staging).split('.new-').pop();
  const retired = `${dest}.old-${suffix}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let destMovedAside = false;
  try {
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, retired);
      destMovedAside = true;
    }
    fs.renameSync(staging, dest);
  } catch (err) {
    // The second rename failed with dest already moved aside: put the old
    // tree back before surfacing the error — a failed refresh must never
    // leave the user with NO copy where they had one.
    if (destMovedAside && !fs.existsSync(dest)) {
      try {
        fs.renameSync(retired, dest);
      } catch {
        // Restore failed too; leave `retired` in place for manual recovery.
      }
    }
    throw err;
  } finally {
    if (fs.existsSync(dest)) fs.rmSync(retired, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The visibility marker: a dotfile beside the cached SKILL.md remembering
 * what the registry said. Without it only the FIRST resolution could badge a
 * private skill — every later read is a cache hit that never re-asks, and
 * "is this private?" is not a fact that should expire with the cache. A
 * dotfile so listings skip it (listFiles is non-dot by contract). Absent
 * marker = public or unknown; hosts stay silent.
 */
const VISIBILITY_FILE = '.visibility';

function writeVisibility(dest: string, visibility: 'private' | 'public' | undefined): void {
  const file = path.join(dest, VISIBILITY_FILE);
  if (visibility) fs.writeFileSync(file, visibility + '\n', 'utf-8');
  // Registry stated nothing: remove a stale marker rather than let a skill
  // flipped private→public keep its old label.
  else fs.rmSync(file, { force: true });
}

function readVisibility(dest: string): 'private' | 'public' | undefined {
  try {
    const raw = fs.readFileSync(path.join(dest, VISIBILITY_FILE), 'utf-8').trim();
    return raw === 'private' || raw === 'public' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Is there a SKILL.md at exactly this path? The one question that decides. */
/** Resolve a hub/registry ID and materialize it at `dest`. */
async function downloadRegistry(
  skillId: string,
  dest: string,
  opts: SkillResolverOpts,
): Promise<'private' | 'public' | undefined> {
  const base = opts.registryBaseUrl;
  if (!base) {
    throw new Error(
      `'${skillId}' is a hub path, and no registry is configured. ` +
      `Use a gh:owner/repo/path reference (needs no hub), or set registryBaseUrl.`,
    );
  }
  let data: {
    entry?: {
      content?: string;
      github_skill_path?: string;
      github_repo?: string;
      github_path?: string;
      visibility?: 'private' | 'public';
    };
  };
  // Resolved per request, not per resolver: the host refreshes tokens, and a
  // token read once at construction is the wrong one an hour later.
  const token = await opts.registryAuth?.();
  try {
    const response = await fetch(`${base}/resolve/${skillId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 404) {
      // The registry answers 404 — never 401 — for a private skill you cannot
      // read, so its existence stays hidden. That means "missing" and "not
      // yours" are the SAME answer here, and the message has to cover both or
      // a signed-out owner is told their own skill does not exist.
      // Name WHICH registry answered: "not found" usually means the host is
      // pointed at a different environment (local/staging/prod) than the one
      // holding the skill, and without the host in the message that reads as
      // an auth problem — the exact debugging detour it sent a user on.
      const where = ` in the registry at ${base}`;
      throw new Error(
        token
          ? `Skill '${skillId}' not found${where}.`
          : `Skill '${skillId}' not found${where}. ` +
            `If it is private, sign in — a private skill is readable only by the account that owns it.`,
      );
    }
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status} for '${skillId}'`);
    data = (await response.json()) as typeof data;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  const entry = data?.entry ?? {};
  // Only meaningful on the response that stated it; a cache hit later cannot
  // know, and must not guess.
  const visibility = entry.visibility;
  if (entry.content) {
    // Swap, never write in place: a previous resolution may have left a
    // different body (even a whole GitHub subtree) at this path.
    const staging = stagingSiblingOf(dest);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), entry.content, 'utf-8');
    swapIntoPlace(staging, dest);
    writeVisibility(dest, visibility);
    return visibility;
  }
  if (entry.github_skill_path) {
    const ghId = entry.github_skill_path.startsWith(GH_PREFIX)
      ? normalizeId(entry.github_skill_path)
      : normalizeId(GH_PREFIX + entry.github_skill_path.replace(/^\/+/, ''));
    const ok = await downloadGithub(ghId, dest, opts);
    if (!ok) throw new Error(`SKILL.md not found at ${entry.github_skill_path}`);
    writeVisibility(dest, visibility);
    return visibility;
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
/** Every directory below `dir` carrying its own `.source` stamp — saved
 *  copies a parent-level save would absorb. Does not descend INTO a stamped
 *  dir (its content belongs to that save). `.git` is never content. */
function sourceStampDirsBelow(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const sub = path.join(dir, entry.name);
    if (fs.existsSync(path.join(sub, SOURCE_FILE))) out.push(sub);
    else out.push(...sourceStampDirsBelow(sub));
  }
  return out;
}

/** Is there ANY file under `dir` that is not inside one of `stamped`?
 *  Such a file is the project's own work — a parent save must not eat it. */
function hasContentOutsideStamps(dir: string, stamped: string[]): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const sub = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      if (stamped.includes(sub)) continue; // vendored — the stamp owns it
      if (hasContentOutsideStamps(sub, stamped)) return true;
    } else {
      return true; // a loose file at a namespace level = the project's own
    }
  }
  return false;
}

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

  // ANY non-empty existing dir gets the conflict treatment — a folder of
  // notes with no SKILL.md is still the project's own work, not overwritable.
  let absorbedNote: string | undefined;
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    const prior = nearestSource(dest, root);
    if (!prior) {
      // A parent NAMESPACE created by child saves has no .source of its own,
      // but it is not "the project's own work" — it holds saved copies.
      // Saving the parent is a legitimate WIDENING: when every saved child is
      // still unedited (verified against its own .source) and nothing else
      // lives here, the collection save ABSORBS them — the subtree is
      // replaced by the collection copy, a superset, stamped once here.
      const stamped = sourceStampDirsBelow(dest);
      if (stamped.length > 0) {
        if (hasContentOutsideStamps(dest, stamped)) {
          return {
            success: false,
            error:
              `conflict: ${rel}/ holds saved skills AND the project's own files — saving the whole ` +
              `directory would replace both. Move your own files out, or save siblings individually.`,
          };
        }
        const edited: string[] = [];
        for (const dir of stamped) {
          const stamp = nearestSource(dir, dir);
          const untouched =
            stamp !== null && (await isUneditedSince(stamp.id, dir, stamp.revision, opts));
          if (!untouched) edited.push(path.relative(root, dir));
        }
        if (edited.length > 0) {
          return {
            success: false,
            error:
              `conflict: ${rel}/ holds edited saved skill${edited.length === 1 ? '' : 's'} ` +
              `(${edited.join(', ')}) — saving the whole directory would lose those edits. ` +
              `Keep them and save siblings individually, or delete the edited folder${edited.length === 1 ? '' : 's'} first.`,
          };
        }
        absorbedNote =
          `absorbed ${stamped.length} previously saved skill${stamped.length === 1 ? '' : 's'} — ` +
          `the collection copy is a superset; provenance now lives at ${rel}/${SOURCE_FILE}`;
      } else {
        return {
          success: false,
          error:
            `conflict: ${rel}/ already exists and has no ${SOURCE_FILE} — it is the project's own work, ` +
            `so nothing was touched. Rename your folder, or save under a different path.`,
        };
      }
    } else {
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
  if (!local) return { success: false, error: `Saved '${skillId}' but nothing readable landed at ${rel}/` };
  return absorbedNote ? { ...local, warning: absorbedNote } : local;
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
