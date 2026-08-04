# INTEGRATION.md — wiring `@skills:` into your agent

How to give any agent first-class `@skills:` support with the `atskills`
npm package. `SKILLS.md` says what the protocol *is*; `PROTOCOL.md` §8 is the
spec-level integration path; this file is the package-level one — the same
wiring the AdaL CLI uses, reduced to what you actually have to write.

## The whole integration, in one sentence

**Everything in this protocol is file management. Only two things ever touch
the model — a resolved `@skills:` reference enters the *query*, and the
`.autotrigger` block enters the *system prompt* — and one surface manages the
files: `/skills` (or whatever your agent calls it).**

Three integration points, no more:

| # | Point | Direction | Model-facing? |
|---|---|---|---|
| 1 | `@skills:<ref>` — **use** | reference → resolved content → the query | yes |
| 2 | `.autotrigger` — **install** | file on disk → one string → the system prompt | yes |
| 3 | `/skills` — **manage** | user intent → files under `.atskills/` | no — pure file management |

There is no manifest to parse, no registry client to maintain, no install
step to implement. Skills are directories; the package reads and writes
them; your agent decides what its query, its system prompt, and its
management surface look like. Points 1–2 make you a complete client; point 3
is where your UX lives — and everything it does, a user with a text editor
could do by hand, which is the protocol's point.

```
                        ┌────────────────────────────┐
   @skills:gh:o/r/path  │       your agent           │
  ──── user types ────▶ │  resolveSkill() ──▶ QUERY  │  1 · use
                        │                            │
   .atskills/.autotrigger
   (local paths, and @gh:/@hub                       │
    lines for git- or hub-hosted                     │
    skills — no local copy needed)                   │
  ──── file on disk ──▶ │  buildAutotriggerIndex()   │  2 · install
                        │        ──▶ SYSTEM PROMPT   │
                        │                            │
   /skills save|install │  tree/save/trigger calls   │  3 · manage
  ──── user manages ──▶ │        ──▶ .atskills/ files│      (no model)
                        └────────────────────────────┘
```

## Install

```bash
npm install atskills
```

One runtime dependency (`ignore` — gitignore matching is the spec for
`.autotrigger` plain lines). Node ≥ 18. `git` on PATH for cloud resolution.

```ts
import { resolveSkill, buildAutotriggerIndex, parseReference,
         listLocalSkills, SkillCollectionTooLargeError } from 'atskills';
```

Every call takes the same options object:

```ts
const opts = {
  workingDir: projectRoot,          // where .atskills/ lives — required
  // cacheDir:  defaults to ~/.cache/atskills (DEFAULT_CACHE_DIR, XDG-aware) —
  //            the shared, agent-neutral cache; never inside .atskills/
  // registryBaseUrl: your hub, if you use one; gh: paths need none
  // githubBaseUrl: seam for GitHub Enterprise; tests point it at file:// repos
  log: myLogger,                    // optional {info, warn} sink; silent if omitted
};
```

## Point 1 — `@skills:` → the query

When the user's message contains `@skills:<ref>`, resolve it and put the
content into the user turn you send the model. Nothing becomes resident;
the reference is spent when the turn ends.

```ts
const ref = parseReference(raw);            // strips :save / :install suffixes
let result;
try {
  result = await resolveSkill(ref.id, ref.save, opts, ref.install);
} catch (e) {
  if (e instanceof SkillCollectionTooLargeError) {
    // Over the 128-skill cap. e.message names sub-collections that fit —
    // SHOW IT to the user; it is an answer, not a failure.
  }
  // Any thrown error must reach the user. Swallowing it sends the model a
  // bare "@skills:…" token with no content and no explanation.
}

if (result.kind === 'skill') {
  // result.content is the SKILL.md body; result.files lists the bundle.
  // Frame it clearly as loaded reference material, e.g.:
  //   Content from @skills:<id> (read-only reference):
  //   <numbered or fenced body>
} else if (result.kind === 'menu') {
  // A directory: result.entries is one row per skill (id, name, description,
  // path). Render the menu into the turn; each row's id is itself a valid
  // reference the agent can read on demand. Sanitize name/description before
  // splicing (strip newlines) — they are remote, user-authored frontmatter.
}
```

Rules worth keeping (each one is a bug we shipped first):
- **Surface every failure in the UI**, including thrown ones — the cap
  refusal carries the "reference one of these instead" suggestions.
- **Strip newlines from remote `name`/`description`** before they enter the
  turn, or a hostile skill can forge your own message framing.
- Consider a **byte ceiling** on injected content; the cap bounds skill
  *count*, not one file's size.

## Point 2 — `.autotrigger` → the system prompt

