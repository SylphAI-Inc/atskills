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
exports.triggerFilePath = triggerFilePath;
exports.parseTriggers = parseTriggers;
exports.expandLocalTriggers = expandLocalTriggers;
exports.addTriggerLine = addTriggerLine;
exports.removeTriggerLine = removeTriggerLine;
exports.hasTriggerLine = hasTriggerLine;
exports.installLineFor = installLineFor;
/**
 * `.atskills/.autotrigger` — one file, the whole install lifecycle.
 *
 * Works like `.gitignore`: one entry per line, `#` for comments.
 *   plain (`sec-checklist`, `team-flows/`) → a gitignore PATTERN over the
 *     local tree under `.atskills/` — globs and `!` negation included.
 *   `@sylphai/glowmotion`  → the hub
 *   `@gh:stripe/toolkit`   → GitHub
 *   trailing `/`           → every skill under that directory
 *
 * Install = adding a line; uninstall = removing it. Every line resolves
 * local-first, so a saved copy answers its own `@` line, and per-line failures
 * are isolated — a line that can't load reports once and the session goes on.
 *
 * Ported from SylphAI-Inc/atskills lib/autotrigger.js.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ignoreModule = __importStar(require("ignore"));
const ids_js_1 = require("./ids.js");
const fsx_js_1 = require("./fsx.js");
// The `ignore` package ships a default export under CJS interop — same shim
// the core gitignore parser uses. Plain lines ARE gitignore patterns, so git's
// own matcher is the specification, not an approximation of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop
const ignore = (ignoreModule.default || ignoreModule);
function triggerFilePath(skillsRoot) {
    return path.join(skillsRoot, ids_js_1.AUTOTRIGGER_FILE);
}
/**
 * Parse the file. Comments and blanks drop; exact duplicate lines collapse
 * (they load once); order is preserved.
 */
/**
 * gitignore semantics: `#` introduces a comment only at the start of a line
 * (after leading whitespace); a `#` inside a pattern is a literal character —
 * a skill named `c#-patterns` must keep its full name.
 */
