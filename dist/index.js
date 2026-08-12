"use strict";
/**
 * @license
 * Copyright 2025 SylphAI Inc. — MIT
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAutotriggerIndex = exports.SkillCollectionTooLargeError = exports.DEFAULT_CACHE_DIR = exports.formatBytes = exports.parseTreeListing = exports.largestUsableCollections = exports.assertCollectionFits = exports.listLocalSkills = exports.skillsRoot = exports.saveSkillToProject = exports.resolveLocal = exports.resolveSkill = exports.writeSource = exports.writeFileAtomic = exports.walkSkills = exports.safeJoin = exports.pool = exports.nearestSource = exports.listFiles = exports.leafSkillDirs = exports.frontmatter = exports.findAtskills = exports.copyDirSync = exports.bundleEntries = void 0;
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
__exportStar(require("./types.js"), exports);
__exportStar(require("./ids.js"), exports);
var fsx_js_1 = require("./fsx.js");
Object.defineProperty(exports, "bundleEntries", { enumerable: true, get: function () { return fsx_js_1.bundleEntries; } });
Object.defineProperty(exports, "copyDirSync", { enumerable: true, get: function () { return fsx_js_1.copyDirSync; } });
Object.defineProperty(exports, "findAtskills", { enumerable: true, get: function () { return fsx_js_1.findAtskills; } });
Object.defineProperty(exports, "frontmatter", { enumerable: true, get: function () { return fsx_js_1.frontmatter; } });
Object.defineProperty(exports, "leafSkillDirs", { enumerable: true, get: function () { return fsx_js_1.leafSkillDirs; } });
Object.defineProperty(exports, "listFiles", { enumerable: true, get: function () { return fsx_js_1.listFiles; } });
Object.defineProperty(exports, "nearestSource", { enumerable: true, get: function () { return fsx_js_1.nearestSource; } });
Object.defineProperty(exports, "pool", { enumerable: true, get: function () { return fsx_js_1.pool; } });
Object.defineProperty(exports, "safeJoin", { enumerable: true, get: function () { return fsx_js_1.safeJoin; } });
Object.defineProperty(exports, "walkSkills", { enumerable: true, get: function () { return fsx_js_1.walkSkills; } });
Object.defineProperty(exports, "writeFileAtomic", { enumerable: true, get: function () { return fsx_js_1.writeFileAtomic; } });
Object.defineProperty(exports, "writeSource", { enumerable: true, get: function () { return fsx_js_1.writeSource; } });
__exportStar(require("./autotrigger.js"), exports);
__exportStar(require("./tree.js"), exports);
// Composition — how a MESSAGE of references resolves, as opposed to one.
__exportStar(require("./compose.js"), exports);
var resolver_js_1 = require("./resolver.js");
Object.defineProperty(exports, "resolveSkill", { enumerable: true, get: function () { return resolver_js_1.resolveSkill; } });
Object.defineProperty(exports, "resolveLocal", { enumerable: true, get: function () { return resolver_js_1.resolveLocal; } });
Object.defineProperty(exports, "saveSkillToProject", { enumerable: true, get: function () { return resolver_js_1.saveSkillToProject; } });
Object.defineProperty(exports, "skillsRoot", { enumerable: true, get: function () { return resolver_js_1.skillsRoot; } });
Object.defineProperty(exports, "listLocalSkills", { enumerable: true, get: function () { return resolver_js_1.listLocalSkills; } });
Object.defineProperty(exports, "assertCollectionFits", { enumerable: true, get: function () { return resolver_js_1.assertCollectionFits; } });
Object.defineProperty(exports, "largestUsableCollections", { enumerable: true, get: function () { return resolver_js_1.largestUsableCollections; } });
Object.defineProperty(exports, "parseTreeListing", { enumerable: true, get: function () { return resolver_js_1.parseTreeListing; } });
Object.defineProperty(exports, "formatBytes", { enumerable: true, get: function () { return resolver_js_1.formatBytes; } });
// Exported so hosts locate the cache by calling the protocol rather than
// rebuilding the path — a hardcoded copy silently looks in the wrong place
// the moment the default moves (as it just did).
Object.defineProperty(exports, "DEFAULT_CACHE_DIR", { enumerable: true, get: function () { return resolver_js_1.DEFAULT_CACHE_DIR; } });
Object.defineProperty(exports, "SkillCollectionTooLargeError", { enumerable: true, get: function () { return resolver_js_1.SkillCollectionTooLargeError; } });
var residency_js_1 = require("./residency.js");
Object.defineProperty(exports, "buildAutotriggerIndex", { enumerable: true, get: function () { return residency_js_1.buildAutotriggerIndex; } });