`.atskills/.autotrigger` is a gitignore-semantics file listing what should be
resident. A plain line auto-triggers a skill the project holds; an `@` line
**follows a git- or hub-hosted skill without holding a copy** (`@gh:owner/
repo/path`, `@owner/skill`), refreshed through the shared cache; a trailing
`/` takes a whole directory. You never parse any of it: the package resolves
every line (local-first, cloud lines through the cache, stale copies marked
in their row) and returns **one finished string**. Your host splices that
string into its system prompt verbatim.

```ts
const block = await buildAutotriggerIndex(opts);   // '' when no triggers
systemPrompt = spliceSkillsBlock(systemPrompt, block);
```

Rebuild and re-splice at exactly three moments:
1. **Session start.**
2. **After any mutation** — a save/install/toggle, or the user editing
   `.autotrigger` by hand (a file watcher or a post-command hook both work).
3. **After your prompt-holding process restarts**, if the prompt lives in a
   different process than the resolver (it starts empty and must be re-fed).

Two hard-won rules:
- `''` **is a real value** ("all triggers removed") and must be pushed like
  any other — skipping empty strings leaves ghost skills resident.
- If the string crosses a process boundary (an HTTP endpoint, a socket),
  **guard the endpoint**: it writes your system prompt. In AdaL the backend
  rejects any request carrying a browser `Origin` header, because a wildcard
  CORS policy would otherwise let any web page rewrite the agent's prompt.

## Point 3 — `/skills`: the management surface

The third integration point is whatever your agent exposes to manage the
files: a slash command, a dialog, a settings pane. None of it touches the
model — it reads and writes `.atskills/` and `.autotrigger`, then triggers a
Wire-2 rebuild so the prompt catches up. AdaL ships it as `/skills
save|install|uninstall|toggle|remove` plus a checkbox dialog; the mapping
below is everything such a surface needs.

| You want | Package call | Files touched |
|---|---|---|
| `@`-autocomplete of local skills | `listLocalSkills(cwd)` | reads `.atskills/` (no network — pre-cache it, refresh after mutations) |
| A checkbox tree like AdaL's `/skills` dialog | `collectTreeItems(root)` / `toggleTreeItem(root, id)` | reads tree; toggles a `.autotrigger` line |
| Save (vendor + detach) a skill into the project | `saveSkillToProject(id, opts)` (or `resolveSkill` with `save`) | writes `.atskills/<path>/` + 2-line `.source` |
| Install without loading | `addTriggerLine(root, installLineFor(root, id))` | appends one `.autotrigger` line |
| Uninstall | `removeTriggerLine(root, line)` | removes the line; any copy stays |
| Remove a saved copy | your own `rm -r` + `removeTriggerLine` | **confirm first** — it deletes a git-tracked directory |
| Show provenance | `nearestSource(dir, root)` | reads the closest `.source` above |

## What the host owns vs. what the package owns

| | Package (protocol) | Your agent (host) |
|---|---|---|
| Path grammar, leaf rule, cap, cache, save/verify, trigger semantics | ✔ | |
| Query formatting, prompt splicing, autocomplete UI, dialogs, confirmations | | ✔ |
| Logger, registry choice, GitHub host, project root | | ✔ (via `opts`) |

If you find yourself re-implementing anything in the left column, stop — that
drift is how a catalog once shipped 11.9% unreferenceable paths. Non-JS hosts
shell out instead: `npx atskills paths < paths.txt` validates a corpus with
the real grammar, one JSON verdict per line.

## The escalation ladder

1. **Zero code** — hand your agent [`SKILLS.md`](./SKILLS.md); any agent with
   shell + file access is a full client through the `atskills` CLI.
2. **Instructions-only** (minutes) — PROTOCOL.md §8.1: teach your prompt what
   `@skills:` means and let the agent use the CLI.
3. **First-class** (this file) — wire 1, wire 2, then whatever file-management
   sugar your UX wants.

## Worked example — the AdaL CLI

| Piece | Where it lives in AdaL | Package calls |
|---|---|---|
| Point 1: reference → query | `atCommandExtractor.ts` | `parseReference`, `resolveSkill` |
| Point 2: block → system prompt | boot + `/skills sync` push; backend splices one string (5 lines of backend code total) | `buildAutotriggerIndex` |
| Point 3: `/skills` commands + dialog | `SkillsDialog.tsx`, command defs | `collectTreeItems`, `toggleTreeItem`, save/trigger calls |
| Autocomplete (part of point 1's UX) | `useWorkflowCompletion.ts` | `listLocalSkills` |

The backend's entire share of the protocol is storing one string and splicing
it — everything else lives beside the UI. That asymmetry is the design: the
protocol stays in one codebase, so the loader, the management surface, and
the session prompt can never disagree.

## Checking your integration

`npm test` in this repo runs the conformance suite (59 tests) against the
package; `npm run test:e2e` drives real repos end to end. If your host adds
behavior on top (formatting, caps, confirmations), test *that* — the protocol
underneath is already covered here, and the test titles double as the spec.
