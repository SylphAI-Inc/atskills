# Bundle demo — a skill with scripts, references, and templates

One local skill, full directory shape (the Agent Skills standard): `SKILL.md` is
the entrypoint; everything else is supporting material the agent reads or runs
on demand — never preloaded.

```
.atskills/release-runbook/
  SKILL.md                        the instructions (this is all that's injected)
  scripts/check_version.sh        runnable helper
  references/release-checklist.md lookup material, read only when needed
  references/versioning-policy.md
  templates/release-notes.md      boilerplate to copy and fill
```

```bash
cd examples/bundle-demo
alias atskills="node ../../bin/atskills.js"

atskills get release-runbook     # the SKILL.md body
atskills triggers                # one entry — frontmatter only (~30 tokens resident)
atskills skills                  # in the console, type: @skills:release-runbook
```

In the console, the `@skills:release-runbook` output shows **exactly what an agent
injects**: the numbered SKILL.md content *plus* the listing of bundled files —
discoverable, not preloaded. That's the standard's progressive disclosure: the
body points at `references/` and `scripts/`; the agent opens them only when the
task needs them.

Because this skill lives in the project (no `.source` — it's yours), its script
runs like any reviewed project file. The same skill followed from the cloud would
confirm the script on first run and again on change.
