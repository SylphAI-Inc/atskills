/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
import type { SkillTreeItem, SkillCheckState } from './types.js';
/**
 * The whole management tree: every local skill at its depth (single-child dir
 * chains compressed into one row, GitHub-style), every followed cloud line,
 * every broken line — nothing hidden. `checked` is computed here so a
 * renderer needs no filesystem at all.
 */
export declare function collectTreeItems(root: string): SkillTreeItem[];
/**
 * The one toggle — filesystem-checkbox semantics at any depth. Returns a
 * note describing what was written (shown in the dialog's status row).
 */
export declare function toggleTreeItem(root: string, itemId: string): string;
/** The checkbox a state renders as — shared vocabulary with the reference. */
export declare function checkboxFor(state: SkillCheckState): string;
