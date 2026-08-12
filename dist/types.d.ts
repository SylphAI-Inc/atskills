/**
 * @license
 * Copyright 2025 SylphAI Inc. — MIT
 */
/**
 * The @skills protocol's data shapes — the package defines them; hosts adapt.
 *
 * Naming note: "skill" everywhere. The `LoadResponse` here is what a client
 * gets back from resolving one `@skills:<path>` reference — a skill (body +
 * bundle) or a directory-as-menu.
 */
/** Where resolved content came from. */
export type SkillSource = 'local' | 'github' | 'platform';
/** Provenance of a cloud resolution. */
export interface OriginInfo {
    type: 'marketplace' | 'github';
    /** Hub slug (type=marketplace). */
    slug?: string;
    /** GitHub "owner/repo". */
    githubRepo?: string;
    /** Path of the skill directory inside the repo. */
    githubPath?: string;
    /**
     * Hub visibility, when the registry stated it (fresh downloads only —
     * cache hits do not re-ask). Absent means public or unknown; hosts show
     * "(private)" only on the explicit value, never infer it.
     */
    visibility?: 'private' | 'public';
}
/**
 * One child of a resolved skills directory. `path` is the MATERIALIZED local
 * SKILL.md (project copy or cache) — the agent reads it on demand rather than
 * receiving every body up front.
 */
export interface SkillMenuEntry {
    id: string;
    name: string;
    description: string;
    path: string;
    /** Top-level entries beside SKILL.md, dirs marked with a trailing slash. */
    bundle: string[];
}
/** Response shape from resolving one reference. */
export interface LoadResponse {
    success: boolean;
    /** The canonical ID the reference resolved to (a pasted URL normalizes). */
    id?: string;
    /**
     * Human review page for a cloud skill — the GitHub tree URL. Present only
     * when the content came from the cloud: a local copy is project code, read
     * in the editor, not on a website.
     */
    reviewUrl?: string;
    /**
     * 'skill' — one skill; `path`/`content` are set.
     * 'menu'  — a directory with no SKILL.md; `entries`/`dir` are set.
     */
    kind?: 'skill' | 'menu';
    path?: string;
    content?: string;
    files?: string[];
    /** Directory case: the materialized local directory holding the children. */
    dir?: string;
    /** Directory case: one row per skill under it. */
    entries?: SkillMenuEntry[];
    source?: SkillSource;
    /** Cloud resolutions: how the cache answered — fresh fetch, validated hit,
     *  or a stale copy served because upstream was unreachable. */
    served?: 'fresh' | 'cache' | 'stale';
    /** Provenance of cloud resolutions. */
    origin?: OriginInfo;
    /** Non-fatal problem the surface should show (e.g. served stale offline). */
    warning?: string;
    error?: string;
}
/** How a tree row's checkbox reads: [x] direct · [#] via-dir · [~] partial · [ ] off. */
export type SkillCheckState = 'direct' | 'via-dir' | 'partial' | false;
/**
 * One row of the management tree — the filesystem-checkbox view of
 * `.atskills/` + `.autotrigger`. Serializable: `checked` is computed at
 * collection time, so a renderer needs no filesystem at all.
 */
export interface SkillTreeItem {
    /** yours = the project's own work · saved = a detached copy (.source) ·
     *  dir = a directory node · cloud = a followed @ line · error = a broken line. */
    kind: 'yours' | 'saved' | 'dir' | 'cloud' | 'error';
    /** The `.autotrigger` line this row toggles (dir rows end with `/`). */
    line: string;
    /** Row identity — stable across toggles (cursor follows it). */
    id: string;
    display: string;
    depth: number;
    /** Parent prefix inside `.atskills/` ('' at the root) — tree-branch drawing. */
    parentDir?: string;
    /** `.source` line 1 for a saved copy — the id it was taken from. */
    sourceId?: string | null;
    description: string;
    /** Where it came from: yours · from <id> (<date>) · github · directory. */
    origin: string;
    /** A conflicting `@` line this local copy answers — surfaced, not hidden. */
    atLine?: string;
    /** dir rows: every skill its one line covers. */
    children?: string[];
    checked: SkillCheckState;
}
/** Injected log sink — the package never writes to a host's logger directly. */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
}
