---
name: code-review
description: Perform a thorough, structured code review of a diff or pull request
author: sylphai-inc
version: 1.0.0
tags: [review, quality]
---

# Code Review Workflow

Review the given diff, pull request, or set of changed files as a careful senior engineer would — looking for correctness, safety, and maintainability issues, not just style nits.

## Steps

1. **Understand intent first.** Read the PR description / commit messages / linked issue before reading the diff line-by-line. Know what problem the change is supposed to solve before judging whether it solves it.

2. **Trace the change end-to-end.** For each modified function/module, identify every caller and every downstream consumer of its output. A change that looks correct in isolation can still break a caller that assumed the old behavior.

3. **Check correctness before style.** In priority order:
   - **Logic errors** — off-by-one, incorrect conditionals, wrong operator, inverted boolean logic.
   - **Error handling** — are error/exception paths handled, or silently swallowed? Are edge cases (empty input, null/None, zero, max values) covered?
   - **Concurrency/state** — race conditions, shared mutable state, missing locks/transactions where needed.
   - **Security** — unsanitized input reaching a query/shell/template, secrets in code, missing auth checks on new endpoints.
   - **Resource handling** — unclosed files/connections, unbounded loops/memory growth, missing timeouts.

4. **Check test coverage.** Does the diff include tests for the new/changed behavior? Do the tests actually exercise the changed logic, or do they just assert trivial properties (tautological tests)? Are edge cases from step 3 covered?

5. **Check for duplication and reuse.** Does this diff reimplement something that already exists elsewhere in the codebase (a date formatter, a retry helper, an API client)? Prefer reusing/extending existing utilities over introducing parallel implementations.

6. **Check the blast radius.** Is the change scoped to what the task requires, or does it touch unrelated files/formatting/comments? Flag unrelated changes explicitly — they hide the real diff and increase review risk.

7. **Only then, style and readability.** Naming, comments, consistency with surrounding code conventions. Note these, but don't let them dominate the review — they're the last priority, not the first.

8. **Write the review as specific, actionable comments.** For each issue found:
   - Point to the exact file/line.
   - State what's wrong (not just "this looks off") and why it matters (what could break, and under what condition).
   - Suggest a concrete fix or ask a clarifying question if intent is genuinely ambiguous.
   - Distinguish blocking issues ("must fix before merge") from non-blocking suggestions ("consider," "nit:").

## Output Format

Summarize as:
1. **TL;DR** — does this change look safe to merge, with or without required fixes?
2. **Blocking issues** — must be resolved before merge, with file/line references.
3. **Non-blocking suggestions** — nice-to-haves, style, minor improvements.
4. **Questions** — anything genuinely ambiguous that needs the author's input before you can finish the review.
