#!/usr/bin/env bash
# E2E against REAL GitHub repos — the coverage synthetic fixtures cannot give.
#
# The collection cap exists because of real aggregator repos (6k+ skills), and
# two of its bugs only ever showed against them: the ENOBUFS listing overflow
# (a multi-megabyte ls-tree silently read as "0 skills — allowed") and the
# save fallback that retried a refusal per-file. Both are pinned here against
# the actual repos, plus the positive path on a small, stable official skill.
#
# Network-gated: SKIPs cleanly when offline. Run: bash tests/e2e-real-repos.sh
set -euo pipefail

command -v git >/dev/null || { echo "SKIP: git not installed"; exit 0; }
if ! git ls-remote https://github.com/anthropics/skills.git HEAD >/dev/null 2>&1; then
  echo "SKIP: no network (github unreachable)"
  exit 0
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
export ATSKILLS_CACHE="$WORK/cache"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
mkdir -p project/.atskills
cd project

CLI="node $REPO/bin/atskills.js"
MEGA="gh:sickn33/antigravity-awesome-skills"
SMALL="gh:anthropics/skills/skills/pdf"

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }

echo "── cap refusal on GET (the 6k aggregator) ──"
set +e
GET_OUT="$($CLI get "$MEGA" 2>&1)"; GET_RC=$?
set -e
[ "$GET_RC" -ne 0 ] && ok "get exits non-zero" || bad "get should refuse ($GET_RC)"
grep -qE '[0-9]{3,} skills' <<<"$GET_OUT" && ok "refusal names the real count" || bad "no count in: $GET_OUT"
grep -q "$MEGA/" <<<"$GET_OUT" && ok "refusal suggests loadable sub-collections" || bad "no suggestions in: $GET_OUT"

echo "── cap refusal on SAVE (verdict, not transport failure) ──"
set +e
SAVE_OUT="$($CLI save "$MEGA" 2>&1)"; SAVE_RC=$?
set -e
[ "$SAVE_RC" -ne 0 ] && ok "save exits non-zero" || bad "save should refuse ($SAVE_RC)"
# The ENOBUFS regression turned this into a git error; the fallback regression
# turned it into a slow full download. The honest refusal names the count.
grep -qE '[0-9]{3,} skills' <<<"$SAVE_OUT" && ok "save refusal is the cap, not a transport error" || bad "wrong refusal: $SAVE_OUT"
[ -z "$(find .atskills -mindepth 1 -not -name '.autotrigger' -print -quit)" ] \
  && ok "nothing vendored into .atskills/" || bad ".atskills/ not empty after refusal"

echo "── positive path: a small official skill ──"
set +e
PDF_OUT="$($CLI get "$SMALL" 2>&1)"; PDF_RC=$?
set -e
[ "$PDF_RC" -eq 0 ] && ok "get succeeds" || bad "get failed: $PDF_OUT"
grep -qi "pdf" <<<"$PDF_OUT" && ok "SKILL.md content printed" || bad "no content in output"

set +e
PDF2_OUT="$($CLI get "$SMALL" 2>&1)"; PDF2_RC=$?
set -e
[ "$PDF2_RC" -eq 0 ] && grep -q 'cloud·cache' <<<"$PDF2_OUT" \
  && ok "second get served from the validating cache" || bad "no cache hit on second get: $(head -2 <<<"$PDF2_OUT")"

set +e
SAVE2_OUT="$($CLI save "$SMALL" 2>&1)"; SAVE2_RC=$?
set -e
[ "$SAVE2_RC" -eq 0 ] && ok "save succeeds" || bad "save failed: $SAVE2_OUT"
SRC=".atskills/gh/anthropics/skills/skills/pdf/.source"
[ -f "$SRC" ] && grep -qE 'rev:[0-9a-f]{40}' "$SRC" \
  && ok ".source records the full upstream sha" || bad "bad .source: $(cat "$SRC" 2>/dev/null)"

echo "── parent save absorbs a saved child (the real SylphAI skills library) ──"
# Save ONE child first; the parent namespace exists with no .source of its own.
CHILD="gh:sylphai-inc/skills/skills/glowmotion"
PARENT="gh:sylphai-inc/skills/skills"
set +e
CHILD_OUT="$($CLI save "$CHILD" 2>&1)"; CHILD_RC=$?
set -e
[ "$CHILD_RC" -eq 0 ] && ok "child save succeeds" || bad "child save failed: $CHILD_OUT"

# Saving the PARENT must absorb the unedited child: superset, one stamp.
set +e
PARENT_OUT="$($CLI save "$PARENT" 2>&1)"; PARENT_RC=$?
set -e
[ "$PARENT_RC" -eq 0 ] && ok "parent save succeeds over the saved child" || bad "parent save failed: $PARENT_OUT"
grep -q 'superset' <<<"$PARENT_OUT" && ok "absorption is announced (superset)" || bad "no superset note: $PARENT_OUT"
PDIR=".atskills/gh/sylphai-inc/skills/skills"
[ -f "$PDIR/.source" ] && ok "one stamp at the parent" || bad "no parent .source"
[ ! -f "$PDIR/glowmotion/.source" ] && ok "child stamp absorbed" || bad "child .source still present"
[ -f "$PDIR/glowmotion/SKILL.md" ] && [ "$(find "$PDIR" -name SKILL.md | wc -l | tr -d ' ')" -ge 2 ] \
  && ok "collection landed (child + siblings present)" || bad "collection incomplete"

# An EDITED child must refuse by name and stay untouched.
rm -rf "$PDIR" && $CLI save "$CHILD" >/dev/null 2>&1
echo "house rules" >> "$PDIR/glowmotion/SKILL.md"
set +e
EDIT_OUT="$($CLI save "$PARENT" 2>&1)"; EDIT_RC=$?
set -e
[ "$EDIT_RC" -ne 0 ] && grep -q 'glowmotion' <<<"$EDIT_OUT" \
  && ok "edited child refuses by name" || bad "edited child not protected: $EDIT_OUT"
grep -q 'house rules' "$PDIR/glowmotion/SKILL.md" && ok "edited copy untouched" || bad "edit lost"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
