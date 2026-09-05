---
name: JWT Auth
description: Implement and debug JWT login, access tokens, refresh tokens, guards, middleware, and authorization headers.
---

# JWT Auth

Use this skill when the prompt mentions JWT, access tokens, refresh tokens, bearer auth, guards, or token verification with project evidence such as `jsonwebtoken` or auth middleware.

## Workflow

1. Inspect token signing, verification, expiry, refresh rotation, and guard or middleware wiring.
2. Confirm how tokens are stored and sent by clients.
3. Patch the narrow auth boundary without changing unrelated authorization policy.
4. Verify with focused auth tests and typecheck.
