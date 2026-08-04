// atskills — the @skills console (OpenTUI, Bun runtime).
//
// The app IS a protocol client. You type the same gestures an agent uses:
//
//   @skills:<path>            use — the skill body (or a directory menu) prints
//   @skills:<path>:save       own a copy (vendored + .source; save = adapt + detach)
//   @skills:<path>:install    a line in .autotrigger (install = a line, nothing more)
//   /skills                   the management tree — checkboxes write .autotrigger
//   /prompt                   the exact injected text, with the read trail
//   /help  /quit
//
// No state of its own — every action writes the same files a hand edit would.
// The plumbing lives in ../lib; this file is only the surface.

import React, { useCallback, useMemo, useState } from 'react';
import { createCliRenderer } from '@opentui/core';
import type { KeyEvent } from '@opentui/core';
// @ts-expect-error - moduleResolution quirks in @opentui/react exports
import { createRoot, AppContext, useKeyboard } from '@opentui/react';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const lib = require('../dist/index.js');

const GREEN = '#22c55e';
const YELLOW = '#eab308';
const GRAY = '#8b949e';
const BLUE = '#58a6ff';
const RED = '#ef4444';

type Block = { kind: 'cmd' | 'text' | 'ref' | 'note' | 'error' | 'inject'; text: string };
type Item = ReturnType<typeof lib.collectTreeItems>[number];

const HELP = [
  '@skills:<path>            use a skill — body prints here (a directory prints a menu)',
  '@skills:<path>:save       own a copy — vendored at its path + .source (save = adapt + detach)',
  '@skills:<path>:install    auto-trigger it — a line in .autotrigger (install = a line)',
  '/skills                   view local skills · manage auto-trigger (local + cloud); enter there = view prompt',
  '/quit                     leave',
  '',
  'tab completes · up/down pick a suggestion · paths you browse join the autocomplete',
  'try: @skills:gh:anthropics/skills/skills     @skills:gh:sylphai-inc/skills/skills',
  '     @skills:gh:vercel-labs/agent-skills     @skills:gh:obra/superpowers/skills',
].join('\n');

const SLASH_COMMANDS = ['/skills', '/help', '/quit'];

type Suggestion = { label: string; next: string; where?: string };

// THE AUTOCOMPLETE RULE (mirrored in the design doc, §2) — kept simple:
// `@skills:` completes ONLY what the project already knows —
//   1. its LOCAL skills (.atskills/, yours and saved)
//   2. its AUTO-TRIGGER skills (cloud IDs from .autotrigger)
// plus the suffix grammar (:save/:install) once a full path is typed, and
// slash commands when the line starts with '/'. Anything else, you type or
// paste (GitHub URLs work) — discovery is the hub's job, not the input box's.
function suggestionsFor(
  input: string,
  sources: { local: string[]; autotrig: string[] }
): Suggestion[] {
  if (input.startsWith('/')) {
    return SLASH_COMMANDS.filter((c) => c.startsWith(input) && c !== input).map((c) => ({ label: c, next: c }));
  }
  const m = /(^|\s)(@skills:|skills:|@)([^\s]*)$/.exec(input);
  if (!m) return [];
  const head = input.slice(0, (m.index ?? 0) + m[1].length);
  const partial = m[3].toLowerCase();
  // '@', '@s', … '@skills' all complete to the canonical '@skills:' token.
  if (m[2] === '@' && (partial === '' || 'skills:'.startsWith(partial) || partial === 'skills'))
    return [{ label: '@skills:', next: head + '@skills:' }];

  if (/^[^\s:]+(:[^\s:]+)*:$/.test(partial)) {
    const base = partial.replace(/:$/, '');
    return ['save', 'install', 'save:install']
      .filter((s) => !base.endsWith(s))
      .map((s) => ({ label: `:${s}`, next: `${head}@skills:${base}:${s}` }));
  }

  const candidates = [...new Set([...sources.local.sort(), ...sources.autotrig.sort()])];
  // No cap — the renderer windows the list; up/down reaches everything.
  return candidates
    .filter((c) => c.toLowerCase().startsWith(partial) && c.toLowerCase() !== partial)
    .map((c) => ({ label: c, next: `${head}@skills:${c}` }));
}