function effectiveLine(raw) {
    const line = raw.trim();
    return line.startsWith('#') ? '' : line;
}
function parseTriggers(skillsRoot) {
    const file = triggerFilePath(skillsRoot);
    if (!fs.existsSync(file))
        return [];
    const seen = new Set();
    const entries = [];
    for (const rawLine of fs.readFileSync(file, 'utf-8').split('\n')) {
        const line = effectiveLine(rawLine);
        if (!line || seen.has(line))
            continue;
        seen.add(line);
        if (!line.startsWith('@')) {
            entries.push({ line, cloud: false, pattern: line });
            continue;
        }
        const body = line.slice(1);
        const wholeDir = body.endsWith('/');
        try {
            entries.push({ line, cloud: true, id: (0, ids_js_1.normalizeId)(body), wholeDir });
        }
        catch (e) {
            entries.push({ line, cloud: true, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return entries;
}
/**
 * What actually loads at session start, for the LOCAL half of the file:
 * plain lines matched as one gitignore ruleset over the skill tree, plus any
 * `@` line a saved copy answers. Cloud lines with no local copy are left to
 * the caller (they need the network); they appear here as `where: 'cloud'`
 * placeholders so the count and ordering stay honest.
 */
function expandLocalTriggers(skillsRoot) {
    const out = [];
    const entries = parseTriggers(skillsRoot);
    for (const e of entries)
        if (e.error)
            out.push({ line: e.line, error: e.error });
    const plain = entries.filter((e) => !e.error && !e.cloud);
    const allLocal = (0, fsx_js_1.walkSkills)(skillsRoot);
    const loadedDirs = new Set();
    if (plain.length > 0) {
        const ig = ignore().add(plain.map((e) => e.pattern));
        for (const s of allLocal) {
            if (!ig.ignores(s.rel))
                continue;
            loadedDirs.add(s.dir);
            pushLocal(out, skillsRoot, s.rel, s.dir);
        }
        for (const e of plain) {
            const pattern = e.pattern;
            if (pattern.startsWith('!'))
                continue; // a negation matches nothing by design
            const one = ignore().add([pattern]);
            if (!allLocal.some((s) => one.ignores(s.rel))) {
                out.push({ line: e.line, error: `matches nothing under .atskills/` });
            }
        }
    }
    for (const entry of entries.filter((e) => !e.error && e.cloud)) {
        const id = entry.id;
        let localDir;
        try {
            localDir = (0, fsx_js_1.safeJoin)(skillsRoot, (0, ids_js_1.diskPath)(id));
        }
        catch (e) {
            out.push({ line: entry.line, error: e instanceof Error ? e.message : String(e) });
            continue;
        }
        const localSkills = (0, fsx_js_1.walkSkills)(localDir);
        if (localSkills.length > 0) {
            // local-first: a saved copy answers its own @ line
            for (const s of localSkills) {
                if (loadedDirs.has(s.dir))
                    continue; // one skill loads once
                loadedDirs.add(s.dir);
                pushLocal(out, skillsRoot, s.rel ? `${id}/${s.rel}` : id, s.dir, entry.line);
            }
        }
        else {
            out.push({ line: entry.line, id, where: 'cloud' });
        }
    }
    return out;
}
function pushLocal(out, skillsRoot, id, dir, line) {
    const file = path.join(dir, 'SKILL.md');
    let fm;
    try {
        fm = (0, fsx_js_1.frontmatter)(fs.readFileSync(file, 'utf-8'));
    }
    catch (e) {
        out.push({ line: line ?? id, error: e instanceof Error ? e.message : String(e) });
        return;
    }
    if (!fm.name || !fm.description) {
        out.push({
            line: line ?? id,
            error: `SKILL.md at ${file} is missing frontmatter (name + description), which the skills index ` +
                `requires — skill skipped`,
        });
        return;
    }
    const src = (0, fsx_js_1.nearestSource)(dir, skillsRoot);
    out.push({ line: line ?? id, id, where: src ? 'saved' : 'yours', origin: src ? src.id : null, file, fm });
}
// ─── Editing — suffixes, dialog checkboxes and hand edits write the same lines ─
/** Append a line if it isn't already there. Returns false when it was. */
function addTriggerLine(skillsRoot, line) {
    const file = triggerFilePath(skillsRoot);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const target = line.trim();
    if (current.split('\n').some((l) => effectiveLine(l) === target))
        return false;
    const body = current.length > 0 && !current.endsWith('\n') ? `${current}\n` : current;
    fs.mkdirSync(skillsRoot, { recursive: true });
    (0, fsx_js_1.writeFileAtomic)(file, body + target + '\n');
    return true;
}
/** Drop a line. Returns false when it wasn't present. */
function removeTriggerLine(skillsRoot, line) {
    const file = triggerFilePath(skillsRoot);
    if (!fs.existsSync(file))
        return false;
    const target = line.trim();
    let removed = false;
    const kept = fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((raw) => {
        if (effectiveLine(raw) === target) {
            removed = true;
            return false;
        }
        return true;
    });
    if (removed)
        (0, fsx_js_1.writeFileAtomic)(file, kept.join('\n'));
    return removed;
}
function hasTriggerLine(skillsRoot, line) {
    return parseTriggers(skillsRoot).some((e) => e.line === line.trim());
}
/**
 * The line `:install` writes for an ID: the `@` cloud form, unless a saved
 * copy sits at the ID's path — then the plain local path, so the file reads
 * true. (The copy answers either way; this is purely honesty.)
 */
function installLineFor(skillsRoot, id) {
    const disk = (0, ids_js_1.diskPath)(id);
    try {
        if ((0, fsx_js_1.walkSkills)((0, fsx_js_1.safeJoin)(skillsRoot, disk)).length > 0)
            return disk;
    }
    catch {
        // escaping path — fall through to the cloud form, which normalizeId vetted
    }
    return `@${id}`;
}
