# IMPLEMENTATION.md — how this reference implementation is built

What the code is made of, what it leans on, and what it guarantees.
`SKILLS.md` says what the protocol *is*; this file says how *this repo* implements it.

## Dependency policy — the shape of the whole thing

| Layer | Runtime | Dependencies |
|---|---|---|
| `lib/` + `bin/` (protocol) | Node ≥ 18, plain CommonJS | **one spec package**: `ignore` (gitignore matching, zero deps). Everything else is stdlib (`fs`, `path`, global `fetch`, `crypto`, `child_process`) |
| `ui/` (console app) | Bun | `@opentui/core` + `@opentui/react` 0.4.5, `react` 19 — the only dependency island, isolated in its own `ui/package.json` |
| System tools leaned on | — | `git` (downloads + revisions), `tar` (none — removed), `pbcopy`/`xclip` (copy-out), any terminal |
| Dev / test | — | `node --test` (built-in runner), `tuistory` (PTY driver for E2E of the TUI) |

The principle: **never hand-roll a spec that already has a canonical
implementation — but don't import a spec you only need a corner of.** The one
npm dep exists because it IS an existing spec: `.autotrigger`'s plain lines
match with git's own ignore semantics (globs, `!` negation, the parent-dir
quirk — all of it) via the same `ignore` package ESLint uses. Frontmatter, by
contrast, needs exactly two fields — a 25-line parser beats a YAML dependency.
The same principle sends bigger jobs to system tools:

- **Downloading a GitHub subtree** = `git clone --depth 1 --filter=blob:none --sparse`
  + `git sparse-checkout set <sub>`. One negotiated transfer, only the needed
  blobs, private repos work through the user's existing git credentials.
  Pinned revisions use `git fetch --depth 1 origin <full-sha>`.
- **Resolving the current revision** = `git ls-remote <repo> HEAD` (full sha, no
  API quota). GitHub REST is only a fallback.
- **Per-file HTTP** (raw.githubusercontent + the trees API) exists for two jobs
  git can't do: cheap single-file reads for browsing/menus (through the
  validating cache), and a last-resort download path when git is absent.

## Module map (lib/ ≈ 1,100 lines total)

| Module | Implements (SKILLS.md §) | Notes |
|---|---|---|
| `ids.js` | identity | `normalizeId` (hub lowercase, `gh:` case-preserving, `gh/`→`gh:` fold, pasted GitHub URLs with `/tree|/blob/<branch>` spliced), `parseReference` (`:save`/`:install`, order-free), traversal-rejecting segment validation |
| `fsx.js` | shared rules | `walkSkills` (leaf rule: stop at SKILL.md; skip dotfiles), `frontmatter` (CRLF + YAML block scalars), `nearestSource` (closest-`.source`-above = origin), `safeJoin` (escape guard), `pool` (bounded fan-out) |
| `cache.js` | §1.2 cache | global validating cache, browser semantics: ETag/If-None-Match, 304=reuse, offline=stale+warn, 404=gone-with-cached-copy-offer; skill files materialize at a **readable tree path** (`~/.cache/atskills/gh/owner/…/SKILL.md`), metadata under `.meta/`, API blobs under `.blobs/`; binary-safe; always deletable |
| `sources.js` | §1.2–1.3 | GitHub raw/trees/ls-remote, hub behind the same interface (gated on `ATSKILLS_HUB` until atskills.one ships), `webUrl` (the human review page) |
| `resolve.js` | §1 | local-first **by path**; `.source` never consulted; cloud results carry `cachePath`/`cacheDir` (local, readable); directory = menu with per-child name/description/file/bundle |
| `autotrigger.js` | §2 | plain lines = literal **gitignore patterns** over the local tree (matched by the `ignore` package — globs and negation work exactly as in git); `@` lines = cloud IDs, local-first; per-line and per-child failures isolated; atomic tmp+rename writes; `addLine`/`removeLine`/`hasLine` are the single write path shared by suffixes, checkboxes, and the install box |
| `prompt.js` | index render | `- name: description (readable path)` — project file for local, cache tree file for cloud — matching adal's skills index so an agent resolves entries with a plain file read |
| `save.js` | §4 | save = adapt + detach; vendored at the ID's path; two-line `.source` (full sha); save-again: unedited (verified by `git fetch` at the recorded sha + tree compare) → replace; edited → **conflict**, refuse with the three ways out; downloads via git, dot-prefixed temp dirs |
| `ui.js` | /skills (shared) | filesystem checkbox tree at any depth: chain compression, `[x]/[#]/[~]/[ ]`, SPLIT (uncheck a covered leaf → coarsest sibling lines); **no auto-collapse** — a `dir/` line covers future skills, so only an explicit dir check writes it; pattern-covered rows show checked and point at their line; the saved-copy+`@`-line conflict is surfaced, not hidden; plus the no-Bun fallback TUI |
| `bin/atskills.js` | CLI | thin porcelain: `get · save · triggers · prompt · skills`; adal-style badges (`⎿ read <local path> (N lines)`, `⎿ read skills directory <dir>/ (N skills)`) |
| `ui/skills.tsx` | console app | OpenTUI: input with autocomplete (local + auto-trigger only), `[display]`/`[injected as the user query]` bounding boxes, `/skills` dialog with the always-visible install box, bracketed-paste enable (`\x1b[?2004h` — the app's job, not the terminal's), selection auto-copy |

