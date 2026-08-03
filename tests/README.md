# Tests — the protocol's executable conformance suite

`SKILLS.md` states the protocol for agents; `PROTOCOL.md` states it for
implementers; these tests state it for machines. A behavior is protocol
behavior only if a test here pins it. Three layers, strictest first:

## 1. Unit (`npm test` — node:test, hermetic, no network)

| File | Pins |
|---|---|
| `ids.test.js` | ID grammar: `gh:` casing, hub lowercase folding, URL normalization, traversal refusal |
| `fsx.test.js` | leaf rule (`walkSkills` / `leafSkillDirs`), `safeJoin`, `.atskills` discovery |
| `autotrigger.test.js` | `.autotrigger` parsing (gitignore semantics), local-first expansion, per-line failure isolation |
| `ui-tree.test.js` | checkbox tree states `[x]/[#]/[~]`, the SPLIT of a covering dir line |
| `cache-save.test.js` | validating cache against a **local HTTP hub** (real ETag/304/404 flows) |
| `collection-cap.test.js` | the 128-skill cap: counting, sub-collection suggestions, dedupe |
| `save-gitbase.test.js` | save over **real `file://` git remotes** (the `gitBase` seam): vendored path + two-line `.source`, save-again replace/conflict, cap-refusal-is-a-verdict (never retried through the fallback), skills-not-files counting |
| `ts-core.test.js` | the TypeScript core (`src/` → `dist/`, `npm run build` first; skips if unbuilt): local-first, the validating cache over `file://` remotes, the cap with suggestions, save + `.source`, the checkbox SPLIT, the residency prompt block |

Hermetic means: local HTTP servers and on-disk git remotes speaking the same
protocols GitHub speaks (`uploadpack.allowFilter`, `allowAnySHA1InWant`) —
never stubs of our own code.

## 2. E2E, synthetic (`tests/e2e-skills-ui.sh` — tuistory PTY)

Drives the interactive `/skills` console through a real terminal: tree
renders, space writes/removes `.autotrigger` lines, "view prompt" shows the
exact injected text with its read trail, clean quit.

## 3. E2E, real world (network-gated; SKIP offline)

The bugs that matter shipped past the synthetic layers and were caught only
against real repositories — so real repositories are part of the suite:

- `tests/e2e-real-repos.sh` — the CLI against live GitHub: the 6k-skill
  aggregator (`gh:sickn33/antigravity-awesome-skills`) is **refused** on both
  `get` and `save` with the true count and loadable sub-collections named and
  nothing vendored (pins the ENOBUFS listing overflow and the
  refusal-retried-as-fallback bugs); a small official skill
  (`gh:anthropics/skills/skills/pdf`) round-trips: get, cache-validated
  second get (`·cache`), save with a full-sha `.source`.
- `tests/e2e-skills-ui-real.sh` — tuistory-driven `/skills` console following
  a real cloud line: live resolve into the tree, the real row in "view
  prompt", and a second session served through the validating cache.

Run everything: `npm run test:all`.
Requirements: node ≥18, git; tuistory for layer 2/3 UI scripts (SKIPs if
absent); network for layer 3 (SKIPs if offline).
