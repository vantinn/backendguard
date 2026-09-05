# BackendGuard Launch Kit

## Positioning

BackendGuard is an engineering control layer between AI coding agents and production backend code: it detects your NestJS/PostgreSQL/TypeORM/Prisma stack, injects only the security/architecture/database rules relevant to the current task, and reports what was actually followed afterward.

One-line pitch:

```text
BackendGuard makes Codex, Claude Code, and Antigravity follow the right backend engineering rules — security, architecture, database — by injecting task-relevant context before each task and reporting what was followed afterward.
```

## Hacker News

Title:

```text
BackendGuard - backend engineering guardrails for AI coding agents (NestJS/PostgreSQL/TypeORM/Prisma)
```

Post:

```text
I built BackendGuard because I kept seeing agents ship backend code that technically worked but skipped things a senior reviewer would flag: no rate limiting on auth routes, the password hash returned from an API response, a schema change with no index on the filtered column.

The problem isn't that agents can't read AGENTS.md. It's that the relevant rule is buried, or there's no first-party rule library for backend-specific risk (auth, authorization, N+1 queries, migration safety) in the first place.

BackendGuard runs as native hooks plus a local MCP server. On each prompt it:

- detects your stack from package.json/lockfiles/schema (never guesses)
- retrieves task-relevant security/architecture/database/testing rules
- suggests likely files and rule packs (security, nestjs, postgresql, typeorm, prisma, redis)
- records runtime telemetry
- reports a severity-ranked compliance summary (CRITICAL/HIGH/MEDIUM/LOW/INFO) after the task, with file/line evidence

It supports Codex, Claude Code, and Antigravity. It is local-first and uses local MiniLM embeddings.

Install:

npm install -g @vantin/backendguard
backendguard setup

Repo: https://github.com/vantinn/backendguard
```

## X / Twitter

Short:

```text
An AI agent can read your AGENTS.md and still ship a backend endpoint that returns the password hash.

BackendGuard detects your stack, injects the security/database rules that matter for the task, then reports what was actually followed — with file/line evidence.

npm install -g @vantin/backendguard
backendguard setup

https://github.com/vantinn/backendguard
```

With GIF:

```text
AGENTS.md is not enough when the rule that matters is buried, or there's no backend-specific rule library at all.

BackendGuard:
1. detects your NestJS/PostgreSQL/TypeORM/Prisma stack
2. injects the security/architecture/database rules relevant to the task
3. suggests files and rule packs
4. reports a severity-ranked compliance summary afterward

Demo below.
```

## GitHub Repo Description

```text
AI backend engineering guardrails for NestJS, PostgreSQL, TypeORM, and Prisma — task-aware security/architecture/database context for AI coding agents, plus post-task compliance reporting.
```

## npm Description

```text
AI backend engineering guardrails for NestJS, PostgreSQL, TypeORM, and Prisma — task-aware security/architecture/database context for AI coding agents, plus post-task compliance reporting.
```

## Launch Checklist

- [ ] README starts with problem, demo, install, before/after.
- [ ] Demo GIF or terminal clip recorded (security-relevant scenario, e.g. registration endpoint).
- [ ] `npm view @vantin/backendguard version` matches latest tag.
- [ ] Fresh install tested in a separate NestJS/PostgreSQL project.
- [ ] GitHub repo description updated.
- [ ] HN post prepared.
- [ ] X post prepared with GIF.
