---
name: Google OAuth
description: Implement and debug Google OAuth login, callback routes, Auth.js or NextAuth providers, scopes, and account linking.
---

# Google OAuth

Use this skill when the prompt mentions Google sign-in or OAuth and the repo has OAuth evidence such as `next-auth`, `@auth/core`, Passport Google OAuth, or auth callback routes.

## Workflow

1. Inspect provider configuration, callback URL handling, scopes, secrets, and session creation.
2. Verify that frontend login entrypoints and backend callback routes agree.
3. Patch the smallest auth boundary and keep existing session/token conventions.
4. Verify with focused auth tests, typecheck, or a local OAuth callback path when available.
