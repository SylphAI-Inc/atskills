# Contributing a Skill

There is no registry to submit to, because the file tree is the marketplace: a public skill is a directory in a public repo, and its path is its address.

## Publish a skill

1. **Create or use any public GitHub repo** — you don't need to fork this one; your own repo is enough.
2. **Add a `SKILL.md`** at the root of your skill directory:
   ```markdown
   ---
   name: my-skill
   description: One-line summary of what this does
   author: your-github-username
   version: 1.0.0
   ---

   # My Skill

   Step-by-step instructions for the agent...
   ```
3. **(Optional) add supporting files**:
   ```
   my-skill/
     SKILL.md
     scripts/       # helper scripts the agent can run
     references/    # docs, examples, lookup tables
     templates/     # boilerplate files to copy
   ```
4. **It's instantly usable** by anyone, with zero indexing delay:
   ```
   @skills:gh:<your-org>/<repo>/<path-to-skill-dir>
   ```
   A directory of several skills is equally publishable — it resolves as a menu, and every skill in it is addressable by its own sub-path. Keep any one directory under 128 skills ([`PROTOCOL.md`](./PROTOCOL.md) §8.3): curate collections the way you'd curate folders.

### Adding to the official SylphAI collection

To join the curated collection (higher visibility):

1. Open a PR against [`SylphAI-Inc/skills`](https://github.com/SylphAI-Inc/skills) adding your skill under `skills/<your-skill-name>/`.
2. Follow the existing format in that repo (frontmatter + instructions, same as above).
3. A maintainer reviews and merges — merged skills are instantly addressable as `gh:sylphai-inc/skills/skills/<name>`.

## Guidelines for a Good Skill

- **One job, done well.** A skill should do one thing clearly rather than trying to be a general-purpose assistant.
- **Frontmatter is required.** At minimum, `name` and `description`. Both feed menus and the auto-trigger index, so make the description scannable — it is the trigger signal.
- **Write instructions for an agent, not a human.** Be explicit and step-by-step; avoid assuming context the agent won't have.
- **Keep it self-contained.** If a script or reference file is required, include it in the skill directory rather than linking externally.
- **Test it.** Before publishing, run the skill against a real agent (AdaL, Claude Code, Cursor, etc.) — `atskills get` your own path and confirm the instructions produce the intended behavior.

## Improving the Protocol Itself

This repo is the spec and reference implementation. If you want to propose a change to:

- the resolution rule or the cache semantics ([`PROTOCOL.md`](./PROTOCOL.md)),
- `.autotrigger` semantics or the `/skills` surface,
- the agent instruction file ([`SKILLS.md`](./SKILLS.md)), or
- the reference CLI / TypeScript core (`bin/`, `lib/`, `src/`),

open an issue or PR here. A behavior is protocol behavior only if a test pins it (see [`tests/README.md`](./tests/README.md)) — proposals that arrive with a test are the easiest to land. Discussion and design changes happen in the open.

## Questions

Open an issue in this repo.
