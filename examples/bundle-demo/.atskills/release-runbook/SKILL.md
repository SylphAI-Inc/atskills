---
name: release-runbook
description: How this project cuts a release — version bump, changelog, notes, and the checks that gate it
---

# Release runbook

1. Run `scripts/check_version.sh` — it verifies the version bump matches our
   policy. The policy itself is in `references/versioning-policy.md`; read it
   only if the check fails and you need to know why.
2. Walk `references/release-checklist.md` top to bottom. Every unchecked item
   blocks the release.
3. Write the release notes from `templates/release-notes.md` — copy it, fill
   every `<...>` placeholder, delete unused sections.
4. Tag and push. CI does the rest.