## Formats & conventions borrowed from adal

- Index entry: `- name: description (path)` — description adjacent to the name,
  path as trailing metadata the agent can read.
- Injection: `Content from @skills:<id> (<local file>):` + `N|`-numbered lines,
  plus `Dir: <local dir>/` + `Listed files/directories inside:` when the skill
  bundles more than SKILL.md.
- Badges: `⎿ read … (N lines)` / `⎿ listed directory … (N items)`; cloud reads
  add `(cloud·status) · review: https://github.com/…/tree/HEAD/…`.
- Whole-dir content comparison (not SKILL.md-only) when judging "unedited" —
  a SKILL.md-only check reports false-pristine after a script edit.
- gh: reference forms: `gh:owner/repo[/path]` and full pasted `github.com` URLs.

## Robustness inventory

Verified guarantees (each exercised by the test suite or the PTY E2E):

- **Paths can't escape.** Every user-influenced path goes through segment
  validation (`ids.js` rejects `.`/`..`/empty/backslash) and `safeJoin`
  (resolves and requires the result stay under its root) — references,
  `.autotrigger` lines, cache tree paths, save destinations.
- **Nothing of yours is ever destroyed.** Save refuses on any existing folder
  unless verifiably unedited; checkbox toggles only edit `.autotrigger` lines;
  the conflict row's uncheck removes the `@` line, never the copy; removal of
  files is always an explicit user action.
- **Failures are isolated and named.** A bad `.autotrigger` line loads nothing,
  reports once, and the session goes on; offline serves stale with a warning;
  404 says "upstream gone" and offers the cached copy; frontmatter missing
  name/description refuses that skill loudly instead of silently indexing junk.
- **Binary-safe, atomic-ish writes.** Cache bodies and saved files are written
  as raw bytes to a temp name then renamed; saves land in a dot-prefixed
  `.saving-<name>` dir renamed into place, so an interrupted save leaves only
  invisible metadata.
- **Network is bounded.** Every fetch has a timeout; fan-out is pooled (8-wide);
  git operations are one process per save.
- **The cache is disposable.** Deleting `~/.cache/atskills` (or any entry) is
  always safe — paths re-resolve; metadata and blobs live in dot-dirs so the
  cache tree lists like a filesystem of skills.
- **Text tolerance.** Frontmatter parsing handles CRLF, quoted values, and YAML
  block scalars (`description: >-`); IDs fold case per the spec (hub lowercase,
  gh: preserved because GitHub paths are case-sensitive).
- **UI state cannot drift.** `/skills` renders from the files on every change;
  the cursor follows item identity across list reorders; toggles, suffixes, the
  install box, and hand edits all write through the same three functions.

## Robustness review outcome

A dedicated review pass (16 findings) was applied in full: git subprocesses can
no longer hang on credential prompts (`GIT_TERMINAL_PROMPT=0`, timeouts);
replace-on-update downloads fully before touching the existing copy;
`.autotrigger` and cache writes are atomic (tmp+rename, unique names — safe
under concurrent processes); response sizes are capped; the GitHub-token host
check is end-anchored; symlinks are never vendored; truncated tree listings
fail loudly; one failing child never aborts a directory expansion; both UIs
survive render-time filesystem errors and always restore the terminal;
unaddressable local names render as errors instead of writing dead lines.

## Known limits (accepted, documented)

- Hub paths are gated until atskills.one ships (`ATSKILLS_HUB` overrides).
- Concurrent writers get last-write-wins on `.autotrigger` (writes are atomic,
  so the file is never corrupted — a race loses an edit, never the file); git
  is the recovery story.
- `removeLine` drops a line's trailing `#` comment; hand annotations on a line
  you toggle off are gone when you toggle it back on (by design — the file's
  truth is its lines, comments are for humans).
- The per-file fallback download path is subject to GitHub's unauthenticated
  rate limits (60/hr) — git is the primary path precisely to avoid this.
- `spawnSync` git calls run with the user's git config; a repo that demands
  interactive credentials in a non-TTY environment fails closed into the
  per-file fallback.

## Test coverage

- `tests/*.test.js` — 27 unit tests via `node --test`, no framework: IDs and URL
  forms, frontmatter/leaf-rule/nearest-source, autotrigger parse/expand/dedupe/
  validation, cache 304/stale/gone against a local HTTP server, save/conflict/
  refetch semantics, resolve local-vs-cloud, the filesystem tree
  (split/collapse) and the saved-copy+`@`-line conflict.
- `tests/e2e-skills-ui.sh` — tuistory-driven PTY session of the fallback TUI:
  render, checkbox writes the file, view-prompt content, quit.
- The OpenTUI console is exercised the same way (tuistory) during development
  against live `gh:anthropics/skills` and `gh:sylphai-inc/skills`.