function App({ root, onExit, keyHandler, renderer }: { root: string; onExit: () => void; keyHandler: any; renderer: any }) {
  const [view, setView] = useState<'main' | 'skills' | 'prompt'>('main');
  const [log, setLog] = useState<Block[]>([
    { kind: 'note', text: 'atskills — the @skills console. /help for commands.' },
    {
      kind: 'text',
      text:
        'autocomplete: type @skills: and tab — it offers this project\'s local\n' +
        'skills and its auto-trigger skills, nothing else. For the world, type or\n' +
        'paste a path (GitHub URLs work): try @skills:gh:anthropics/skills/skills',
    },
  ]);
  // The input is OpenTUI's native single-line <input> — it owns cursor
  // movement, editing, and paste. We mirror its value for autocomplete and
  // push completions back through the ref.
  const inputRef = React.useRef<any>(null);
  const [input, setInputText] = useState('');
  const setInput = (v: string) => {
    setInputText(v);
    if (inputRef.current) inputRef.current.value = v;
  };
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false); // /skills install input open?
  const addInputRef = React.useRef<any>(null);
  const [prompt, setPrompt] = useState<any>(null);
  const [knownIds, setKnownIds] = useState<string[]>([]);
  const [compIdx, setCompIdx] = useState(0);

  const push = (...blocks: Block[]) => setLog((l) => [...l, ...blocks]);
  const refresh = () => setTick((t) => t + 1);

  const resolverOpts = useMemo(
    () => ({ workingDir: path.dirname(root), cacheDir: process.env.ATSKILLS_CACHE || undefined }),
    [root],
  );
  const items: Item[] = useMemo(() => {
    try {
      return lib.collectTreeItems(root);
    } catch (err: any) {
      return [{ kind: 'error', id: 'error', line: 'error', display: 'tree error', depth: 0, description: String(err.message), origin: 'invalid', checked: false }];
    }
  }, [root, tick]);
  const suggestions = useMemo(() => {
    // The autocomplete rule: local skills, then auto-trigger skills. Nothing else.
    const local = items
      .filter((i: Item) => i.kind === 'yours' || i.kind === 'saved')
      .flatMap((i: Item) => [i.id, i.sourceId].filter(Boolean)) as string[];
    const autotrig = items.filter((i: Item) => i.kind === 'cloud').map((i: Item) => i.id) as string[];
    // Annotate each path suggestion with where it already lives — the project
    // folder, or the global cache (already downloaded by render time).
    return suggestionsFor(input, { local, autotrig }).map((s) => {
      if (s.label.startsWith(':') || s.label.startsWith('/') || s.label === '@skills:' || s.label === 'gh:') return s;
      try {
        const id = lib.normalizeId(s.label);
        const local = path.join(root, lib.diskPath(id));
        if (fs.existsSync(local)) return { ...s, where: path.join('.atskills', lib.diskPath(id)) };
        const cached = path.join(
          process.env.ATSKILLS_CACHE || lib.DEFAULT_CACHE_DIR,
          lib.diskPath(id),
        );
        if (fs.existsSync(cached)) return { ...s, where: 'cached · ' + cached.replace(os.homedir(), '~') };
        return { ...s, where: 'not fetched yet' };
      } catch {
        return s;
      }
    });
  }, [input, items, tick]);

  // Paste is handled natively by the <input> renderable (handlePaste);
  // bracketed paste mode is enabled at startup in main().

  // Copy-out: drag-select any `selectable` text; the selection auto-copies
  // to the clipboard (debounced), like adal's console.
  React.useEffect(() => {
    if (!renderer?.on) return;
    let t: any = null;
    const onSel = (sel: any) => {
      const txt = sel?.getSelectedText?.();
      if (!txt || !txt.trim()) return;
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          const { spawnSync } = require('node:child_process');
          if (process.platform === 'darwin') spawnSync('pbcopy', [], { input: txt });
          else spawnSync('xclip', ['-selection', 'clipboard'], { input: txt });
          push({ kind: 'note', text: `copied ${txt.length} chars` });
        } catch {}
      }, 250);
    };
    renderer.on('selection', onSel);
    return () => {
      renderer.off?.('selection', onSel);
      clearTimeout(t);
    };
  }, [renderer]);
  const cursor = Math.max(0, items.findIndex((i: Item) => i.id === selectedId));
  const current = items[Math.min(cursor, Math.max(0, items.length - 1))];
  const move = (delta: number) => {
    if (!items.length) return;
    setSelectedId(items[(cursor + delta + items.length) % items.length].id);
  };

  // install = a line in .autotrigger — typed straight into the dialog.
  // Cloud IDs (or pasted GitHub URLs) become @ lines; existing local paths
  // become plain lines; a trailing / keeps directory coverage.
  const addTriggerLine = (raw: string): string => {
    const wholeDir = /\/\s*$/.test(raw.trim());
    const id = lib.normalizeId(raw.trim().replace(/^@/, ''));
    const local = fs.existsSync(path.join(root, lib.diskPath(id)));
    const line = (local ? lib.diskPath(id) : '@' + id) + (wholeDir ? '/' : '');
    return lib.addTriggerLine(root, line)
      ? `installed = added one line: ${line}`
      : `already installed: ${line}`;
  };

  const installLine = (id: string) =>
    fs.existsSync(path.join(root, lib.diskPath(id))) ? lib.diskPath(id) : '@' + id;

  const handleRef = useCallback(
    async (ref: string) => {
      const { id, save: doSave, install: doInstall } = lib.parseReference(ref);
      // Using is reading — a suffixed reference still injects its content;
      // :save / :install are actions IN ADDITION to the read, shown after it.
      const res = await lib.resolveSkill(id, false, resolverOpts);
      if (!res.success) {
        push({ kind: 'error', text: res.error || `nothing at ${id}` });
        return;
      }
      if (res.kind === 'skill') {
        const isLocal = res.source === 'local';
        const skillDir = path.dirname(res.path);
        const stamp = isLocal ? lib.nearestSource(skillDir, root) : null;
        // The badge shows a LOCAL path — cloud copies live in the cache tree.
        const ref2 =
          isLocal
            ? path.join('.atskills', path.relative(root, skillDir), 'SKILL.md') +
              (stamp ? `  (saved from ${stamp.id}, ${stamp.taken})` : '')
            : `${String(res.path).replace(os.homedir(), '~')} (cloud·${res.served || 'fresh'})  ·  review: ${res.reviewUrl || lib.webUrl(id)}`;
        // What prints below is EXACTLY what an agent injects as the user
        // query for this @ reference: content with numbered lines, plus a
        // listing of the skill's bundled files (discoverable, not preloaded).
        const numbered = res.content
          .trimEnd()
          .split('\n')
          .map((l: string, i: number) => `${i + 1}|${l}`)
          .join('\n');
        const bundled: string[] = (res.files || []).filter((f: string) => f !== 'SKILL.md' && !f.startsWith('.'));
        // The agent works on LOCAL paths — the injection carries them, so the
        // file (and its bundled siblings) can be re-read on demand.
        const localFile =
          isLocal
            ? path.join('.atskills', path.relative(root, skillDir), 'SKILL.md')
            : String(res.path).replace(os.homedir(), '~');
        const localDir = path.dirname(localFile);
        // Display first — the badges the user sees on the message…
        push({ kind: 'ref', text: `⎿ read ${ref2} (${res.content.trimEnd().split('\n').length} lines)` });
        if (bundled.length) push({ kind: 'ref', text: `⎿ listed directory ${localDir}/ (${bundled.length + 1} items)` });
        // …then what is actually sent to the model as the user query.
        push({ kind: 'inject', text: `Content from @skills:${id} (${localFile}):\n${numbered}` });
        if (bundled.length) {
          push({
            kind: 'inject',
            text: `Dir: ${localDir}/\nListed files/directories inside:\n` + bundled.map((f) => `  - ${f}`).join('\n'),
          });
        }
      } else {
        // A directory reference injects a menu — one line per skill, every
        // line itself a valid path. This block is the injection, verbatim.
        setKnownIds((k) => [...new Set([...k, id, ...res.entries.map((e: any) => e.id)])]);
        const menuLocal = res.source === 'local';
        const dirShown =
          menuLocal
            ? path.join('.atskills', lib.diskPath(id))
            : String(res.dir || id).replace(os.homedir(), '~');
        push(
          { kind: 'ref', text: `⎿ read skills directory ${dirShown}/ (${res.entries.length} skills)${menuLocal ? '' : ` (cloud)  ·  review: ${res.reviewUrl || lib.webUrl(id)}`}` },
          {
            kind: 'inject' as const,
            // The combination of the lists: one index line per child skill,
            // same shape as the skills prompt — name: description (path).
            text:
              `Content from @skills:${id}/ (skills index — read a path for the full skill):\n` +
              res.entries
                .map(
                  (e: any) =>
                    `- ${e.name}: ${e.description} (${String(e.path || e.id).replace(os.homedir(), '~')}${
                      e.bundle && e.bundle.length ? ' · dir: ' + e.bundle.join(', ') : ''
                    })`
                )
                .join('\n'),
          }
        );
      }
      if (doSave) {
        try {
          const r = await lib.saveSkillToProject(id, resolverOpts);
          if (!r.success) throw new Error(r.error || `could not save ${id}`);
          const dest = path.join(root, lib.diskPath(id));
          const stamp2 = lib.nearestSource(dest, root);
          push({ kind: 'note', text: `saved: .atskills/${lib.diskPath(id)}/ — yours now, detached${stamp2 ? ` (rev ${String(stamp2.revision).slice(0, 7)})` : ''}` });
          const executables = lib.listFiles(dest).filter((f: string) => {
            try { return (fs.statSync(path.join(dest, f)).mode & 0o111) !== 0; } catch { return false; }
          });
          if (executables.length) push({ kind: 'note', text: `bundled executables (review before running): ${executables.join(', ')}` });
          if (lib.hasTriggerLine(root, '@' + id)) {
            lib.removeTriggerLine(root, '@' + id);
            lib.addTriggerLine(root, lib.diskPath(id));
            push({ kind: 'note', text: `flipped the @ line to plain — the file reads true` });
          }
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        }
      }
      if (doInstall) {
        const line = installLine(id);
        if (lib.addTriggerLine(root, line)) push({ kind: 'note', text: `installed = added one line to .autotrigger: ${line}` });
        else push({ kind: 'note', text: `already installed: ${line}` });
      }
      if (doSave || doInstall) refresh();
    },
    [root, resolverOpts]
  );

  const showPrompt = useCallback(async () => {
    const notes: string[] = [];
    const text = await lib.buildAutotriggerIndex({
      workingDir: path.dirname(root),
      log: { info: () => {}, warn: (m: string) => notes.push(m) },
    });
    setPrompt({ text, tokens: Math.ceil(text.length / 4), notes });
    setView('prompt');
  }, [root]);

  const submit = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      push({ kind: 'cmd', text: `› ${line}` });
      if (line === '/quit' || line === '/exit') return onExit();
      if (line === '/help') return push({ kind: 'text', text: HELP });
      if (line === '/skills') return setView('skills');
      if (line.startsWith('/')) return push({ kind: 'error', text: `unknown command: ${line} — /help` });

      const refs = line.match(/@?skills:\S+/g) || [line];
      setBusy(true);
      for (const r of refs) {
        try {
          await handleRef(r);
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        }
      }
      setBusy(false);
    },
    [handleRef, onExit]
  );

  useKeyboard(
    useCallback(
      async (key: KeyEvent) => {
        // The prompt view lives inside /skills — any key returns to the tree.
        if (view === 'prompt') {
          if (!busy) setView('skills');
          return;
        }
        if (busy && view !== 'main') return;

        if (view === 'skills') {
          if (adding) {
            if (key.name === 'escape') setAdding(false);
            return; // the install input owns every other key
          }
          if (key.name === 'q' || key.name === 'escape') { setView('main'); setNote(''); return; }
          if (key.name === 'a' || key.name === 'i' || key.name === 'tab') { setAdding(true); return; }
          if (key.name === 'up' || key.name === 'k') move(-1);
          else if (key.name === 'down' || key.name === 'j') move(1);
          else if (key.name === 'space' && current) {
            setNote(lib.toggleTreeItem(root, current.id));
            refresh();
          } else if (key.name === 'return') await showPrompt();
          return;
        }

        // main view — the native <input> owns editing (cursor, arrows within
        // the line, paste). Here: only completion, suggestion picking, exit.
        if (key.name === 'tab') {
          key.preventDefault?.();
          const s = suggestions[Math.min(compIdx, suggestions.length - 1)];
          if (s) {
            setInput(s.next);
            setCompIdx(0);
          }
          return;
        }
        if (key.name === 'up' && suggestions.length) return setCompIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        if (key.name === 'down' && suggestions.length) return setCompIdx((i) => (i + 1) % suggestions.length);
        if (key.name === 'escape') return setInput('');
        if (key.ctrl && key.name === 'c') return onExit();
      },
      [busy, view, current, items, root, submit, showPrompt, onExit, suggestions, compIdx, adding]
    )
  );

  if (view === 'prompt' && prompt) {
    return (
      <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
        <box borderStyle="single" style={{ borderColor: GRAY, flexDirection: 'column', flexGrow: 1, padding: 1 }}>
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <text fg={GREEN}>view prompt</text>
          <text fg={GRAY}>the index prompt auto-trigger makes resident (~{prompt.tokens} tokens)</text>
        </box>
        <scrollbox focused style={{ flexGrow: 1, marginTop: 1 }}>
          <box style={{ flexDirection: 'column' }}>
            <text>{prompt.text.trim() ? prompt.text.trimEnd() : '(nothing auto-triggers — the prompt is empty)'}</text>
            <text> </text>
            {prompt.notes.length > 0 && <text fg={BLUE}>problems:</text>}
            {prompt.notes.map((n: string, i: number) => (
              <text key={i} fg={YELLOW}>✗ {n}</text>
            ))}
          </box>
        </scrollbox>
        <box style={{ flexShrink: 0 }}>
          <text fg={GRAY}>any key to go back</text>
        </box>
        </box>
      </box>
    );
  }

  if (view === 'skills') {
    return (
      <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
        <box borderStyle="single" style={{ borderColor: GRAY, flexDirection: 'column', flexGrow: 1, padding: 1 }}>
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          <text>
            <span fg={GREEN}><b>/skills</b></span>
            <span fg={GRAY}> — view local skills · manage auto-trigger for local and cloud (writes .atskills/.autotrigger)</span>
          </text>
          <text> </text>
        </box>
        <scrollbox focused={false} style={{ flexGrow: 1 }}>
          <box style={{ flexDirection: 'column' }}>
            {items.length === 0 && <text fg={GRAY}>  nothing yet — save or install something from the console first</text>}
            {items.map((item: Item, i: number) => {
              const checked: any = item.checked;
              const box_ = lib.checkboxFor(checked);
              const cur = i === cursor;
              // filesystem-tree glyphs for children of a directory node
              const isLast = !(items[i + 1] && (items[i + 1] as any).parentDir === item.parentDir);
              const glyph = item.depth ? (isLast ? ' └ ' : ' ├ ') : '';
              const shown = String(item.display ?? item.label);
              return (
                <box key={item.id} style={{ flexDirection: 'column' }}>
                  <text>
                    <span fg={cur ? BLUE : GRAY}>{cur ? '> ' : '  '}</span>
                    <span fg={GRAY}>{glyph}</span>
                    <span fg={checked ? GREEN : GRAY}>{box_}</span>
                    <span> {shown.padEnd(44 - glyph.length)} </span>
                    <span fg={item.kind === 'cloud' ? YELLOW : GRAY}>{item.origin}</span>
                  </text>
                  {cur && item.description ? <text fg={GRAY}>{'      ' + String(item.description).slice(0, 100)}</text> : null}
                </box>
              );
            })}
          </box>
        </scrollbox>
        <box style={{ flexDirection: 'column', flexShrink: 0 }}>
          {note ? <text fg={YELLOW}>{note}</text> : <text> </text>}
          <box borderStyle="single" style={{ borderColor: adding ? GREEN : GRAY, paddingLeft: 1, paddingRight: 1, flexDirection: 'row', flexShrink: 0 }}>
            <text fg={adding ? GREEN : GRAY}>install › </text>
            <input
              ref={addInputRef}
              focused={adding}
              placeholder="gh:owner/repo/path · hub: owner/skill (atskills.one) · trailing / = whole directory"
              onSubmit={(v: string) => {
                if (!v.trim()) return setAdding(false);
                try {
                  setNote(addTriggerLine(v));
                } catch (err: any) {
                  setNote(`invalid path: ${err.message}`);
                }
                if (addInputRef.current) addInputRef.current.value = '';
                setAdding(false);
                refresh();
              }}
              style={{ flexGrow: 1 }}
            />
          </box>
          {adding ? (
            <text fg={GRAY}>enter install · esc back to the tree</text>
          ) : (
            <text fg={GRAY}>tab/a type in the install box · up/down move · space toggle · enter view prompt · esc back</text>
          )}
        </box>
        </box>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <box style={{ flexDirection: 'column', flexShrink: 0 }}>
        <text>
          <span fg={GREEN}><b>atskills</b></span>
          <span fg={GRAY}> — @skills:&lt;path&gt; to use · :save to own · :install to auto-trigger · /skills · /help</span>
        </text>
      </box>
      <scrollbox focused stickyScroll stickyStart="bottom" style={{ flexGrow: 1, marginTop: 1 }}>
        <box style={{ flexDirection: 'column' }}>
          {(() => {
            // Injected-prompt blocks render inside a bounding box so the
            // display/injection split is unmistakable.
            const grouped: Array<Block | { kind: 'inject-group' | 'display-group'; blocks: Block[] }> = [];
            for (const b of log) {
              const last = grouped[grouped.length - 1] as any;
              if (b.kind === 'inject' && last && last.kind === 'inject-group') last.blocks.push(b);
              else if (b.kind === 'inject') grouped.push({ kind: 'inject-group', blocks: [b] });
              else if (b.kind === 'cmd') grouped.push({ kind: 'display-group', blocks: [b] });
              else if (b.kind === 'ref' && last && last.kind === 'display-group') last.blocks.push(b);
              else grouped.push(b);
            }
            return grouped.map((g: any, i: number) =>
              g.kind === 'display-group' ? (
                <box key={i} borderStyle="single" style={{ borderColor: BLUE, flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
                  <text fg={BLUE}>[display]</text>
                  {g.blocks.map((b: Block, j: number) => (
                    <text key={j} selectable fg={b.kind === 'cmd' ? BLUE : GRAY}>{b.text}</text>
                  ))}
                </box>
              ) : g.kind === 'inject-group' ? (
                <box key={i} borderStyle="single" style={{ borderColor: GREEN, flexDirection: 'column', paddingLeft: 1, paddingRight: 1 }}>
                  <text fg={GREEN}>[injected as the user query]</text>
                  {g.blocks.map((b: Block, j: number) => (
                    <text key={j} selectable>{b.text}</text>
                  ))}
                </box>
              ) : (
                <text
                  key={i}
                  selectable
                  fg={g.kind === 'cmd' ? BLUE : g.kind === 'ref' ? GRAY : g.kind === 'note' ? GREEN : g.kind === 'error' ? RED : undefined}
                >
                  {g.kind === 'error' ? '✗ ' + g.text : g.text}
                </text>
              )
            );
          })()}
        </box>
      </scrollbox>
      {suggestions.length > 0 && (() => {
        // Window the list around the picked entry — up/down scrolls through
        // every candidate, indicators show what's off-screen.
        const MAX = 10;
        const start = Math.max(0, Math.min(compIdx - Math.floor(MAX / 2), suggestions.length - MAX));
        const shown = suggestions.slice(start, start + MAX);
        return (
          <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 2 }}>
            {start > 0 && <text fg={GRAY}>  ↑ {start} more</text>}
            {shown.map((s, j) => {
              const i = start + j;
              return (
                <text key={s.label}>
                  <span fg={i === compIdx ? BLUE : GRAY}>{(i === compIdx ? '› ' : '  ') + s.label}</span>
                  {s.where ? <span fg={GRAY}>{'   ' + s.where}</span> : null}
                </text>
              );
            })}
            {start + MAX < suggestions.length && <text fg={GRAY}>  ↓ {suggestions.length - start - MAX} more</text>}
          </box>
        );
      })()}
      <box borderStyle="single" style={{ flexShrink: 0, borderColor: GRAY, paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }}>
        <text fg={GREEN}>› </text>
        <input
          ref={inputRef}
          focused={view === 'main'}
          placeholder="@skills:<path> · /skills · /help"
          onInput={(v: string) => {
            setInputText(v);
            setCompIdx(0);
          }}
          onSubmit={(v: string) => {
            if (busy || !v.trim()) return;
            setInput('');
            setCompIdx(0);
            void submit(v);
          }}
          style={{ flexGrow: 1 }}
        />
        {busy ? <text fg={YELLOW}> …working</text> : null}
      </box>
      <box style={{ flexShrink: 0 }}>
        <text fg={GRAY}>{suggestions.length ? 'tab complete · up/down pick · enter run' : 'enter run · /help'}</text>
      </box>
    </box>
  );
}

async function main() {
  const root = lib.findAtskills(process.cwd());
  if (!root) {
    console.error('no .atskills/ found here or above — create one: mkdir .atskills');
    process.exit(1);
  }
  const renderer = await createCliRenderer({ fps: 30 });
  const reactRoot = createRoot(renderer);
  // Bracketed paste is a terminal mode the APP must enable (adal does the
  // same via useBracketedPaste) — without it, Cmd+V never reaches the input.
  process.stdout.write('\x1b[?2004h');
  const disablePaste = () => process.stdout.write('\x1b[?2004l');
  process.on('exit', disablePaste);
  const onExit = () => {
    try {
      disablePaste();
      (renderer as any).disableMouse?.();
      renderer.destroy();
    } catch {}
    process.exit(0);
  };
  reactRoot.render(
    <AppContext.Provider value={{ renderer, keyHandler: (renderer as any).keyInput }}>
      <App root={root} onExit={onExit} keyHandler={(renderer as any).keyInput} renderer={renderer} />
    </AppContext.Provider>
  );
}

main();
