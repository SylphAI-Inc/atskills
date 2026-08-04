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
exports.collectTreeItems = collectTreeItems;
exports.toggleTreeItem = toggleTreeItem;
exports.checkboxFor = checkboxFor;
/**
 * `/skills` — the management tree, part of the protocol. A filesystem-style
 * checkbox tree over `.autotrigger` and `.atskills/`: directories are nodes
 * you check or uncheck as a whole (one dir line covers every skill under it);
 * leaves check individually. Toggling rewrites the same lines a hand edit
 * would — no state beyond the files.
 *
 * Checkbox semantics (shared with the atskills reference console):
 *   [x] directly listed          [#] covered by a directory line
 *   [~] directory partially on   [ ] off
 *   toggle a dir  → add/remove its dir line (adding cleans redundant leaf lines)
 *   uncheck a covered leaf → SPLIT: the dir line becomes explicit sibling lines
 *   check a leaf → that leaf's line only — NEVER auto-promoted to a dir line
 *   (a dir/ line covers FUTURE skills too; only an explicit dir check says that)
 *
 * Ported from SylphAI-Inc/atskills lib/ui.js.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ignoreModule = __importStar(require("ignore"));
const ids_js_1 = require("./ids.js");
const fsx_js_1 = require("./fsx.js");
const autotrigger_js_1 = require("./autotrigger.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS/ESM interop
const ignore = (ignoreModule.default || ignoreModule);
/**
 * Immediate skill-bearing children of a directory. A child is a skill when it
 * holds SKILL.md (leaf rule); otherwise it is a deeper directory (kept only
 * if skills live somewhere below it).
 */
