# Demo — run the protocol here

A tiny project with skills already in place. Everything below runs from this
directory with no account, no install step, no server of ours.

```bash
cd examples/demo
alias atskills="node ../../bin/atskills.js"   # or: npm i -g .. && atskills
```

**1. Use a local skill** (the project's own — resolution is local-first, by path):

```bash
atskills get my-checklist
```

**1b. Use a local bundle** — `writing/` holds two skills; a directory is an index,
and its `.autotrigger` line covers every skill under it, present and future:

```bash
atskills get writing
atskills triggers      # writing/ counts as its children
```

**2. Use a skill straight from GitHub** (cached like a browser page — run it twice
and watch the second hit revalidate instead of re-downloading):

```bash
atskills get gh:sylphai-inc/skills/skills/glowmotion
```

**3. Browse a directory as a menu** (a bundle is only ever a menu — you take
skills one path at a time):

```bash
atskills get gh:sylphai-inc/skills/skills
```

**4. Save to adapt** — the copy lands at its ID's own path (vendored), with a
two-line `.source` saying where it came from and which revision you took.
Saving detaches it: it's yours now.

```bash
atskills save gh:sylphai-inc/skills/skills/posthog-analytics
cat .atskills/gh/sylphai-inc/skills/skills/posthog-analytics/.source
```

**5. See what fires on its own** — install = a line in `.autotrigger`, nothing more:

```bash
cat .atskills/.autotrigger
atskills triggers
```

**6. Read exactly what the model reads** — the injected prompt, verbatim, with the
file or URL every entry was read from:

```bash
atskills prompt
```

**7. Three levels, one gesture** — the same `@` works on a whole marketplace, a
plugin, or one skill; what changes is only how much menu you get. Try all three
against Anthropic's official skills repo and compare the output:

```bash
atskills get gh:anthropics/skills              # marketplace — the whole repo, one line per skill
atskills get gh:anthropics/skills/skills       # plugin — one directory of skills
atskills get gh:anthropics/skills/skills/pdf   # skill — the body itself
```

A bundle is only ever a menu: at every level you still take skills one path at a
time. `:save` and `:install` work at any of the three levels too.

**8. The console app** — an input where you type the exact same gestures
(`@skills:…`, `:save`, `:install`, `/skills` for the checkbox tree, Enter there
for view-prompt):

```bash
atskills skills
```

That's the whole protocol: one folder (`.atskills/`), one file (`.autotrigger`),
one stamp (`.source`), one command. Follow what's theirs; save what you'll make
yours.
