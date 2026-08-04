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
export declare function saveSkillToProject(id: string, opts: SkillResolverOpts): Promise<LoadResponse>;
/** Every skill under `.atskills/`, as IDs (`gh/` folded back to `gh:`). */
export declare function listLocalSkills(cwd: string): string[];