function localChildren(root, dirPath) {
    const abs = dirPath ? (0, fsx_js_1.safeJoin)(root, dirPath) : root;
    if (!fs.existsSync(abs))
        return [];
    const out = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.'))
            continue;
        const p = dirPath ? `${dirPath}/${e.name}` : e.name;
        const isSkill = fs.existsSync(path.join(abs, e.name, 'SKILL.md'));
        if (isSkill || (0, fsx_js_1.walkSkills)(path.join(abs, e.name)).length > 0)
            out.push({ name: e.name, path: p, isSkill });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
/** The .autotrigger line that covers a child: skills by path, dirs by path/. */
function coverLine(c) {
    return c.isSkill ? c.path : `${c.path}/`;
}
/**
 * The whole management tree: every local skill at its depth (single-child dir
 * chains compressed into one row, GitHub-style), every followed cloud line,
 * every broken line — nothing hidden. `checked` is computed here so a
 * renderer needs no filesystem at all.
 */
function collectTreeItems(root) {
    const items = [];
    const localPaths = new Set();
    for (const s of (0, fsx_js_1.walkSkills)(root))
        localPaths.add(s.rel);
    const pushSkill = (rel, depth, parentDir) => {
        try {
            (0, ids_js_1.normalizeId)(rel);
        }
        catch (err) {
            // a local name the reference grammar can't address — show it, don't lie
            items.push({
                kind: 'error', id: rel, line: rel, display: rel, depth,
                description: `unaddressable name: ${err instanceof Error ? err.message : String(err)}`,
                origin: 'invalid', checked: false,
            });
            return;
        }
        const dir = (0, fsx_js_1.safeJoin)(root, rel);
        // The dir can vanish between walkSkills and this read (concurrent
        // /skills remove, background checkout) — skip it rather than throwing
        // the whole tree away.
        let raw;
        try {
            raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
        }
        catch {
            return;
        }
        const fm = (0, fsx_js_1.frontmatter)(raw);
        const src = (0, fsx_js_1.nearestSource)(dir, root);
        items.push({
            kind: src ? 'saved' : 'yours',
            line: rel,
            id: rel,
            display: depth ? rel.slice(parentDir.length + 1) : rel,
            depth,
            parentDir,
            sourceId: src ? src.id : null,
            description: fm.description ?? '',
            origin: src ? `from ${src.id} (${src.taken})` : 'yours',
            checked: false,
        });
    };
    const walk = (prefix, depth) => {
        for (const c of localChildren(root, prefix)) {
            if (c.isSkill) {
                pushSkill(c.path, depth, prefix);
                continue;
            }
            let p = c.path;
            let name = c.name;
            let kids = localChildren(root, p);
            while (kids.length === 1 && !kids[0].isSkill) {
                name += `/${kids[0].name}`;
                p = kids[0].path;
                kids = localChildren(root, p);
            }
            const covered = (0, fsx_js_1.walkSkills)((0, fsx_js_1.safeJoin)(root, p));
            items.push({
                kind: 'dir',
                line: `${p}/`,
                id: `${p}/`,
                display: `${name}/`,
                depth,
                parentDir: prefix,
                children: covered.map((s) => `${p}/${s.rel}`),
                description: `${covered.length} skills — one line covers them all`,
                origin: 'directory',
                checked: false,
            });
            walk(p, depth + 1);
        }
    };
    walk('', 0);
    for (const e of (0, autotrigger_js_1.parseTriggers)(root)) {
        if (e.error) {
            items.push({ kind: 'error', id: e.line, line: e.line, display: e.line, depth: 0, description: e.error, origin: 'invalid', checked: false });
            continue;
        }
        if (!e.cloud)
            continue; // local lines are represented by the tree above
        const id = e.id;
        if (localPaths.has((0, ids_js_1.diskPath)(id))) {
            // CONFLICT surfaced, not hidden: a saved copy AND an @ line exist for
            // the same skill. The copy answers the line (local-first) — mark the
            // local row so the user sees the relation and can drop the line.
            const local = items.find((i) => i.line === (0, ids_js_1.diskPath)(id));
            if (local) {
                local.atLine = e.line;
                local.origin += ' · @ line answers to this copy';
            }
            continue;
        }
        items.push({
            kind: 'cloud',
            line: e.line,
            id,
            display: e.line,
            depth: 0,
            description: e.wholeDir ? 'every skill under this directory' : "follows the provider's latest",
            origin: id.startsWith('gh:') ? 'github · auto-updates' : 'hub · auto-updates',
            checked: false,
        });
    }
    for (const item of items)
        item.checked = isChecked(root, item);
    return items;
}
/** Longest ancestor prefix with a dir line — the closest cover. */
function coveringAncestor(root, relPath) {
    const segs = relPath.replace(/\/$/, '').split('/');
    for (let i = segs.length - 1; i >= 1; i--) {
        const prefix = segs.slice(0, i).join('/');
        if ((0, autotrigger_js_1.hasTriggerLine)(root, `${prefix}/`))
            return prefix;
    }
    return null;
}
/**
 * A plain line whose gitignore PATTERN matches rel (globs, negation) without
 * being an exact ancestor-dir line — same matcher resolution uses, so the
 * tree can never disagree with what actually loads.
 */
function coveringPattern(root, rel) {
    const entries = (0, autotrigger_js_1.parseTriggers)(root).filter((e) => !e.cloud && !e.error && e.line !== rel);
    if (entries.length === 0)
        return null;
    if (!ignore().add(entries.map((e) => e.pattern)).ignores(rel))
        return null;
    for (const e of entries) {
        if (ignore().add([e.pattern]).ignores(rel))
            return e.line;
    }
    return null;
}
function isChecked(root, item) {
    if (item.kind === 'dir') {
        if ((0, autotrigger_js_1.hasTriggerLine)(root, item.line))
            return 'direct';
        if (coveringAncestor(root, item.line))
            return 'via-dir';
        for (const e of (0, autotrigger_js_1.parseTriggers)(root)) {
            if (!e.cloud && !e.error && `${e.line}/`.startsWith(item.line))
                return 'partial';
        }
        return false;
    }
    if (item.kind === 'cloud')
        return (0, autotrigger_js_1.hasTriggerLine)(root, item.line) ? 'direct' : false;
    if ((0, autotrigger_js_1.hasTriggerLine)(root, item.line))
        return 'direct';
    if (item.atLine && (0, autotrigger_js_1.hasTriggerLine)(root, item.atLine))
        return 'direct'; // fires via its @ line
    if (coveringAncestor(root, item.line))
        return 'via-dir';
    if (coveringPattern(root, item.line))
        return 'via-dir'; // glob/negation lines cover too
    return false;
}
/**
 * SPLIT a covering dir line so everything under it stays on EXCEPT
 * targetPath: walking from the cover toward the target, each sibling branch
 * gets its own coarsest covering line.
 */
function splitCover(root, coverDir, targetPath) {
    (0, autotrigger_js_1.removeTriggerLine)(root, `${coverDir}/`);
    let cur = coverDir;
    const rest = targetPath.replace(/\/$/, '').slice(coverDir.length + 1).split('/');
    for (const seg of rest) {
        for (const c of localChildren(root, cur)) {
            if (c.name !== seg)
                (0, autotrigger_js_1.addTriggerLine)(root, coverLine(c));
        }
        cur = `${cur}/${seg}`;
    }
}
// NOTE: there is deliberately NO auto-collapse. Checking every child of a
// directory individually is NOT the same statement as checking the directory:
// a `dir/` line also covers skills added in the future. Only an explicit
// check of the directory node itself may write that line — never assume.
/**
 * The one toggle — filesystem-checkbox semantics at any depth. Returns a
 * note describing what was written (shown in the dialog's status row).
 */
function toggleTreeItem(root, itemId) {
    const items = collectTreeItems(root);
    // Dir rows are spelled with a trailing slash (their line). A typed
    // `/skills toggle team-flows` means the directory when no leaf answers.
    const item = items.find((i) => i.id === itemId) ?? items.find((i) => i.id === `${itemId}/`);
    if (!item)
        return `no row for '${itemId}' — the tree may have changed`;
    if (item.kind === 'error')
        return 'fix or remove this line in .autotrigger';
    if (item.kind === 'cloud') {
        if ((0, autotrigger_js_1.hasTriggerLine)(root, item.line)) {
            (0, autotrigger_js_1.removeTriggerLine)(root, item.line);
            return `removed: ${item.line}`;
        }
        (0, autotrigger_js_1.addTriggerLine)(root, item.line);
        return `added: ${item.line}`;
    }
    const rel = item.kind === 'dir' ? item.line.replace(/\/$/, '') : item.line;
    const state = item.checked;
    if (state === 'via-dir') {
        // a glob/negation pattern can't be split mechanically — point at the line
        if (!coveringAncestor(root, rel)) {
            const p = coveringPattern(root, rel);
            return `covered by pattern "${p}" — edit .autotrigger to change this`;
        }
        // uncheck under a cover: split every covering ancestor, closest first
        let guard = 0;
        let last = null;
        while (guard++ < 32) {
            const cover = coveringAncestor(root, rel);
            if (!cover)
                break;
            splitCover(root, cover, rel);
            last = cover;
        }
        return `split ${last}/ — unchecked ${item.display}, siblings stay on`;
    }
    if (item.kind === 'dir') {
        if (state === 'direct') {
            (0, autotrigger_js_1.removeTriggerLine)(root, item.line);
            return `removed: ${item.line}`;
        }
        // adding the dir line covers the whole subtree — clean descendant lines
        for (const e of (0, autotrigger_js_1.parseTriggers)(root)) {
            if (!e.cloud && !e.error && `${e.line}/`.startsWith(item.line))
                (0, autotrigger_js_1.removeTriggerLine)(root, e.line);
        }
        (0, autotrigger_js_1.addTriggerLine)(root, item.line);
        return `added: ${item.line} (covers ${(item.children ?? []).length} skills, present and future)`;
    }
    // local leaf
    if (state === 'direct') {
        if ((0, autotrigger_js_1.hasTriggerLine)(root, item.line)) {
            (0, autotrigger_js_1.removeTriggerLine)(root, item.line);
            return `removed: ${item.line}`;
        }
        if (item.atLine && (0, autotrigger_js_1.hasTriggerLine)(root, item.atLine)) {
            (0, autotrigger_js_1.removeTriggerLine)(root, item.atLine);
            return `removed @ line ${item.atLine} — your saved copy was answering it`;
        }
        return 'nothing to remove';
    }
    // checking a leaf writes that leaf's line, nothing more — even if it's the
    // last unchecked child, we never promote to a dir/ line on our own
    (0, autotrigger_js_1.addTriggerLine)(root, item.line);
    return `added: ${item.line}`;
}
/** The checkbox a state renders as — shared vocabulary with the reference. */
function checkboxFor(state) {
    return state === 'direct' ? '[x]' : state === 'via-dir' ? '[#]' : state === 'partial' ? '[~]' : '[ ]';
}
