/**
 * @license
 * Copyright 2025 SylphAI Inc.
 */
import { type SkillResolverOpts } from './resolver.js';
/**
 * Build the block, or '' when nothing is resident. One skill loads once, no
 * matter how many lines cover it. A cloud line served from a stale cache is
 * marked IN ITS ROW — the block is what the user reads via "view prompt", so
 * the staleness note must live where they look, not in a dev log.
 */
export declare function buildAutotriggerIndex(opts: SkillResolverOpts): Promise<string>;
