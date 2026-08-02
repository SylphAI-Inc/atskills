---
name: deploy
description: How this team deploys — staged rollout with a canary and an explicit rollback point
---

# Deploy

1. Tag the release; CI builds the image.
2. Canary to 5% for 15 minutes; watch error rate and p95.
3. Roll to 100% or roll back — never leave a canary running overnight.
