/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
import type { LoadResponse, Logger } from './types.js';
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
export declare const DEFAULT_CACHE_DIR: string;
/** `.atskills/` for a project root. */
export declare function skillsRoot(workingDir: string): string;
/**
 * Resolve a reference. `save` copies the skill into `.atskills/<id>/` with a
 * `.source` stamp; without it the resolution is a read (cloud results land in
 * the global cache, which is always safe to delete).
 *
 * `install` appends the skill's line to `.atskills/.autotrigger` — the `@`
 * cloud form on its own, the plain vendored path when a saved copy answers
 * the ID. It implies nothing about saving: the two suffixes are orthogonal.
 */
export declare function resolveSkill(id: string, save: boolean, opts: SkillResolverOpts, install?: boolean): Promise<LoadResponse>;
/** Local resolution only — used by the resolver and by `/skills` listings. */
export declare function resolveLocal(skillId: string, root: string): LoadResponse | null;
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
export declare function largestUsableCollections(skills: string[]): Array<{
    rel: string;
    count: number;
}>;
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
export declare function parseTreeListing(out: string): TreeEntry[];
/** Bytes as a person reads them — the unit a download decision is made in. */
export declare function formatBytes(bytes: number): string;
export declare class SkillCollectionTooLargeError extends Error {
    readonly skillId: string;
    readonly count: number;
    readonly suggestions: Array<{
        id: string;
        count: number;
    }>;
    readonly bytes: number;
    constructor(skillId: string, count: number, suggestions: Array<{
        id: string;
        count: number;
    }>, bytes?: number);
}
/**
 * Enforce the cap against a repo file listing. A SKILL.md at the path itself
 * is one skill whose bundle may be any size — the cap counts skills, never
 * files, so a legitimately large single skill is never refused.
 */
export declare function assertCollectionFits(entries: TreeEntry[], owner: string, repo: string, sub: string): void;
export declare function saveSkillToProject(id: string, opts: SkillResolverOpts): Promise<LoadResponse>;
/** Every skill under `.atskills/`, as IDs (`gh/` folded back to `gh:`). */
export declare function listLocalSkills(cwd: string): string[];
