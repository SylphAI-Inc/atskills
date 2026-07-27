# AgentWorkflows

**Open protocol for AI agent workflows.** Fetch a `SKILL.md`, give it to your agent, done.

## What is a Workflow?

A workflow is a **SKILL.md file** — a markdown document with instructions that tells an AI agent how to perform a task. Same format used by Claude Code, Cursor, Codex, and AdaL.

```markdown
---
name: tdd
description: Test-driven development methodology
author: mattpocock
---

# TDD Workflow

1. Write a failing test FIRST
2. Write the minimum code to make it pass
3. Refactor only when green
4. Repeat
```

No binary format, no runtime dependency, no SDK. Just markdown.

## How Any Agent Can Use a Workflow

### For AdaL users

Inline `@` reference — compose it anywhere in your message, mix with files, use multiple at once:

```
create a diagram @workflow:glowmotion for the auth flow
```

```
@workflow:review @src/auth.ts review this file
```

`/workflow <id> <prompt>` is kept as a convenience alias for `@workflow:<id> <prompt>`.

### For other agents

**Listed workflows** (on [adalagent.ai/workflows](https://adalagent.ai/workflows)):

```bash
curl -s https://adal.sylph.ai/api/workflows/glowmotion/content | jq -r '.content' > SKILL.md
# Then tell your agent: Read SKILL.md and follow the instructions.
```

**Any public GitHub skill** (not listed on our site):

```bash
curl -s 'https://adal.sylph.ai/api/workflows/content?github_url=owner/repo/path/to/skill' | jq -r '.content' > SKILL.md
```

`github_url` format: `owner/repo/path/to/skill` (e.g. `SylphAI-Inc/skills/skills/glowmotion`). In AdaL this maps to `@workflow:gh:owner/repo/path/to/skill`.

## Minimal Integration (5 minutes)

1. Fetch the SKILL.md content:
   ```bash
   curl -s https://adal.sylph.ai/api/workflows/<slug>/content | jq -r '.content'
   ```
2. Include the content in your agent's context.
3. Done.

### API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/workflows/inventory` | GET | No | List all public workflows |
| `/api/workflows/resolve/{slug}` | GET | No | Resolve slug → GitHub path + metadata |
| `/api/workflows/{slug}/content` | GET | No | Get full SKILL.md content by slug |
| `/api/workflows/content?github_url=<path>` | GET | No | Get SKILL.md from any GitHub path |

**Base URL:** `https://adal.sylph.ai`

**Response format (`/content` endpoints):**
```json
{
  "success": true,
  "slug": "glowmotion",
  "content": "---\nname: glowmotion\ndescription: Create premium animated diagrams\n---\n\n# Glowmotion\n\n...",
  "source": "github"
}
```

## SKILL.md Format

```markdown
---
name: <slug>                    # Required: unique identifier
description: <one-liner>        # Required: what it does
author: <github-username>       # Optional: who made it
version: <semver>               # Optional: version
---

# Title

Instructions for the agent...
```

Everything after the YAML frontmatter is the instructions the agent should follow.

### Directory structure (for complex workflows)

```
my-workflow/
  SKILL.md              # Required — the instructions
  scripts/               # Optional — helper scripts the agent can run
  references/            # Optional — reference docs, examples
```

## Resolution Order

Workflows resolve **local-first**, then fall back online:

1. **Project-local** — `.workflows/<slug>/` in the repo (permanent, git-tracked)
2. **Session cache** — ephemeral, cleaned up when the session ends
3. **Online** — platform registry (bare slugs) or GitHub directly (`gh:owner/repo/path` ids)

Add `--save` (or `@workflow:<id> --save`) to persist an online workflow to `.workflows/<slug>/` permanently.

## Contributing a Workflow

1. Fork or create a repo with your workflow.
2. Add a `SKILL.md` with YAML frontmatter.
3. It's instantly usable: `@workflow:gh:<your-org>/<repo>/<path>` (or `/workflow gh:<your-org>/<repo>/<path>`).

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full guide (including platform-based, no-GitHub-required contribution).

## Examples

- [`examples/simple-tdd/SKILL.md`](./examples/simple-tdd/SKILL.md) — a simple, single-file workflow.
- [`examples/code-review/SKILL.md`](./examples/code-review/SKILL.md) — a structured review workflow.

## Full Technical Spec

See [`PROTOCOL.md`](./PROTOCOL.md) for the complete wire format, API contracts, authentication, rate limits, caching, and error handling spec.

## Status

MVP — this repo hosts the protocol spec. Feedback and PRs welcome.

## License

The protocol is open. `SKILL.md` files inherit their repo's license. The catalog API is free and rate-limited.
