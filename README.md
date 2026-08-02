# atskills — the `@skills:` protocol

Use any agent skill by its path, without installing it. Same `SKILL.md` format the whole ecosystem already writes — different lifecycle: no install step, no permanent system-prompt footprint, loaded on demand, gone after.

```
@skills:gh:sylphai-inc/skills/skills/glowmotion  draw the auth flow
```

That reference is the entire integration surface. A path addresses a skill; reading it is using it.

**It's just a file tree.** No manifest, no `marketplace.json`, no bundle or plugin concepts. A folder holding a `SKILL.md` is a skill; its path is its address; the tree is the marketplace.

## Highlights

**1 — Skills managed like a filesystem.** A path addresses *any granularity*: one skill, a collection by its parent directory, or a whole repo — and `@skills:` references, saves, and auto-trigger lines all respect the same GitHub path relations:

```
@skills:gh:sylphai-inc/skills                          the whole repo -> a menu
@skills:gh:sylphai-inc/skills/skills                   the collection -> a menu
@skills:gh:sylphai-inc/skills/skills/glowmotion        one skill -> its body
@skills:gh:sylphai-inc/skills/skills/glowmotion:save   vendor it, adapt it, own it
```

A directory is a **menu** — one line per skill, every line itself a valid address — so browsing and using are the same gesture, and a "bundle" is just a directory you take one path at a time. Load a subtree now, a sibling later: the validating cache means nothing downloads twice — each use asks "did this change?", and unchanged serves instantly. Saves vendor at the ID's own path (`.atskills/gh/owner/repo/...`), so copies nest by source and answer their own address, exactly like Go's `vendor/`.

**2 — `@` with the UX you already have.** Typing `@` autocompletes skills in the same dropdown agents already use for files: the project's own skills and every followed cloud ID complete instantly, each suggestion showing where it lives. A skill you've used is one keystroke away; one you've never seen is one pasted path away (GitHub URLs work as-is). Flexibility of paths, muscle memory of `@`.

**3 — One config file, `.gitignore` semantics.** Everything that fires on its own is one readable file, with the same flexibility about which parts are on:

```
# .atskills/.autotrigger
sec-checklist                       your skill — auto-triggers
team-flows/                         every skill under the directory
!team-flows/experimental            ...except that one
@gh:stripe/agent-toolkit/payments   follow the provider's latest
@gh:stripe/agent-toolkit/           follow the whole collection
```

Install = add a line; uninstall = remove it. A directory line covers present *and future* skills; `!` negation carves exceptions; an `@` line follows upstream. One `git diff` line per decision — no manifest, no lockfile, no per-machine state.

**4 — `/skills`: one surface manages it all.** Nobody has to touch a dotfile: a checkbox tree over `.autotrigger` and `.atskills/` covers every kind of line (local, `gh:`, hub) and every kind of storage (your folders, saved copies with `.source` provenance). Check a box → a line is written; uncheck under a covering directory → the line **splits** so the file always reads true; *view prompt* shows the exact text the model sees, with its token count. Checkboxes, typed verbs, and hand edits are three ways to write the same one-line diffs.

## Try it now — reference implementation

This repo ships a working client: a CLI + library with one dependency (`bin/`, `lib/`, Node ≥ 18), a TypeScript protocol core for agent builders (`src/`), the agent spec ([`SKILLS.md`](./SKILLS.md)), and a runnable demo.

```bash
cd examples/demo && alias atskills="node ../../bin/atskills.js"
atskills get gh:sylphai-inc/skills/skills/glowmotion          # use — never installs
atskills save gh:sylphai-inc/skills/skills/posthog-analytics  # save = adapt + detach
atskills triggers                                             # what fires on its own
atskills prompt                                               # the exact injected text
atskills skills                                               # interactive management tree
```

See [`examples/demo/README.md`](./examples/demo/README.md) for the walkthrough. This generation supports local and GitHub-hosted skills; the hub ships later.

