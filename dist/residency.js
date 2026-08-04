"use strict";
/**
 * @license
 * Copyright 2025 SylphAI Inc.
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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAutotriggerIndex = buildAutotriggerIndex;
/**
 * Residency — the auto-trigger prompt block, built ENTIRELY by the client.
 *
 * The protocol has one implementation per client: this one. The host that
 * assembles the model's prompt never parses `.autotrigger`, never walks
 * `.atskills/`, never touches the cache — it receives this block as a string
 * and splices it in verbatim. That keeps resolution, caching, and residency
 * in one codebase, so the management surface, the `@skills:` loader, and the
 * session prompt can never disagree.
 *
 * Each row matches the index-entry shape the backend uses for every other
 * skill source: `- name: description (path to SKILL.md)` — description first
 * so the trigger signal sits next to the name; the path is trailing metadata
 * the agent only needs after deciding to load the skill.
 *
 * Cloud lines resolve through the global validating cache, so calling this at
 * session start IS the "cloud lines refresh once per session" cadence:
 * unchanged upstreams serve instantly, offline serves the cached copy.
 * Per-line failures are never fatal — a line that loads nothing is reported
 * through the injected logger and the session goes on.
 */
const path = __importStar(require("path"));
const ids_js_1 = require("./ids.js");
const fsx_js_1 = require("./fsx.js");
const autotrigger_js_1 = require("./autotrigger.js");
const resolver_js_1 = require("./resolver.js");
const HEADER = 'Auto-triggered Skills (.atskills/.autotrigger):';
/** Cloud lines resolve concurrently — each may cost a network probe. */
const CLOUD_CONCURRENCY = 4;
/**
 * Build the block, or '' when nothing is resident. One skill loads once, no
 * matter how many lines cover it. A cloud line served from a stale cache is
 * marked IN ITS ROW — the block is what the user reads via "view prompt", so
 * the staleness note must live where they look, not in a dev log.
 */
async function buildAutotriggerIndex(opts) {
    const root = (0, resolver_js_1.skillsRoot)(opts.workingDir);
    const wholeDirByLine = new Map((0, autotrigger_js_1.parseTriggers)(root).map((e) => [e.line, e.wholeDir === true]));
    const rows = [];
    const seen = new Set(); // SKILL.md paths — one skill loads once
    const push = (name, description, file, line, note = '') => {
        if (seen.has(file))
            return;
        if (!name || !description) {
            opts.log?.warn(`[skills] .autotrigger line '${line}': ${file} is missing frontmatter (name + description) — skipped`);
            return;
        }
        seen.add(file);
        // Project files read as project-relative paths (.atskills/…): stable
        // across machines, no username in the prompt, and directly readable from
        // the project cwd. Cache paths stay absolute — they live outside it.
        const shown = file.startsWith(root + path.sep)
            ? path.join(ids_js_1.SKILLS_DIR, path.relative(root, file))
            : file;
        rows.push(`- ${name}: ${description}${note} (${shown})`);
    };
    const resident = (0, autotrigger_js_1.expandLocalTriggers)(root);
    for (const r of resident) {
        if (r.error) {
            opts.log?.warn(`[skills] .autotrigger line '${r.line}': ${r.error}`);
        }
        else if (r.where !== 'cloud') {
            push(r.fm?.name, r.fm?.description, r.file, r.line);
        }
    }
    // Cloud lines with no local copy — resolved through the global cache,
    // concurrently (each line can cost an ls-remote; a cold one costs a clone).
    const cloud = resident.filter((r) => !r.error && r.where === 'cloud');
    const resolutions = await (0, fsx_js_1.pool)(cloud, CLOUD_CONCURRENCY, async (r) => ({
        r,
        resolved: await (0, resolver_js_1.resolveSkill)(r.id, false, opts),
    }));
    for (const { r, resolved } of resolutions) {
        if (!resolved.success) {
            opts.log?.warn(`[skills] .autotrigger line '${r.line}' loads nothing: ${resolved.error}`);
            continue;
        }
        const note = resolved.warning ? ' [served from cache — upstream unreachable, may be stale]' : '';
        if (resolved.warning)
            opts.log?.warn(`[skills] ${resolved.warning}`);
        if (resolved.kind === 'skill' && resolved.path && resolved.content !== undefined) {
            const fm = (0, fsx_js_1.frontmatter)(resolved.content);
            push(fm.name, fm.description, resolved.path, r.line, note);
        }
        else if (resolved.kind === 'menu' && wholeDirByLine.get(r.line)) {
            for (const entry of resolved.entries ?? []) {
                push(entry.name, entry.description, entry.path, r.line, note);
            }
        }
        else {
            // A single-skill line only ever loads the skill at its own path.
            opts.log?.warn(`[skills] .autotrigger line '${r.line}': no SKILL.md at the id's own path — loads nothing (write '@${r.id}/' for the whole directory)`);
        }
    }
    return rows.length > 0 ? `${HEADER}\n${rows.join('\n')}` : '';
}
