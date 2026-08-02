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
const lib = require('../lib/index.js');

const GREEN = '#22c55e';
const YELLOW = '#eab308';
const GRAY = '#8b949e';
const BLUE = '#58a6ff';
const RED = '#ef4444';

type Block = { kind: 'cmd' | 'text' | 'ref' | 'note' | 'error'; text: string };
type Item = ReturnType<typeof lib.ui.collectItems>[number];

const HELP = [
  '@skills:<path>            use a skill — body prints here (a directory prints a menu)',
  '@skills:<path>:save       own a copy — vendored at its path + .source (save = adapt + detach)',
  '@skills:<path>:install    auto-trigger it — a line in .autotrigger (install = a line)',
  '/skills                   manage — checkbox dialog over .autotrigger; enter there = view prompt',
  '/quit                     leave',
  '',
  'tab completes · up/down pick a suggestion · paths you browse join the autocomplete',
  'try: @skills:gh:anthropics/skills/skills   ·   @skills:gh:sylphai-inc/skills/skills',
].join('\n');

const SLASH_COMMANDS = ['/skills', '/help', '/quit'];

type Suggestion = { label: string; next: string; where?: string };

// Autocomplete: slash commands when the line starts with '/', and skill paths
// behind the trailing '@' / '@skills:' token — candidates are the project's
// own skills, cloud IDs learned from menus this session, and the suffix
// grammar once a full path is typed.
function suggestionsFor(input: string, ids: string[], known: string[]): Suggestion[] {
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

  const candidates = [...new Set([...ids, ...known, 'gh:'])];
  return candidates
    .filter((c) => c.toLowerCase().startsWith(partial) && c.toLowerCase() !== partial)
    .sort()
    .slice(0, 6)
    .map((c) => ({ label: c, next: `${head}@skills:${c}` }));
}

