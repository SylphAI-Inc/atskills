/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
import { type Frontmatter } from './fsx.js';
export interface TriggerEntry {
    /** The line as written, comments and surrounding space stripped. */
    line: string;
    cloud: boolean;
    /** Canonical ID (cloud lines only). */
    id?: string;
    /** gitignore pattern (plain lines only). */
    pattern?: string;
    wholeDir?: boolean;
    /** Set when the line could not be parsed — reported, never fatal. */
    error?: string;
}
export interface ResidentSkill {
    line: string;
    id?: string;
    where?: 'yours' | 'saved' | 'cloud';
    /** `.source` line 1, for a saved copy. */
    origin?: string | null;
    file?: string;
    fm?: Frontmatter;
    error?: string;
}
export declare function triggerFilePath(skillsRoot: string): string;
export declare function parseTriggers(skillsRoot: string): TriggerEntry[];
/**
 * What actually loads at session start, for the LOCAL half of the file:
 * plain lines matched as one gitignore ruleset over the skill tree, plus any
 * `@` line a saved copy answers. Cloud lines with no local copy are left to
 * the caller (they need the network); they appear here as `where: 'cloud'`
 * placeholders so the count and ordering stay honest.
 */
export declare function expandLocalTriggers(skillsRoot: string): ResidentSkill[];
/** Append a line if it isn't already there. Returns false when it was. */
export declare function addTriggerLine(skillsRoot: string, line: string): boolean;
/** Drop a line. Returns false when it wasn't present. */
export declare function removeTriggerLine(skillsRoot: string, line: string): boolean;
export declare function hasTriggerLine(skillsRoot: string, line: string): boolean;
/**
 * The line `:install` writes for an ID: the `@` cloud form, unless a saved
 * copy sits at the ID's path — then the plain local path, so the file reads
 * true. (The copy answers either way; this is purely honesty.)
 */
export declare function installLineFor(skillsRoot: string, id: string): string;