## The three tiers

Install-only skills are one tier. The protocol adds two more, so the cost of a skill matches how often you actually use it.

| Tier | Spelling | Lives | Context cost |
|---|---|---|---|
| **Use** | `@skills:<path>` | Nowhere — read for this task | Only while used |
| **Save** | `@skills:<path>:save` | `.atskills/<path>/`, git-tracked, yours to edit | Only while used |
| **Auto-trigger** | `@skills:<path>:install` | A line in `.atskills/.autotrigger` | One line of frontmatter |

The tiers are orthogonal: `:save` vendors a copy, `:install` adds a trigger line, and either works without the other.

## Addressing

A skill's **path is its identity**.

- `gh:owner/repo/path` — a GitHub address. Case-sensitive, as GitHub paths are. On disk `gh:` is spelled `gh/`, because folder names can't hold colons.
- `owner/name` — a hub name. Lowercase; resolvers fold case.
- Pasted GitHub URLs are valid references and normalize to `gh:` form.

**Local always wins, by path.** A folder at `.atskills/<path>` answers that path, whatever it spells. That single rule is what makes saving work: a vendored copy answers its own address because it *sits* at that address — not because a manifest redirects it. `.source` is provenance only; nothing ever resolves against it.

## The collection cap — 128 skills per reference

A reference names one skill or one collection. A collection holds at most **128 skills**; anything larger is refused, and the refusal names smaller paths that work.

This exists because a path can address a whole repository, and repositories exist with thousands of skills — one real catalog holds 6,296. Resolving it means a 110 MB clone (or one fetch per skill against a quota) and an index of roughly 455k tokens, which exceeds most context windows by itself. Nobody curated that collection; it is a repo root that happens to be addressable.

128 is not our number: it is the manifest ceiling the largest catalog in the ecosystem already enforces on itself, so a bundle usable there is usable here.

```
gh:sickn33/catalog holds 436 skills — over the 128 a single reference may load.
Reference a specific skill, or one of the collections inside it:
  gh:sickn33/catalog/plugins/bundle-api-builder  (12)
  gh:sickn33/catalog/plugins/bundle-design-it    (12)
  gh:sickn33/catalog/plugins/bundle-super-code   (12)
```

Three properties make this cheap rather than annoying:

- **The refusal precedes the download.** git clones `--filter=blob:none --no-checkout` and counts with `ls-tree`; no file content moves. (`--no-checkout` is the load-bearing flag — give git a working tree to populate and it faults every blob in anyway.)
- **It counts skills, not files.** One skill with a 500-file bundle is one skill.
- **It is not a loss of access.** Any sub-path still resolves, and transports fetch subtrees, so narrowing costs no more than the refused call would have.

Suggestions descend to the *shallowest* paths that fit. One level of grouping isn't enough — in a real aggregator every top-level child is oversized too, so descending is what surfaces the ~10-skill bundles the author actually curated.

Full requirements: [`PROTOCOL.md`](./PROTOCOL.md) §8.3.

## What a skill is

A directory — not just a single file:

```
glowmotion/
  SKILL.md        # Required — instructions, with YAML frontmatter
  scripts/        # Optional — helper scripts the agent can run
  references/     # Optional — reference docs, examples, lookup data
  templates/      # Optional — files to copy or fill in
```

```markdown
---
name: tdd
description: Test-driven development methodology
---

# TDD Workflow

1. Write a failing test FIRST
2. Write the minimum code to make it pass
3. Refactor only when green
```

`SKILL.md` alone is a complete skill. A skill is a folder holding `SKILL.md`, and the walk **stops there** — a `SKILL.md` nested inside a bundle is that bundle's file, not a second skill. A directory *without* one is not an error: it is an index of the skills beneath it, one line each, every line a path that can be read on demand.

## How this relates to installed skills

