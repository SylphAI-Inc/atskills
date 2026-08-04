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
exports.safeJoin = safeJoin;
exports.findAtskills = findAtskills;
exports.frontmatter = frontmatter;
exports.walkSkills = walkSkills;
exports.leafSkillDirs = leafSkillDirs;
exports.nearestSource = nearestSource;
exports.writeSource = writeSource;
exports.listFiles = listFiles;
exports.bundleEntries = bundleEntries;
exports.copyDirSync = copyDirSync;
exports.pool = pool;
exports.writeFileAtomic = writeFileAtomic;
/**
 * Filesystem helpers shared by the @skills implementation.
 * Ported from SylphAI-Inc/atskills lib/fsx.js.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ids_js_1 = require("./ids.js");
/**
 * Join a relative path under root, refusing anything that escapes it — the
 * defense against `..` smuggled through a reference or a config line.
 */
function safeJoin(root, rel) {
    const base = path.resolve(root);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
        throw new Error(`path escapes the skills directory: ${rel}`);
    }
    return abs;
}
/**
 * The nearest `.atskills/` at or above `start`, or null. Same walk-up rule as
 * git's repo discovery: a skill command run in a subdirectory finds the
 * project's skills root.
 */
function findAtskills(start) {
    let dir = path.resolve(start);
    for (;;) {
        const p = path.join(dir, '.atskills');
        if (fs.existsSync(p) && fs.statSync(p).isDirectory())
            return p;
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Parse SKILL.md frontmatter. Tolerates CRLF, quoted values, and YAML block
 * scalars (`description: >-` folded over following indented lines). Only
 * `name` and `description` matter to the protocol — two fields don't justify
 * a YAML dependency.
 */
function frontmatter(text) {
    const normalized = String(text).replace(/\r\n/g, '\n');
    const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalized);
    const out = { name: null, description: null };
    if (!m)
        return out;
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
        const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
        if (!kv)
            continue;
        let value = kv[2].trim();
        if (/^[>|][+-]?$/.test(value)) {
            const parts = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
                i++;
                if (lines[i].trim())
                    parts.push(lines[i].trim());
            }
            value = parts.join(' ');
        }
        out[kv[1]] = value.replace(/^["']|["']$/g, '') || null;
    }
    return out;
}
/**
 * The one directory that is never content: git's own object store. It is
 * already filtered when saving, and holds no SKILL.md by construction.
 *
 * Every other directory is walked, INCLUDING dot-dirs — `.claude/skills/`,
 * `.agents/`, `.gemini/`, `.kiro/` and `.atskills/` are where the ecosystem
 * publishes, and hold ~12% of all skills. Skipping every dot-dir also made
 * local resolution disagree with remote listing (the GitHub trees API has no
 * such filter), so a skill visible on GitHub vanished once it was saved.
 *
 * Protocol: atskills PROTOCOL.md §8.2.1 (source of truth — change it there).
 */
const SKIP_DIRS = new Set(['.git']);
/**
 * Walk for skills under dir. A skill is a folder holding SKILL.md, and the
 * walk stops there (leaf rule). Dot FILES (.source, .autotrigger) are metadata
 * and are never skills; dot-DIRS are walked — see SKIP_DIRS.
 */
function walkSkills(dir, rel = '') {
    let stat;
    try {
        stat = fs.statSync(dir);
    }
    catch {
        return [];
    }
    if (!stat.isDirectory())
        return [];
    if (fs.existsSync(path.join(dir, 'SKILL.md')))
        return [{ rel, dir }];
    const found = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name))
            continue;
        found.push(...walkSkills(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
    }
    return found;
}
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
function leafSkillDirs(paths) {
    const dirs = new Set();
    for (const raw of paths) {
        const p = raw.trim().replace(/^\.\//, '');
        if (!p.endsWith('SKILL.md'))
            continue;
        const dir = p.slice(0, Math.max(0, p.length - 'SKILL.md'.length)).replace(/\/$/, '');
        // Same rule as walkSkills — the pre-download count and the menu it guards
        // must apply identical filters, or the cap is enforced on a number the
        // reader never sees.
        if (dir.split('/').some((seg) => SKIP_DIRS.has(seg)))
            continue;
        dirs.add(dir);
    }
    // Leaf rule: drop any dir that sits inside another skill dir.
    return [...dirs]
        .filter((dir) => {
        const segs = dir.split('/');
        for (let i = 1; i < segs.length; i++) {
            if (dirs.has(segs.slice(0, i).join('/')))
                return false;
        }
        return !(dir !== '' && dirs.has(''));
    })
        .sort();
}
function parseSource(file) {
    const [id, line2 = ''] = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const m = /^(\S+)\s+rev:(\S+)$/.exec(line2.trim());
    return { id: id.trim(), taken: m ? m[1] : line2.trim(), revision: m ? m[2] : null, file };
}
/**
 * Nearest `.source` at or above `dir`, stopping at root — a directory save
 * writes one stamp at the subtree top, so the closest stamp above a skill is
 * its origin. Pure provenance: nothing resolves against it.
 */
function nearestSource(dir, root) {
    let cur = path.resolve(dir);
    const stop = path.resolve(root);
    for (;;) {
        const f = path.join(cur, ids_js_1.SOURCE_FILE);
        if (fs.existsSync(f)) {
            try {
                return parseSource(f);
            }
            catch {
                return null;
            }
        }
        if (cur === stop)
            return null;
        const parent = path.dirname(cur);
        if (parent === cur)
            return null;
        cur = parent;
    }
}
/** Write the two-line stamp: the cloud ID, then the revision taken. */
function writeSource(dest, id, revision) {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ids_js_1.SOURCE_FILE), `${id}\n${today} rev:${revision}\n`, 'utf-8');
}
/** Non-dot files of a tree, as sorted relative posix paths. */
function listFiles(dir, rel = '') {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.'))
            continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory())
            out.push(...listFiles(path.join(dir, e.name), r));
        else
            out.push(r);
    }
    return out;
}
/** Top-level entries of a skill dir, dirs marked with a trailing slash. */
function bundleEntries(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.') && e.name !== 'SKILL.md')
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort();
    }
    catch {
        return [];
    }
}
function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory())
            copyDirSync(s, d);
        else if (entry.isFile())
            fs.copyFileSync(s, d);
    }
}
/** Run fn over items with bounded concurrency — the network fan-out helper. */
async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}
/** All writes go through tmp+rename — a crash can never leave a partial file. */
function writeFileAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
}
