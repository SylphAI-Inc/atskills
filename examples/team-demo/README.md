# Team demo — local skills only

A project whose skills are all its own: nothing fetched, nothing followed. This is
the "team standardizing" shape — skills and `.autotrigger` live in the repo, so
distribution and review are just git.

```bash
cd examples/team-demo
alias atskills="node ../../bin/atskills.js"

atskills triggers      # team-flows/ is one directory line — it covers both skills under it
atskills prompt        # the exact injected text: three entries, all read from local files
atskills get team-flows/deploy
atskills skills        # the console: /skills shows [#] on skills covered by the directory line
```

Things to notice:

- `team-flows/` in `.autotrigger` is a **directory line** — every skill under
  `.atskills/team-flows/` fires, including ones added later by teammates.
- `scratch-notes` exists but has no line — it loads nothing until someone checks it.
- Nothing here has a `.source`: it's all the project's own work. No cloud is ever
  consulted.