**Same format, different lifecycle.** A skill directory here is exactly the shape of a Claude Code skill, a Cursor skill, or anything on [skills.sh](https://skills.sh).

| | Installed skills | `@skills:` |
|---|---|---|
| **Format** | `SKILL.md` + optional dir | Identical |
| **Lifecycle** | Install once, lives permanently | Read on demand, gone after |
| **Footprint** | In the system prompt always | Zero until referenced |
| **Setup** | Install step / marketplace | A path |
| **Fits** | Playbooks you use constantly | Playbooks you use once or occasionally |

Compatibility is bidirectional and lossless: every installed skill is already addressable by its GitHub path, and any skill here becomes an installed one by copying the directory into your agent's skills folder. Most shared know-how is used once, not constantly — that gap is what this fills, and `:install` covers the rest.

## The whole implementation, counted

The protocol — use, save, auto-trigger, cache, conflicts, the cap — is still intentionally small, with **one** npm dependency (`ignore`). The current tree has two faces:

- `src/` is the TypeScript protocol core for first-class agent integrations.
- `lib/` + `bin/` are the runnable Node reference client used by the CLI and demo.

```
src/                         TypeScript protocol core
├── index.ts            51   one public export surface for agent builders
├── types.ts           105   host-facing response, origin, and tree contracts
├── ids.ts             150   @skills:<path> grammar — gh:/hub IDs, pasted
│                           GitHub URLs, :save/:install suffixes, safe paths
├── fsx.ts             240   filesystem rules — leaf skills, frontmatter,
│                           closest-.source-above, atomic writes, pool helpers
├── autotrigger.ts     221   install = a line in one file; plain lines match
│                           gitignore semantics (globs, ! negation)
├── residency.ts       103   the injected prompt index — readable paths with
│                           name/description frontmatter
├── tree.ts            304   /skills checkbox tree, toggle splitting, saved
│                           provenance, and prompt-preview model
└── resolver.ts        918   local-first resolution, GitHub/hub materialization,
                            save = adapt + detach, cache, and 128-skill cap

lib/                       runnable Node reference implementation
bin/atskills.js       180   CLI: get · save · triggers · prompt · skills
ui/skills.tsx         611   interactive /skills console app (OpenTUI/Bun)
tests/                963   unit tests plus real-repo and PTY-driven E2E checks
```

Everything heavyweight is delegated to something that already exists — git moves the bytes, ETags keep them fresh, gitignore semantics pick what fires, and your repo's history is the version control.

## For agent builders

You may not need to write any integration code. Any agent with shell and file access can be handed [`SKILLS.md`](./SKILLS.md) and become a full client — it is written for an agent to read, not for a human to port.

For a first-class `@skills:` reference in your own agent, [`PROTOCOL.md`](./PROTOCOL.md) §8 has the full path: §8.1 instructions-only (minutes), §8.2 full directory support, §8.3 the collection cap.

## Contributing a skill

1. Put a skill directory (`SKILL.md` + optional `scripts/`/`references/`/`templates/`) in any repo.
2. It is instantly usable: `@skills:gh:<your-org>/<repo>/<path>`.

There is no submission step, because there is no registry to submit to. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Examples

- [`examples/simple-tdd/SKILL.md`](./examples/simple-tdd/SKILL.md) — a single-file skill.
- [`examples/code-review/SKILL.md`](./examples/code-review/SKILL.md) — a structured review skill.
- [`examples/demo/`](./examples/demo/) — a project wired up end to end.

## Status

The `@skills:` generation (`.atskills/`, `.autotrigger`, `.source`) is implemented here and specified in [`SKILLS.md`](./SKILLS.md) and [`PROTOCOL.md`](./PROTOCOL.md). `@workflow:` is the previous spelling of the same grammar and is still accepted as an alias. The hub ships later; nothing in the protocol depends on it.

## License

The protocol is open. `SKILL.md` directories inherit their repo's license.
