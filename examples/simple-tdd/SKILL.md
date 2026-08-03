---
name: simple-tdd
description: Test-driven development methodology — write the failing test first, then the minimum code to pass it
author: sylphai-inc
version: 1.0.0
tags: [testing, methodology]
---

# Simple TDD Workflow

Follow test-driven development strictly for the task at hand. Do not write implementation code before a failing test exists for it.

## Steps

1. **Understand the requirement.** Restate what behavior is being added or fixed, in one or two sentences, before touching any file.

2. **Write a failing test first.**
   - Add a test that exercises the new/changed behavior.
   - Run the test suite and confirm the new test fails (and fails for the *expected* reason — a wrong assertion or a crash from unimplemented code, not an unrelated error).
   - If it doesn't fail, the test isn't testing anything new — fix the test before proceeding.

3. **Write the minimum code to make it pass.**
   - Implement just enough to make the failing test green. Resist the urge to add extra functionality, generalization, or "while I'm here" cleanup at this stage.
   - Run the full test suite. All tests — the new one and every existing one — must pass.

4. **Refactor only when green.**
   - With all tests passing, look for duplication, unclear naming, or structural issues introduced by the minimal implementation.
   - Refactor in small steps, re-running the test suite after each change to confirm nothing broke.
   - Do not add new behavior during this step — refactoring changes structure, not behavior.

5. **Repeat.** For the next requirement or edge case, go back to step 2.

## Rules

- Never write production code without a failing test that requires it.
- Never write more test code than is sufficient to fail.
- Never write more production code than is sufficient to pass the currently failing test.
- If you find yourself writing several tests before making any of them pass, stop — return to one test at a time.

## When to Deviate

For pure exploration/spike work (throwaway prototyping to understand a problem), it's acceptable to skip strict TDD — but say so explicitly, and any code from the spike should be rewritten test-first before it ships.
