#!/usr/bin/env bash
# E2E of the interactive /skills UI with a REAL cloud line, driven by tuistory.
#
# The synthetic UI test (e2e-skills-ui.sh) uses a never-fetched cloud line;
# this one follows an actual GitHub skill (@gh:anthropics/skills/skills/pdf)
# and proves the residency pipeline end to end: the line resolves through the
# validating cache, its frontmatter shows in the tree, "view prompt" contains
# the real skill row, and a SECOND launch serves the cache (cloud·cache) —
# the "cloud lines refresh once per session" cadence, live.
#
# Network-gated: SKIPs cleanly when offline. Run: bash tests/e2e-skills-ui-real.sh
set -euo pipefail

command -v tuistory >/dev/null || { echo "SKIP: tuistory not installed"; exit 0; }
command -v git >/dev/null || { echo "SKIP: git not installed"; exit 0; }
if ! git ls-remote https://github.com/anthropics/skills.git HEAD >/dev/null 2>&1; then
  echo "SKIP: no network (github unreachable)"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SESSION="atskills-ui-real-$$"
export ATSKILLS_CACHE="$WORK/cache"
trap 'tuistory kill -s "$SESSION" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/.atskills"
cat > "$WORK/.atskills/.autotrigger" <<'EOF'
@gh:anthropics/skills/skills/pdf
EOF

fail() { echo "FAIL: $1"; tuistory snapshot -s "$SESSION" --trim || true; exit 1; }

launch() {
  tuistory launch "node $REPO/bin/atskills.js skills" -s "$SESSION" --cwd "$WORK" \
    --cols 110 --rows 32 --env ATSKILLS_UI=basic --env "ATSKILLS_CACHE=$ATSKILLS_CACHE" \
    --background >/dev/null
  tuistory wait "atskills" -s "$SESSION" --timeout 30000 >/dev/null || fail "UI did not start"
}

echo "── first session: the cloud line resolves live ──"
launch
# The row must resolve to the REAL skill's frontmatter, not just echo the line.
tuistory wait "pdf" -s "$SESSION" --timeout 60000 >/dev/null || fail "cloud row did not appear"
SNAP="$(tuistory snapshot -s "$SESSION" --trim)"
grep -q "@gh:anthropics/skills/skills/pdf" <<<"$SNAP" || fail "cloud line not listed"

# view prompt → the injected block carries the real skill's row + read trail
tuistory press -s "$SESSION" enter >/dev/null
tuistory wait "view prompt" -s "$SESSION" --timeout 60000 >/dev/null || fail "view prompt did not open"
PROMPT="$(tuistory snapshot -s "$SESSION" --trim)"
grep -qi -- "- pdf:" <<<"$PROMPT" || fail "real skill row missing from injected prompt"
grep -q "anthropics" <<<"$PROMPT" || fail "read trail missing the cloud ref"
tuistory press -s "$SESSION" escape >/dev/null
tuistory type -s "$SESSION" "q" >/dev/null
sleep 0.5
tuistory kill -s "$SESSION" >/dev/null 2>&1 || true

echo "── cache landed on disk ──"
[ -n "$(find "$ATSKILLS_CACHE" -name 'SKILL.md' -path '*pdf*' -print -quit 2>/dev/null)" ] \
  || [ -n "$(find "$ATSKILLS_CACHE" -type f -print -quit 2>/dev/null)" ] \
  || fail "nothing cached after first session"

echo "── second session: served through the validating cache ──"
# The status tag lives in `triggers` (the UI list shows origin, not transport):
# unchanged upstream must read as a cache hit, not a fresh download.
TRIG="$(cd "$WORK" && node "$REPO/bin/atskills.js" triggers 2>&1)"
grep -q "·cache]" <<<"$TRIG" || fail "second resolve was not a cache hit: $TRIG"

SESSION="${SESSION}-2"
launch
tuistory wait "pdf" -s "$SESSION" --timeout 60000 >/dev/null || fail "cloud row missing on relaunch"
tuistory snapshot -s "$SESSION" --trim | grep -q "@gh:anthropics/skills/skills/pdf" \
  || fail "cloud line not listed on relaunch"
tuistory type -s "$SESSION" "q" >/dev/null
sleep 0.3

echo "PASS: /skills UI real-cloud e2e (live resolve, view prompt, cache on relaunch)"
