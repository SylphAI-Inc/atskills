/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
/**
 * Canonical ID → reference spelling, safe to paste into a prompt. The `gh:`
 * marker is grammar, not a segment, so it stays literal.
 */
export declare function referenceSpelling(id: string): string;
export declare const GH_PREFIX = "gh:";
export declare const HUB_PREFIX = "hub:";
export declare const SKILLS_DIR = ".atskills";
/** True when the ID names the cloud — i.e. it carries a marker. */
export declare function isCloud(id: string): boolean;
/** True when the ID is the project's own: no marker, so never a fetch. */
export declare function isLocalOnly(id: string): boolean;
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
export declare const MAX_COLLECTION_SKILLS = 128;
export declare const AUTOTRIGGER_FILE = ".autotrigger";
export declare const SOURCE_FILE = ".source";
/**
 * Accept pasted GitHub URLs, exactly like the old @workflow resolver did:
 * `github.com/owner/repo[/tree/<branch>|/blob/<branch>]/path` → `gh:owner/repo/path`
 * (the tree/blob + branch pair is spliced out; a trailing SKILL.md drops).
 */
export declare function fromGithubUrl(raw: string): string | null;
/**
 * Normalize any accepted spelling to the canonical ID. Throws on an empty
 * path, a `gh:` address shorter than owner/repo, or any segment that could
 * escape the skills tree.
 */
export declare function normalizeId(raw: string): string;
export declare function isGh(id: string): boolean;
/** The on-disk spelling of an ID — always relative, never escaping the root. */
export declare function diskPath(id: string): string;
/**
 * The human review page for a `gh:` ID — where a person reads a cloud skill
 * before trusting it. Cloud badges carry this so reviewing is one click, not
 * a URL you have to reconstruct. Null for anything not hosted on GitHub.
 */
export declare function webUrl(id: string): string | null;
export declare function ghParts(id: string): {
    owner: string;
    repo: string;
    sub: string;
};
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
export declare function parseReference(raw: string): SkillReference;
