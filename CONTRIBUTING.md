# Contributing a Workflow

There are two ways to add a workflow to the ecosystem: on GitHub (for developers) or on the platform (for everyone).

## Option A: Create on GitHub

This is the recommended path if your workflow needs scripts, reference files, or version control.

1. **Fork or create a repo** — any public GitHub repo works. You don't need to fork this repo; your own repo is enough.
2. **Add a `SKILL.md`** at the root of your workflow directory:
   ```markdown
   ---
   name: my-workflow
   description: One-line summary of what this does
   author: your-github-username
   version: 1.0.0
   ---

   # My Workflow

   Step-by-step instructions for the agent...
   ```
3. **(Optional) add supporting files**:
   ```
   my-workflow/
     SKILL.md
     scripts/       # helper scripts the agent can run
     references/    # docs, examples, lookup tables
     templates/     # boilerplate files to copy
   ```
4. **It's instantly usable** by anyone, with zero indexing delay:
   ```
   @workflow:gh:<your-org>/<repo>/<path-to-workflow-dir>
   ```
   or via the raw content API:
   ```bash
   curl -s 'https://adal.sylph.ai/api/workflows/content?github_url=<your-org>/<repo>/<path>'
   ```
5. **Auto-indexing** — once a workflow is used through the platform, it's automatically indexed into the public catalog (`/api/workflows/inventory`) and becomes accessible by a short slug.

### Adding to the official SylphAI skills collection

If you want your workflow to be part of the curated, official collection (higher visibility, listed on [adalagent.ai/workflows](https://adalagent.ai/workflows)):

1. Open a PR against [`SylphAI-Inc/skills`](https://github.com/SylphAI-Inc/skills) adding your `SKILL.md` under `skills/<your-workflow-name>/`.
2. Follow the existing skill format in that repo (frontmatter + instructions, same as above).
3. A maintainer reviews and merges.

## Option B: Create on the Platform (no GitHub needed)

For non-technical users, or workflows that are just a text prompt with no scripts/files:

1. Go to [adalagent.ai/workflows](https://adalagent.ai/workflows/create).
2. Sign in, then click **"Create workflow"**.
3. Fill in a name, one-line description, and the instructions (plain text — this becomes the body of a generated `SKILL.md`).
4. Publish — you get a slug immediately.
5. Anyone can use it right away:
   ```
   /workflow <your-slug> <prompt>
   ```
   or fetch it via the content API:
   ```bash
   curl -s https://adal.sylph.ai/api/workflows/<your-slug>/content
   ```

Platform-created workflows are markdown-only (no scripts/references) — that's an intentional MVP simplification. If you need full skill power, use Option A.

## Guidelines for a Good Workflow

- **One job, done well.** A workflow should do one thing clearly rather than trying to be a general-purpose assistant.
- **Frontmatter is required.** At minimum, `name` and `description`. Both are shown in listings, so make the description scannable.
- **Write instructions for an agent, not a human.** Be explicit and step-by-step; avoid assuming context the agent won't have.
- **Keep it self-contained.** If a script or reference file is required, include it in the workflow directory rather than linking externally.
- **Test it.** Before publishing, run the workflow yourself against a real agent (AdaL, Claude Code, Cursor, etc.) and confirm the instructions actually produce the intended behavior.

## Improving the Protocol Itself

This repo (`SylphAI-Inc/agentworkflows`) is the spec, not the catalog. If you want to propose a change to:

- the `SKILL.md` frontmatter schema,
- the API contracts in [`PROTOCOL.md`](./PROTOCOL.md),
- the resolution order, or
- the "Workflow Compatible" agent vendor list,

open an issue or PR here. Discussion and design changes happen in the open.

## Questions

Open an issue in this repo, or reach out via [adalagent.ai](https://adalagent.ai).
