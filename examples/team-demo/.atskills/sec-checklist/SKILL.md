---
name: sec-checklist
description: Security checklist to run before merging any change that touches auth, secrets, or user data
---

# Security checklist

1. No secrets in code, config, or test fixtures.
2. Every new endpoint checks authorization, not just authentication.
3. User input is validated at the boundary, not deep in the stack.
4. Errors never leak internal details to the client.
