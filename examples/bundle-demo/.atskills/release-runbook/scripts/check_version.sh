#!/usr/bin/env bash
# Verifies the version in package.json was bumped relative to the last git tag.
set -euo pipefail

current=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
last=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "none")

echo "current: $current · last tag: $last"
if [ "$current" = "$last" ]; then
  echo "FAIL: version not bumped — see references/versioning-policy.md"
  exit 1
fi
echo "OK: version bumped"
