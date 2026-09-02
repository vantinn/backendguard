# BackendGuard Demo Script

Use this to record the README GIF or a short terminal clip.

The current rendered demo is checked in at:

```text
docs/demo/backendguard-demo.gif
```

It was generated from an actual terminal transcript using:

```text
node docs/demo/render-terminal-gif.mjs <terminal-log> docs/demo/backendguard-demo.gif
```

## Goal

Show one thing clearly:

```text
"Add a registration endpoint" -> BackendGuard injects the security/nestjs/postgresql rules relevant to that task -> backendguard report proves whether they were followed
```

## Setup

```bash
npm install -g @vantin/backendguard
backendguard setup --yes --agents codex
```

Restart Codex after setup.

## Fixture Rule

Use a NestJS + PostgreSQL repo whose `AGENTS.md` contains a rule like:

```text
Never return password hash, refresh token, or secret fields from an API response.
```

The rule should be somewhere below the first screen of `AGENTS.md` so the demo makes the lost-in-the-middle problem obvious — that's exactly the case BackendGuard's task-aware retrieval is built to fix.

## Recording Flow

1. Show the rule buried in `AGENTS.md`.
2. Run `backendguard stack` to show the detected NestJS/PostgreSQL/Prisma stack.
3. Start Codex in the project.
4. Submit:

```text
Add a user registration endpoint
```

5. Show the `hook context` block:

```text
## Critical BackendGuard rules
- Never return password hash, refresh token, or secret fields from an API response.
## Suggested files to check
...
## Suggested skills
security, nestjs
```

6. Let the task finish so the Stop hook writes the report.
7. Show:

```bash
backendguard report
backendguard evidence
```

If the agent returned the entity directly (including `passwordHash`), the report should show that rule as `ignored` with a file/line citation — that's the payoff shot.

## Side-By-Side Clip

Record two short terminal panes:

| Left | Right |
| --- | --- |
| Codex without BackendGuard. | Codex with BackendGuard. |
| Agent returns the raw user entity, including `passwordHash`. | Hook context shows the security rule before the controller is written. |
| No evidence report. | `backendguard report` shows followed/ignored/unknown with file/line evidence. |

## Talking Points

- BackendGuard does not replace Codex, Claude Code, or Antigravity, and it does not generate application code itself.
- It runs through native hooks plus a local `ctx-mcp` MCP server.
- Rule/skill packs only activate on real repo evidence (dependencies, config files, schema) — it never claims a technology the repo doesn't show.
- Runtime history is isolated by project path and shared across supported agents.
- It reports what happened after the task, with severity-ranked findings and file/line evidence, instead of only hoping the agent remembered the rule.

## Release Checks

Run before recording or posting:

```bash
npm run validate:plugin
npm test
npm run test:mcp
npm pack --dry-run
npm view @vantin/backendguard version
```
