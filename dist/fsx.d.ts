/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
/**
 * Join a relative path under root, refusing anything that escapes it — the
 * defense against `..` smuggled through a reference or a config line.
 */
export declare function safeJoin(root: string, rel: string): string;
/**
 * The nearest `.atskills/` at or above `start`, or null. Same walk-up rule as
 * git's repo discovery: a skill command run in a subdirectory finds the
 * project's skills root.
 */
export declare function findAtskills(start: string): string | null;
export interface Frontmatter {
    name: string | null;
    description: string | null;
}
/**
 * Parse SKILL.md frontmatter. Tolerates CRLF, quoted values, and YAML block
 * scalars (`description: >-` folded over following indented lines). Only
 * `name` and `description` matter to the protocol — two fields don't justify
 * a YAML dependency.
 */
export declare function frontmatter(text: string): Frontmatter;
export interface FoundSkill {
    /** Path relative to the walk root, posix separators. '' for the root itself. */
    rel: string;
    dir: string;
}
/**
 * Walk for skills under dir. A skill is a folder holding SKILL.md, and the
 * walk stops there (leaf rule). Dot FILES (.source, .autotrigger) are metadata
 * and are never skills; dot-DIRS are walked — see SKIP_DIRS.
 */
export declare function walkSkills(dir: string, rel?: string): FoundSkill[];
/**
 * The leaf rule applied to a flat path list instead of a live directory —
 * what `walkSkills` would find, computed from `git ls-tree` output before
 * anything is downloaded.
 *
 * A skill is a folder holding SKILL.md and the walk STOPS there, so a
 * SKILL.md nested inside another skill's bundle is that bundle's file, not a
 * second skill. Dot-dirs are metadata and never count. Returns the skill
 * directories, posix-relative, '' for the root itself.
 *
 * Kept pure and separate from walkSkills so the pre-download count and the
 * post-download walk cannot drift apart — they are the same rule, and a cap
 * enforced on a different count than the menu shows would be a lie.
 */
export declare function leafSkillDirs(paths: string[]): string[];
export interface SourceStamp {
    /** Line 1 — the cloud ID this copy came from. */
    id: string;
    /** Line 2's date part (`YYYY-MM-DD`), or the whole line when unparsable. */
    taken: string;
    /** Line 2's revision, or null when the stamp predates/omits one. */
    revision: string | null;
    file: string;
}
/**
 * Nearest `.source` at or above `dir`, stopping at root — a directory save
 * writes one stamp at the subtree top, so the closest stamp above a skill is
 * its origin. Pure provenance: nothing resolves against it.
 */
export declare function nearestSource(dir: string, root: string): SourceStamp | null;
/** Write the two-line stamp: the cloud ID, then the revision taken. */
export declare function writeSource(dest: string, id: string, revision: string): void;
/** Non-dot files of a tree, as sorted relative posix paths. */
export declare function listFiles(dir: string, rel?: string): string[];
/** Top-level entries of a skill dir, dirs marked with a trailing slash. */
export declare function bundleEntries(dir: string): string[];
export declare function copyDirSync(src: string, dest: string): void;
/** Run fn over items with bounded concurrency — the network fan-out helper. */
export declare function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>;
/** All writes go through tmp+rename — a crash can never leave a partial file. */
export declare function writeFileAtomic(file: string, content: string): void;
