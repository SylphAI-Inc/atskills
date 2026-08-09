/**
 * @license
 * Copyright 2025 SylphAI Inc. — MIT
 */

/**
 * atskills — the @skills protocol core, in TypeScript.
 *
 * One import gives a client everything: resolution through the global
 * validating cache (resolver), save = adapt + detach (resolver), the
 * `.autotrigger` file semantics (autotrigger), the management checkbox tree
 * (tree), and the residency prompt block a host splices in verbatim
 * (residency). Purely a filesystem plus git; one runtime dependency
 * (`ignore` — plain lines ARE gitignore patterns, so git's matcher is the
 * specification).
 *
 * Spec: PROTOCOL.md (implementers) · SKILLS.md (agents) · tests/ (machines).
 */

export * from './types.js';
export * from './ids.js';
export {
  bundleEntries,
  copyDirSync,
  findAtskills,
  frontmatter,
  leafSkillDirs,
  listFiles,
  nearestSource,
  pool,
  safeJoin,
  walkSkills,
  writeFileAtomic,
  writeSource,
  type Frontmatter,
} from './fsx.js';
export * from './autotrigger.js';
export * from './tree.js';
// Composition — how a MESSAGE of references resolves, as opposed to one.
export * from './compose.js';
export {
  resolveSkill,
  resolveLocal,
  saveSkillToProject,
  skillsRoot,
  listLocalSkills,
  assertCollectionFits,
  largestUsableCollections,
  parseTreeListing,
  formatBytes,
  // Exported so hosts locate the cache by calling the protocol rather than
  // rebuilding the path — a hardcoded copy silently looks in the wrong place
  // the moment the default moves (as it just did).
  DEFAULT_CACHE_DIR,
  SkillCollectionTooLargeError,
  type SkillResolverOpts,
  type TreeEntry,
} from './resolver.js';
export { buildAutotriggerIndex } from './residency.js';
