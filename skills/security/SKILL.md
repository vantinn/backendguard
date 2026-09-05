---
name: Backend Security
description: Enforce authentication, authorization, input validation, secret handling, and data-exposure guardrails on backend API endpoints.
---

# Backend Security

Use this skill for any task touching authentication, authorization, secrets, input validation, or anything that could expose sensitive data through an API response.

## Workflow

1. Identify the security surface: authentication, authorization, input handling, secrets, or response payloads.
2. Passwords and secrets: verify hashing (bcrypt/argon2), never log or return them, and check `.env`/config for hardcoded credentials.
3. Authorization: confirm the check happens at the service boundary (not just a route guard), covers resource ownership where relevant, and follows least-privilege/RBAC.
4. Input validation: confirm every external input has DTO/schema validation (`class-validator`, `zod`) before it reaches a service or query.
5. Data exposure: confirm sensitive fields (password hash, tokens, refresh tokens, internal secrets) are excluded from API responses via a dedicated response DTO, not the persistence entity.
6. API hardening: check rate limiting, CORS configuration, and that error messages don't leak internals (stack traces, query text, secrets).
7. Patch the smallest security boundary and add or adjust a focused test that would fail without the fix.

## Non-negotiables

- Never return a raw ORM entity that contains `password`, `passwordHash`, `refreshToken`, `secret`, or `apiKey` fields.
- Never log secrets, tokens, or full request bodies that may contain credentials.
- Never build a SQL string by concatenating user input — use parameterized queries or the ORM's query builder.
