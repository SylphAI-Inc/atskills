#!/usr/bin/env bash
# E2E test of the interactive /skills UI, driven by tuistory (a PTY driver).
# Verifies: the tree renders, space toggles a line in .autotrigger, enter
# shows the injected prompt with its read trail, q exits cleanly.
set -euo pipefail

command -v tuistory >/dev/null || { echo "SKIP: tuistory not installed"; exit 0; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SESSION="atskills-ui-$$"
trap 'tuistory kill -s "$SESSION" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# A tiny project: one local skill, one cloud line.
mkdir -p "$WORK/.atskills/my-tdd"
cat > "$WORK/.atskills/my-tdd/SKILL.md" <<'EOF'
---
name: my-tdd
description: How this project does TDD
---
Write the failing test first.
EOF
cat > "$WORK/.atskills/.autotrigger" <<'EOF'
@gh:acme/skills/deploy   # cloud line (never fetched in this test)
EOF

fail() { echo "FAIL: $1"; tuistory snapshot -s "$SESSION" --trim || true; exit 1; }

tuistory launch "node $REPO/bin/atskills.js skills" -s "$SESSION" --cwd "$WORK" --cols 100 --rows 30 --env ATSKILLS_UI=basic --background >/dev/null
tuistory wait "atskills" -s "$SESSION" --timeout 8000 >/dev/null || fail "UI did not start"

SNAP="$(tuistory snapshot -s "$SESSION" --trim)"
grep -q "my-tdd" <<<"$SNAP" || fail "local skill not listed"
grep -q "@gh:acme/skills/deploy" <<<"$SNAP" || fail "cloud line not listed"
grep -q "view prompt" <<<"$SNAP" || fail "footer hints missing"
grep -q '\[ \] my-tdd' <<<"$SNAP" || fail "my-tdd should start unchecked"

# space → adds the line to .autotrigger (checkbox writes the file)
tuistory press -s "$SESSION" space >/dev/null
tuistory wait "added: my-tdd" -s "$SESSION" --timeout 4000 >/dev/null || fail "toggle note not shown"
grep -q '^my-tdd$' "$WORK/.atskills/.autotrigger" || fail ".autotrigger not written by checkbox"
tuistory snapshot -s "$SESSION" --trim | grep -q '\[x\] my-tdd' || fail "checkbox not checked after toggle"

# enter → view prompt: the exact injected text + the read trail
tuistory press -s "$SESSION" enter >/dev/null
tuistory wait "view prompt" -s "$SESSION" --timeout 6000 >/dev/null || fail "view prompt did not open"
PROMPT="$(tuistory snapshot -s "$SESSION" --trim)"
grep -q -- "- my-tdd: How this project does TDD (.atskills/my-tdd/SKILL.md)" <<<"$PROMPT" || fail "injected entry missing from view prompt"
grep -q "my-tdd/SKILL.md" <<<"$PROMPT" || fail "read trail missing local file link"
grep -q "@gh:acme/skills/deploy" <<<"$PROMPT" || fail "unreachable cloud line not reported"

# any key back, space to untoggle, q to quit
tuistory press -s "$SESSION" escape >/dev/null
tuistory wait "/skills" -s "$SESSION" --timeout 4000 >/dev/null || fail "did not return to list"
tuistory press -s "$SESSION" space >/dev/null
tuistory wait "removed: my-tdd" -s "$SESSION" --timeout 4000 >/dev/null || fail "untoggle note not shown"
grep -q '^my-tdd$' "$WORK/.atskills/.autotrigger" && fail "line not removed from .autotrigger"
tuistory type -s "$SESSION" "q" >/dev/null
sleep 0.3

echo "PASS: /skills UI e2e (render, toggle writes .autotrigger, view prompt with read trail, quit)"