function App({ cache, root, onExit, keyHandler, renderer }: { cache: any; root: string; onExit: () => void; keyHandler: any; renderer: any }) {
  const [view, setView] = useState<'main' | 'skills' | 'prompt'>('main');
  const [log, setLog] = useState<Block[]>([
    { kind: 'note', text: 'atskills — the @skills console. /help for commands.' },
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
  const [prompt, setPrompt] = useState<any>(null);
  const [knownIds, setKnownIds] = useState<string[]>([]);
  const [compIdx, setCompIdx] = useState(0);

  const push = (...blocks: Block[]) => setLog((l) => [...l, ...blocks]);
  const refresh = () => setTick((t) => t + 1);

  const items: Item[] = useMemo(() => lib.ui.collectItems(root), [root, tick]);
  const suggestions = useMemo(() => {
    const ids = items.flatMap((i: Item) => [i.id, i.sourceId].filter(Boolean)) as string[];
    // Annotate each path suggestion with where it already lives — the project
    // folder, or the global cache (already downloaded by render time).
    return suggestionsFor(input, ids, knownIds).map((s) => {
      if (s.label.startsWith(':') || s.label.startsWith('/') || s.label === '@skills:' || s.label === 'gh:') return s;
      try {
        const id = lib.normalizeId(s.label);
        const local = path.join(root, lib.diskPath(id));
        if (fs.existsSync(local)) return { ...s, where: path.join('.atskills', lib.diskPath(id)) };
        const loc = cache.location?.(lib.sources.skillUrl(id));
        if (loc) return { ...s, where: 'cached · ' + loc.replace(os.homedir(), '~').replace(/\/body$/, '') };
        return { ...s, where: 'not fetched yet' };
      } catch {
        return s;
      }
    });
  }, [input, items, knownIds, tick]);

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

  const installLine = (id: string) =>
    fs.existsSync(path.join(root, lib.diskPath(id))) ? lib.diskPath(id) : '@' + id;

  const handleRef = useCallback(
    async (ref: string) => {
      const { id, save: doSave, install: doInstall } = lib.parseReference(ref);
      if (doSave) {
        try {
          const r = await lib.save(cache, id, root);
          push({ kind: 'note', text: `${r.action}: .atskills/${lib.diskPath(id)}/ — yours now, detached (rev ${r.revision})` });
          if (r.executables.length) push({ kind: 'note', text: `bundled executables (review before running): ${r.executables.join(', ')}` });
          if (lib.autotrigger.hasLine(root, '@' + id)) {
            lib.autotrigger.removeLine(root, '@' + id);
            lib.autotrigger.addLine(root, lib.diskPath(id));
            push({ kind: 'note', text: `flipped the @ line to plain — the file reads true` });
          }
        } catch (err: any) {
          push({ kind: 'error', text: err.message });
        }
      }
      if (doInstall) {
        const line = installLine(id);
        if (lib.autotrigger.addLine(root, line)) push({ kind: 'note', text: `installed = added one line to .autotrigger: ${line}` });
        else push({ kind: 'note', text: `already installed: ${line}` });
      }
      if (doSave || doInstall) {
        refresh();
        return;
      }
      const res = await lib.resolve(cache, id, root);
      if (res.kind === 'skill') {
        // The badge shows a LOCAL path — cloud copies live in the cache tree.
        const ref2 =
          res.where === 'local'
            ? path.join('.atskills', path.relative(root, res.dir), 'SKILL.md') +
              (res.source ? `  (saved from ${res.source.id}, ${res.source.taken})` : '')
            : `${String(res.cachePath || res.url).replace(os.homedir(), '~')} (cloud·${res.status})`;
        // What prints below is EXACTLY what an agent injects as the user
        // query for this @ reference: content with numbered lines, plus a
        // listing of the skill's bundled files (discoverable, not preloaded).
        const numbered = res.text
          .trimEnd()
          .split('\n')
          .map((l: string, i: number) => `${i + 1}|${l}`)
          .join('\n');
        let bundled: string[] = [];
        try {
          if (res.where === 'local') {
            const walk = (d: string, rel: string): string[] =>
              fs.readdirSync(d, { withFileTypes: true }).flatMap((e: any) => {
                if (e.name.startsWith('.')) return [];
                const r = rel ? `${rel}/${e.name}` : e.name;
                return e.isDirectory() ? walk(path.join(d, e.name), r) : [r];
              });
            bundled = walk(res.dir, '').filter((f: string) => f !== 'SKILL.md');
          } else if (id.startsWith('gh:')) {
            bundled = (await lib.sources.listGhFiles(cache, id)).filter((f: string) => f !== 'SKILL.md');
          }
        } catch {
          bundled = [];
        }
        // Display first — the badges the user sees on the message…
        push({ kind: 'ref', text: `⎿ read ${ref2} (${res.text.trimEnd().split('\n').length} lines)` });
        if (bundled.length) push({ kind: 'ref', text: `⎿ listed directory ${id}/ (${bundled.length + 1} items)` });
        // …then what is actually sent to the model as the user query.
        push({ kind: 'note', text: '[injected as the user query:]' });
        push({ kind: 'text', text: `Content from @skills:${id}:\n${numbered}` });
        if (bundled.length) {
          push({
            kind: 'text',
            text: `Dir: ${id}/\nListed files/directories inside:\n` + bundled.map((f) => `  - ${f}`).join('\n'),
          });
        }
      } else {
        // A directory reference injects a menu — one line per skill, every
        // line itself a valid path. This block is the injection, verbatim.
        setKnownIds((k) => [...new Set([...k, id, ...res.entries.map((e: any) => e.id)])]);
        const dirShown =
          res.where === 'local'
            ? path.join('.atskills', lib.diskPath(id))
            : String(res.cacheDir || id).replace(os.homedir(), '~');
        push(
          { kind: 'ref', text: `⎿ read skills directory ${dirShown}/ (${res.entries.length} skills)${res.where === 'local' ? '' : ' (cloud)'}` },
          { kind: 'note', text: '[injected as the user query:]' },
          {
            kind: 'text',
            // The combination of the lists: one index line per child skill,
            // same shape as the skills prompt — name: description (path).
            text:
              `Content from @skills:${id}/ (skills index — read a path for the full skill):\n` +
              res.entries
                .map((e: any) => `- ${e.name}: ${e.description} (${String(e.file || e.id).replace(os.homedir(), '~')})`)
                .join('\n'),
          }
        );
      }
    },
    [cache, root]
  );

  const showPrompt = useCallback(async () => {
    setPrompt(await lib.buildPrompt(cache, root));
    setView('prompt');
  }, [cache, root]);

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
          if (key.name === 'q' || key.name === 'escape') { setView('main'); setNote(''); return; }
          if (key.name === 'up' || key.name === 'k') move(-1);
          else if (key.name === 'down' || key.name === 'j') move(1);
          else if (key.name === 'space' && current) {
            if (current.kind === 'error') setNote('fix or remove this line in .autotrigger');
            else {
              const checked = lib.ui.isChecked(root, current);
              if (checked === 'via-dir') setNote('covered by a directory line — uncheck that line instead');
              else if (checked === 'direct') { lib.autotrigger.removeLine(root, current.line); setNote(`removed: ${current.line}`); }
              else { lib.autotrigger.addLine(root, current.line); setNote(`added: ${current.line}`); }
              refresh();
            }
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
      [busy, view, current, items, root, submit, showPrompt, onExit, suggestions, compIdx]
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
            <text fg={BLUE}>read from:</text>
            {prompt.sections.map((s: any, i: number) =>
              s.error ? (
                <text key={i} fg={YELLOW}>✗ {s.line} {s.error}</text>
              ) : (
                <text key={i} fg={GRAY}>⎿ read {s.ref}</text>
              )
            )}
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
            <span fg={GRAY}> — what fires on its own (writes .atskills/.autotrigger)</span>
          </text>
          <text> </text>
        </box>
        <scrollbox focused={false} style={{ flexGrow: 1 }}>
          <box style={{ flexDirection: 'column' }}>
            {items.length === 0 && <text fg={GRAY}>  nothing yet — save or install something from the console first</text>}
            {items.map((item: Item, i: number) => {
              const checked = lib.ui.isChecked(root, item);
              const box_ = checked === 'direct' ? '[x]' : checked === 'via-dir' ? '[#]' : '[ ]';
              const cur = i === cursor;
              return (
                <box key={item.id} style={{ flexDirection: 'column' }}>
                  <text>
                    <span fg={cur ? BLUE : GRAY}>{cur ? '> ' : '  '}</span>
                    <span fg={checked ? GREEN : GRAY}>{box_}</span>
                    <span> {String(item.label).padEnd(44)} </span>
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
          <text fg={GRAY}>up/down move · space toggle · enter view prompt · esc back</text>
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
          {log.map((b, i) => (
            <text
              key={i}
              selectable
              fg={b.kind === 'cmd' ? BLUE : b.kind === 'ref' ? GRAY : b.kind === 'note' ? GREEN : b.kind === 'error' ? RED : undefined}
            >
              {b.kind === 'error' ? '✗ ' + b.text : b.text}
            </text>
          ))}
        </box>
      </scrollbox>
      {suggestions.length > 0 && (
        <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 2 }}>
          {suggestions.map((s, i) => (
            <text key={s.label}>
              <span fg={i === compIdx ? BLUE : GRAY}>{(i === compIdx ? '› ' : '  ') + s.label}</span>
              {s.where ? <span fg={GRAY}>{'   ' + s.where}</span> : null}
            </text>
          ))}
        </box>
      )}
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
  const cache = new lib.Cache();
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
      <App cache={cache} root={root} onExit={onExit} keyHandler={(renderer as any).keyInput} renderer={renderer} />
    </AppContext.Provider>
  );
}

main();
