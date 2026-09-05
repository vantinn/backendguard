# BackendGuard

BackendGuard gives AI coding agents (Codex, Claude Code, Antigravity, GitHub Copilot) task-aware backend engineering context for Node.js/NestJS + PostgreSQL/Prisma/TypeORM projects, and checks what actually happened after the task is done.

[![npm version](https://img.shields.io/npm/v/@vantin/backendguard.svg)](https://www.npmjs.com/package/@vantin/backendguard)
[![CI](https://github.com/vantinn/backendguard/actions/workflows/ci.yml/badge.svg)](https://github.com/vantinn/backendguard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Published package: [`@vantin/backendguard`](https://www.npmjs.com/package/@vantin/backendguard)

## Overview

An AI coding agent working in a large backend repo can read your whole `AGENTS.md`, but the one rule that matters for the current task ("never return the password hash from an API response") is easy to lose in a file full of unrelated instructions. BackendGuard sits between the agent and your code: it detects your stack, works out which of your project's engineering rules are actually relevant to the task in front of the agent, injects only those before the agent starts, and afterward checks the resulting diff — with both keyword-based rule matching and structural (AST-based) code analysis — for evidence of what was actually followed.

It does not write application code. It decides what the agent should know before it writes code, and reports what happened after.

## Why This Exists

Two failure modes show up repeatedly when AI agents write backend code:

- **The relevant rule exists but doesn't reach the agent.** A plain `AGENTS.md` gives an agent static, whole-file instructions — important, task-specific rules get buried once the file grows, and nothing ranks them by relevance to the current prompt.
- **Nobody checks whether the rule was actually followed.** An agent can say "done" without the returned response DTO actually excluding the password hash, without the new endpoint actually being guarded, without the new query actually being paginated.

BackendGuard addresses both: task-aware retrieval before the task, and evidence-based checking after it.

## What It Does

BackendGuard today:

- Detects your backend stack (framework, language, database, ORM, cache, auth, validation, containerization, CI) from real `package.json`/lockfile/config evidence — never a guess.
- Parses your project's `AGENTS.md` and ranks its rules against the current task, so the agent sees a short, relevant excerpt instead of the whole file.
- Ships a first-party backend engineering rule library (security, NestJS, PostgreSQL, TypeORM, Prisma, Redis, JWT auth, Google OAuth) as installable packs that only activate when your repo has real supporting evidence.
- Suggests likely files to check for the current task, using prepared local indexes (embeddings, import graph, optional project-graph adapters).
- After the task, checks the git diff against the rules that were scheduled for it, and — for NestJS/TypeORM TypeScript source — runs structural (AST-based) checks for concrete patterns: a sensitive entity field returned with no response DTO, a route with no auth guard, a hardcoded secret literal, an unvalidated request body, a raw error/stack trace built into a response, an unbounded or N+1 TypeORM query, or multiple writes with no transaction boundary.
- Produces one severity-ranked compliance report combining both check layers, each finding labeled with a confidence level and a file/line citation.
- Scores whether a repository has enough `AGENTS.md` rules, rule-pack coverage, and workflows for BackendGuard to be useful at all (the "BackendGuard Ready" tier).
- Integrates with Codex, Claude Code, Antigravity, and GitHub Copilot through each agent's native hook/MCP mechanism.

What it explicitly does not do: it does not generate or write application code, and it does not guarantee security, scalability, or production readiness. See [Limitations](#limitations).

## How It Works

```text
AI coding agent (Codex / Claude Code / Antigravity / Copilot)
        |
        v
Stack detection (framework, database, ORM, cache, auth -- from package.json/lockfiles/schema, never guessed)
        |
        v
Task-aware rule retrieval (security, architecture, database, performance, testing)
        |
        v
Relevant rules + suggested files/skills injected before the agent starts
        |
        v
Agent performs the task
        |
        v
Post-task check: AGENTS.md rule compliance (git diff) + structural AST analysis of changed source
        |
        v
Severity-ranked compliance report (Security/Architecture/Database/Performance/Testing), each finding with a confidence level
```

## Supported Stack

Detection is evidence-based — a field is reported as "Not detected" rather than silently omitted or guessed:

| Layer | Status | Detected from |
| --- | --- | --- |
| Framework | Supported | `@nestjs/core` (NestJS), `express` |
| Language | Supported | TypeScript (`typescript` dependency or `tsconfig.json`) |
| Database | Supported | PostgreSQL (`pg` dependency, `provider = "postgresql"` in `prisma/schema.prisma`, or `ormconfig.*`) |
| ORM | Supported | Prisma (`@prisma/client`, `prisma/schema.prisma`) or TypeORM (`typeorm`, `@nestjs/typeorm`) |
| Cache | Supported (stack detection only) | Redis (`redis`, `ioredis`) |
| Queue | Supported (stack detection only) | BullMQ (`bullmq`, `bull`) |
| Authentication | Supported | JWT (`@nestjs/jwt`, `jsonwebtoken`, `passport-jwt`) |
| Validation | Supported | `class-validator`, `zod`, `joi` |
| Containerization | Supported (stack detection only) | Docker (`Dockerfile`, `docker-compose.yml`) |
| CI | Supported (stack detection only) | GitHub Actions (`.github/workflows`) |

Structural (AST-based) code analysis today covers NestJS + TypeORM patterns specifically. Stack *detection* covers Prisma equally, but Prisma-specific structural checks (schema.prisma parsing, generated-client call sites) are not implemented yet — see [Limitations](#limitations).

```bash
backendguard stack
```

```text
Backend Stack

Framework       NestJS
Language        TypeScript
Database        PostgreSQL
ORM             Prisma
Cache           Redis
Authentication  JWT

Not detected: Queue, Container, CI, Testing
```

The stack pipeline is extensible without code changes to core detection logic — see [`skills/_template/`](skills/_template/) and [Extending BackendGuard](#extending-backendguard).

## Key Capabilities

### Task-aware context retrieval

BackendGuard injects a compact, task-specific brief before the agent works — not the entire `AGENTS.md`:

```text
## Critical BackendGuard rules
- Never return password hash, refresh token, or secret fields from an API response.
- Add rate limiting to authentication endpoints (login, register, password reset).

## Suggested files to check
- src/users/user.controller.ts
- src/users/dto/create-user.dto.ts
- src/users/user.service.ts

## Suggested skills
security, nestjs
```

Preview what would be injected for a task without running an agent:

```bash
backendguard context -- "add rate limiting to the login endpoint"
```

### Backend rule library

A first-party set of installable skill packs — each one a `SKILL.md` (model-visible workflow) plus `skill.yaml` (prompt triggers, project evidence, negative triggers) — that only activates when your repo shows real supporting evidence:

| Pack | Covers |
| --- | --- |
| [`security`](skills/security/) | Authentication, authorization/RBAC, input validation, secrets, data exposure in API responses |
| [`nestjs`](skills/nestjs/) | Module boundaries, dependency injection, guards/interceptors/pipes, DTOs vs. entities, exception filters |
| [`postgresql`](skills/postgresql/) | Indexing, N+1 detection, transactions, migration safety, query performance |
| [`typeorm`](skills/typeorm/) | Entities, relations (eager/lazy), QueryBuilder, transactions, migrations |
| [`prisma`](skills/prisma/) | Schema, migrations, generated client, relations, transactions |
| [`redis`](skills/redis/) | Cache, TTL, sessions, rate limits, queues, pub/sub |
| [`jwt-auth`](skills/jwt-auth/) | JWT issuing/verification, refresh rotation, guards/middleware |
| [`oauth-google`](skills/oauth-google/) | Google OAuth, callback routes, Auth.js/Passport providers |

A project with `@nestjs/core`, `bcrypt`, and `class-validator` routes to `security` + `nestjs`; a project with `typeorm`/`pg` routes to `postgresql` + `typeorm` instead of `prisma`. Inspect routing for a task:

```bash
backendguard rules doctor -- "add rate limiting to the login endpoint"
```

### Post-task compliance report

After the task, BackendGuard checks the working tree against two independent layers and merges both into one severity-ranked report:

1. **AGENTS.md rule compliance** — diffs the working tree against the specific rules that were scheduled for the task and classifies each as followed, ignored, unknown, or unmeasurable, based on keyword evidence in the diff. This layer is heuristic by construction: it can only reason about whatever rules your own `AGENTS.md` contains.
2. **Structural analysis** (`analysis/security/nestjs-security-analyzer.js`) — parses changed TypeScript/NestJS/TypeORM source with the TypeScript compiler API and checks for concrete, evidence-backed patterns regardless of what `AGENTS.md` says. See [docs/architecture/compliance-engine.md](docs/architecture/compliance-engine.md#structural-analysis-layer) for the full check list.

```bash
backendguard check      # analyze uncommitted changes on demand
backendguard report      # show the last agent task's report
```

Compliance is evidence-based, not a guarantee: a category with no measured rules is reported as "not evaluated," never a false "PASS," and every finding cites a file/line plus a confidence label. See [Example Output](#example-output) below, and [Limitations](#limitations).

### Repository readiness score

`backendguard doctor` scores whether a repository has enough `AGENTS.md` rules, rule-pack coverage, and workflows for BackendGuard to be useful at all:

```bash
backendguard doctor
```

```text
Repository Score

Rules: 92
Skill Coverage: 88
Project Skill Overrides: 0
Workflows: 84

Overall:
BackendGuard Ready Silver
```

### AI agent integrations

| Agent | Status | How context reaches it |
| --- | --- | --- |
| Codex | Supported | Native plugin (`plugins/backendguard/` is the Codex plugin directly) — `UserPromptSubmit`/`Stop` hooks |
| Claude Code | Supported | Hooks merged into `~/.claude/settings.json`; `UserPromptSubmit` `hookSpecificOutput.additionalContext` |
| Antigravity | Supported | Hooks in `~/.gemini/config/hooks.json`; context via `PreInvocation` `ephemeralMessage` |
| GitHub Copilot | Supported | Hooks + MCP install via `integrations/copilot/` |

All four share the same local rule/stack/compliance pipeline and the same per-project runtime history — see [Runtime Files](#runtime-files).

## Installation

```bash
npm install -g @vantin/backendguard
backendguard setup
```

`npm install` only installs the CLI — there is no postinstall side effect. Setup (agent hook/MCP registration, embedding model download, index warmup) runs only when you explicitly call `backendguard setup`.

Without a global install:

```bash
npx @vantin/backendguard@latest setup
```

Scriptable, non-interactive setup:

```bash
backendguard setup --yes
backendguard setup --yes --agents codex,claude,agy
```

See [Detailed Install](#detailed-install) for exactly what each agent's install target does.

## Quick Start

```bash
npm install -g @vantin/backendguard
backendguard setup --yes --agents codex
```

Restart Codex, then submit a task in your NestJS/PostgreSQL project, e.g.:

```text
Add a user registration endpoint
```

BackendGuard injects the relevant rules from your `AGENTS.md` (and any matching rule packs) before the agent writes the controller. Once the task finishes:

```bash
backendguard report
backendguard evidence
```

## Example Output

```text
# BackendGuard Report

## Summary
- Efficiency: 67%
- Injected rules: 3
- Measured rules: 3

## Backend Engineering Compliance

- Security: FAIL
- Architecture: PASS
- Database: not evaluated
- Performance: not evaluated
- Testing: not evaluated

### Issues

[HIGH] SEC-001 Sensitive entity field may be exposed in an API response.
- Category: Security
- Confidence: medium-structural
- Evidence: src/users/user.controller.ts:40
- Recommendation: Map the result to a response DTO that excludes passwordHash before returning it.
```

AGENTS.md-rule findings are always `confidence: heuristic` (keyword evidence in a diff); structural findings carry `high-structural`, `medium-structural`, or `low-structural` depending on how directly the check's AST pattern implies the problem — e.g. an unguarded `POST` route is `high-structural`, an unguarded `GET` is `low-structural` because public read endpoints are often intentional.

## Using BackendGuard In An Existing Project

BackendGuard is non-invasive: it does not modify your application source, and adding it to an existing repository requires no code changes.

1. Run `backendguard setup` from the repository root. It detects your stack automatically (no configuration file to write by hand).
2. If your project has an `AGENTS.md` with engineering rules already, BackendGuard starts ranking and injecting from it immediately. If it doesn't, `backendguard doctor` will report "Not Ready" and tell you what's missing:

   ```bash
   backendguard doctor --fix
   ```

   generates starter project skills and a workflow file without overwriting anything that already exists.
3. Optionally install the backend rule packs relevant to your stack:

   ```bash
   backendguard rules
   ```
4. Restart your agent (Codex/Claude Code/Antigravity/Copilot) and use it normally.

BackendGuard writes its own runtime state under `~/.backendguard/` (global) and a small workspace marker at `.backendguard/workspace.json` in the target repo, which it adds to `.gitignore` automatically. Nothing else in your repository is touched unless you explicitly run `backendguard doctor --fix` or `backendguard setup --generate-project-context`.

## CLI Reference

| Command | Use it for |
| --- | --- |
| `backendguard setup` | Recommended first-run install flow. |
| `backendguard analyze` | Run every applicable static analyzer over the whole project. |
| `backendguard analyze --fail-on high` | The same, exiting 1 when a HIGH or CRITICAL finding is reported — for CI. |
| `backendguard analyze --json` | Machine-readable findings, including evidence, confidence and remediation. |
| `backendguard analyze --list-analyzers` | Show the registered analyzers and what each covers. |
| `backendguard stack` | Detect and print the backend stack (framework/database/ORM/cache/auth). |
| `backendguard stack --evidence` | The same, showing the dependency or file behind every detection. |
| `backendguard context -- "task"` | Preview which backend engineering rules/files/skills BackendGuard would inject. |
| `backendguard doctor` | Score repository readiness for the "BackendGuard Ready" badge. |
| `backendguard doctor --fix` | Generate starter project skills and workflow when the repo is missing them. |
| `backendguard check` | Analyze uncommitted changes for security/architecture/database/testing compliance risk. |
| `backendguard report` | Show the last task's severity-ranked compliance report. |
| `backendguard evidence` | Show why each rule was marked followed/ignored/unknown, with file/line citations. |
| `backendguard stats` | Show workspace-level usage and effectiveness metrics. |
| `backendguard benchmark -- "task"` | Compare raw AGENTS.md ordering vs BackendGuard scheduling. |
| `backendguard benchmark --skills` | Run the rule/skill selection eval benchmark. |
| `backendguard leaderboard --hallucination` | Run the offline deterministic hallucination benchmark. |
| `backendguard sync --rules` | Sync project rules across agents (see [Ruler Sync](#ruler-sync)). |
| `backendguard sync --skills` | Sync rule/skill packs across agents (see [Skill Sync](#skill-sync)). |
| `backendguard sync --workflows` | Sync workflow markdown across Claude/Codex/Antigravity (see [Workflow Discovery](#workflow-discovery)). |
| `backendguard rules` (alias: `skills`) | Install community/backend rule packs. |
| `backendguard rules doctor -- "task"` | Explain rule-pack routing for a task. |
| `backendguard --version` / `--help` | Version / usage. |

Every command has its own help with its options and exit codes:

```bash
backendguard analyze --help
backendguard check --help
```

The command table lives in `cli/command-registry.js` and a test asserts it never drifts from the dispatch chain, so `--help` cannot describe a command that does not exist.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command completed and nothing blocking was found. |
| `1` | The command ran correctly and found issues at or above `--fail-on`. |
| `2` | The invocation was wrong: unknown command, unknown flag, bad flag value. |
| `3` | The environment is not ready: not a git repository, no such directory. |
| `70` | A bug in BackendGuard. Re-run with `--debug` for a stack trace. |

Expected user errors print one line and a hint — never a stack trace.

Do not run `backendguard install --agent codex|claude|agy` in a shell — the `|` character is a pipe, so the shell would run `backendguard install --agent codex`, pipe its output into `claude`, then into `agy`. Pick one command per agent instead (see [Detailed Install](#detailed-install)).

## Extending BackendGuard

| Goal | Where to start |
| --- | --- |
| Add a rule pack for a new framework/ORM/technology | Copy [`skills/_template/`](skills/_template/); see [docs/architecture/rule-engine.md](docs/architecture/rule-engine.md#adding-a-rule-pack) |
| Add an analyzer for a new framework/ORM/database | Write one object and register it; see [docs/architecture/analysis.md](docs/architecture/analysis.md#adding-an-analyzer) |
| Add a check to an existing analyzer | [docs/architecture/analysis.md](docs/architecture/analysis.md#adding-a-check) |
| Add stack detection for a new technology | `analysis/stack-detector.js`; see [docs/architecture/analysis.md](docs/architecture/analysis.md#adding-stack-detection) |
| Add a new AI agent integration | `integrations/<agent>/`; see [docs/architecture/integrations.md](docs/architecture/integrations.md#adding-a-new-agent) |
| Add a new CLI command | Add an entry to `cli/command-registry.js`, then a branch in `cli/backendguard.js` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests, and PR expectations.

## Benchmarks

These are internal/offline fixture benchmarks, not external real-world or head-to-head agent benchmarks. They measure whether BackendGuard's routing changes based on repo evidence — not whether BackendGuard's suggestions are correct in an absolute sense, and not a comparison against Codex, Gemini, Claude Code, or Cursor's own output quality.

Offline deterministic benchmark measuring whether the right context is chosen for a given repo/prompt pair:

```bash
backendguard leaderboard --hallucination
```

| System | Correct context choice |
| --- | ---: |
| Raw heuristic baseline | 10.0% |
| BackendGuard evidence benchmark | 80.0% |

Live agent benchmark support exists (`backendguard leaderboard --hallucination --live --agent codex`), but calling out to an installed agent CLI requires working local auth/session access; a missing or unauthenticated CLI is reported as skipped rather than blocking the command.

Rule/skill selection fixture benchmark:

```bash
backendguard benchmark --skills
```

| Metric | Result |
| --- | ---: |
| Cases | 60 |
| Top-1 Accuracy | 90.0% |
| Top-3 Recall | 93.8% |
| False Positive Rate | 0.0% |
| Confidence Calibration | 100.0% |
| Negative Gate Accuracy | 100.0% |

This shows BackendGuard changes its suggestions based on repository evidence across auth, database, ORM, caching, testing and adversarial negative cases (a repository with both `typeorm` and `prisma` evidence must not route to both ORMs at once). It is not proof of real-world routing accuracy at scale.

### Detection quality

```bash
npm run evaluate:detection
```

Measured against `evaluation/detection-quality/fixtures/` — three realistic projects with `expected-findings.json` labels: NestJS + TypeORM + PostgreSQL and NestJS + Prisma, each with deliberately planted defects, plus a "secure baseline" written correctly while using `password`, `passwordHash`, `secret`, `token` and `query` throughout.

| Metric | Result |
| --- | ---: |
| Planted defects found (recall) | 29/29 — 100% |
| Findings inside files labelled correct (false positives) | 0 |
| Findings on the adversarial secure baseline | 0 |
| Stack detection mismatches | 0 |
| ORM analyzer run against the wrong ORM | 0 |

**Read this honestly:** the fixtures and the checks were written together, so 100% recall on this corpus is a regression gate, not evidence of detection quality on code BackendGuard has never seen. The number that carries the most weight is the third row — a realistic, correct service producing zero findings — because that is the failure mode (crying wolf) that gets a tool switched off. `tests/detection-quality.test.js` fails the build on any regression in either direction.

### Scale

```bash
node evaluation/performance/run-scale-benchmark.js
```

A generated 2000-file NestJS + TypeORM service parses and analyzes in roughly 300 ms, scaling linearly at about 0.15 ms per file. That is wall-clock time on one machine, used as a regression signal; it is not a published performance figure.

### Release readiness

```bash
npm run evaluate
```

A deterministic, weighted rubric plus eight release gates, runnable against any checkout — including an older one — so a before/after comparison is measured rather than asserted. See [docs/evaluation/release-validation.md](docs/evaluation/release-validation.md).

## Safety Model

| Guarantee | Behavior |
| --- | --- |
| Standalone by default | `backendguard setup` works without `code-review-graph`, `codegraph`, or `agent-memory`. |
| Optional adapters | Graph and memory backends add signal when available; missing adapters contribute score 0. |
| Fail-open hooks | Prompt hooks return local context or nothing instead of blocking the agent when optional runtime pieces are unavailable. |
| Local-only telemetry | Reports, prompt history, evidence, and telemetry stay under `~/.backendguard/`. No source code, credentials, or prompt contents are sent anywhere by default. |
| No hook network calls | Prompt and stop hooks do not call external services. Install/warm commands may prepare local indexes when explicitly run. |
| No postinstall surprise | `npm install` only installs the CLI. Setup runs only when you call `backendguard setup`. |

BackendGuard provides production-oriented engineering guidance, not an absolute security guarantee — no static tool can promise that. See [Limitations](#limitations).

## Detailed Install

From the package:

```bash
npm install -g @vantin/backendguard
backendguard install
```

Without a global install:

```bash
npx @vantin/backendguard@latest install
```

Agent-specific installers (`backendguard install` defaults to `backendguard install codex`):

```bash
backendguard install codex
backendguard install claude
backendguard install agy
```

### Codex

`backendguard install codex`:

1. Copies this package into `$CODEX_HOME/marketplaces/backendguard`.
2. Registers and installs `ctx@backendguard` through Codex plugin marketplace commands.
3. Downloads and caches the required local MiniLM embedding model under `~/.backendguard/models`.
4. Warms `~/.backendguard/embeddings.db` for AGENTS rules and project file paths.
5. Registers the `backendguard-mcp` MCP server and merges BackendGuard global hooks into `$CODEX_HOME/hooks.json`.
6. Wraps configured local MCP servers, except BackendGuard's own `backendguard-mcp`, with a transparent telemetry proxy so `tools/call` events can be measured. The original MCP command is preserved and executed unchanged.
7. Detects available project graph backends and prints the selected strategy (`code-review-graph` is active today; `codegraph` support is adapter-pending).
8. Refreshes local `code-review-graph` node embeddings when `.code-review-graph/graph.db` already exists. Best-effort — install still succeeds without it.

Restart Codex after installing.

### Claude Code

`backendguard install claude` copies this package into `~/.backendguard/agents/claude/backendguard`, merges hooks into `~/.claude/settings.json`, and registers `backendguard-mcp` as a user-scoped MCP server in `~/.claude.json`. Prompt context arrives through `UserPromptSubmit`'s `hookSpecificOutput.additionalContext`. Restart Claude Code after installing.

### Antigravity

`backendguard install agy` copies this package into `~/.backendguard/agents/agy/backendguard`, writes a `backendguard` hook group into `~/.gemini/config/hooks.json`, and registers `backendguard-mcp` in Antigravity's MCP config locations (`~/.gemini/antigravity/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/config/mcp_config.json`). Antigravity doesn't use `UserPromptSubmit`; context arrives through `PreInvocation` as an `ephemeralMessage`, and the `Stop` adapter stores the report locally. Restart Antigravity after installing.

The embedding model is mandatory: install checks `~/.backendguard/models` first and only downloads the MiniLM model if required files are missing, failing intentionally rather than letting the first prompt hook cold-load or download it. Once warm inside `backendguard-mcp`, prompt hooks never cold-load the model; if the MCP bridge is unavailable, hooks fail open with lightweight scoring.

Agents can call read-only BackendGuard MCP tools directly: `backendguard_health`, `backendguard_detect_stack`, `backendguard_score_context`, `backendguard_debug_context`, `backendguard_doctor_repo`, `backendguard_skills_doctor`, `backendguard_analyze_changes`, `backendguard_report_last_task`, `backendguard_evidence_last_task`, `backendguard_stats_workspace`. Write commands (`setup`, `install`, `refresh`, `sync`) are not exposed as MCP tools by default.

These were named `ctx_*` before 0.9.1. Each old id is still registered as a deprecated alias that forwards to its replacement, so an agent configuration written against an earlier release keeps working; prefer the `backendguard_*` names in new configuration.

## Skill Sync

Use skillshare when you want Codex, Claude Code, and Antigravity to share one rule/skill pack catalog:

```bash
backendguard sync --skills
```

This checks for `skillshare`, initializes it when needed, backs up existing skills before collection, runs `skillshare collect --all` (unless `--no-collect`), then `skillshare sync`, then rebuilds skill embeddings. The shared source is `~/.config/skillshare/skills/`.

```bash
backendguard sync --skills --dry-run
backendguard sync --skills --no-collect
backendguard sync --skills --agents codex,claude,agy
```

## Workflow Discovery

BackendGuard can sync Claude/Codex/Antigravity workflow markdown files and suggest the right workflow for the current task:

```bash
backendguard sync --workflows
```

It reads project workflows first (`.claude/workflows/`, `.codex/workflows/`, `.gemini/(antigravity(-cli))/workflows/`), then the equivalent global roots under `~`, keeping the first workflow per filename by root priority, then copies that unique set to the selected global agent roots — this avoids duplicate suggestions when the same workflow exists in multiple agent directories. Workflow files need no YAML frontmatter; BackendGuard reads the top heading, section headings, and agent names like `planner`, `tester`, `code-reviewer`, `docs-manager`.

## Modes

Injection mode is the default (`backendguard install`): BackendGuard analyzes each prompt, stores runtime data, and returns task-relevant `additionalContext`.

```bash
backendguard install --quiet    # analyzes and measures, but returns no additionalContext
backendguard install --inject   # explicit injection mode
backendguard install --copy     # copies only the plugin payload into $CODEX_HOME/marketplaces/backendguard (local experiments)
```

## Ruler Sync

Use [Ruler](https://github.com/intellectronica/ruler) when the project wants one rule/MCP source of truth for multiple agents:

```bash
backendguard sync --rules
```

Default agents are `codex`, `claude`, and `agy` (Antigravity — Ruler's identifier is `antigravity`; BackendGuard accepts and normalizes both). This checks for `ruler` (offering to install it if missing), runs `ruler init` if needed, adds `backendguard-mcp` to `.ruler/ruler.toml`, imports existing MCP servers from Codex/project config, applies Ruler for the selected agents, and verifies the result.

```bash
backendguard sync --rules --agents codex,claude
backendguard sync --rules --dry-run
backendguard sync --rules --force
```

## Upstream Passthrough

Thin passthrough commands for native Ruler/skillshare admin workflows — everything after `--` is forwarded unchanged, with the upstream output and exit status preserved:

```bash
backendguard ruler -- apply --agents codex,claude,antigravity
backendguard skillshare -- status
```

## Troubleshooting

**`backendguard-mcp bridge socket not found`** — restart Codex after `backendguard install`; the bridge socket only exists once Codex starts the long-running `backendguard-mcp` MCP server.

**`BackendGuard model cache missing`** — run `backendguard embeddings warm -- "some task"`, then restart Codex.

**No report found** — run at least one Codex task with BackendGuard enabled and let it finish so the `Stop` hook can write `last-report.json`, or run `backendguard check` directly against uncommitted changes.

**`Average efficiency: unknown`** — BackendGuard only reports efficiency when it has concrete evidence. Diff-based rules are measured from git diff/status; runtime-only rules need hook-visible tool/command telemetry. If neither exists, the rule stays `unknown`.

**`npm warn deprecated prebuild-install@7.1.3`** — comes from a transitive dependency in the local embedding/WASM stack. It does not block installation or runtime commands.

## Runtime Files

```text
~/.backendguard/                              shared caches (embedding model, etc.)
~/.backendguard/workspaces/<workspace-id>/     per-project runtime files:
  debug.log                   hook event log
  backendguard-mcp.sock                private hook bridge owned by backendguard-mcp
  last-prompt-context.json    latest scheduled context
  last-report.json            latest compliance report
  prompt-history.jsonl        prompt scheduling history
  report-history.jsonl        report history
  telemetry.jsonl             local runtime signals from hooks, tools, and commands
```

The workspace id is stored in the target repo at `.backendguard/workspace.json` (added to `.gitignore` automatically; falls back to a path-derived deterministic id if the marker can't be written). Codex, Claude Code, and Antigravity all write through this same workspace id, so one project shares one runtime history across agents. These files are local telemetry only — hooks make no network calls, and no source code, prompt content, or database contents leave the machine by default.

## Project Understanding

BackendGuard works standalone; project graph and memory backends are optional adapters that add signal when available and contribute score 0 when missing:

| Adapter | Adds | Required |
| --- | --- | --- |
| `code-review-graph` | Blast radius, semantic node search, test relationships | No |
| `codegraph` | Symbol/call graph context (adapter-pending) | No |
| `agent-memory` | Prior task history, decisions, recurring bug-fix context | No |

For file suggestions, `backendguard install`/`backendguard embeddings warm` build local file-path embeddings and one-hop import adjacency once; prompt hooks query those prepared indexes directly (rules, files, skills, and workflows resolve concurrently). If `backendguard-mcp` is unavailable, BackendGuard falls back to indexed text matches for files and lightweight evidence scoring for skills — run `backendguard context -- "task"` to inspect the active retrieval mode.

### Skill Ranking

Rule/skill ranking parses `SKILL.md`/`skill.yaml` into a lightweight schema, builds a graph from `related_skills`/`depends_on`/`provides`/`requires`, and blends multiple signals:

```text
final_score =
  semantic_score * 0.25
+ prompt_trigger_score * 0.20
+ project_evidence_score * 0.25
+ file_config_score * 0.10
+ import_graph_score * 0.10
+ skill_graph_score * 0.10
+ source_boost_score * 0.05
+ external_graph_score * 0.03
+ memory_score * 0.02
- negative_penalty * 0.20
```

A pack only gets high confidence when project evidence supports it (`typeorm` routes highly in a repo with `typeorm`/`pg`; a Prisma project routes to `prisma`/`postgresql` instead). Confidence bands: high >= 0.85, medium 0.65-0.84, low < 0.65.

```bash
backendguard rules doctor -- "add rate limiting to the login endpoint"
```

## Configuration

```text
BACKENDGUARD_GRAPH_RETRIEVAL=0            disable graph-backed file retrieval
BACKENDGUARD_GRAPH_TIMEOUT_MS=80          graph lookup timeout
BACKENDGUARD_EMBEDDINGS=0                 disable embedding rule scoring
BACKENDGUARD_MCP_CONNECT_TIMEOUT_MS=500   stale backendguard-mcp socket connect timeout
BACKENDGUARD_MCP_BRIDGE_TIMEOUT_MS=5000   backendguard-mcp hook bridge timeout
BACKENDGUARD_MCP_AUTOSTART=1              auto-start backendguard-mcp daemon when the private bridge socket is missing
BACKENDGUARD_HOOK_DEADLINE_MS=8500        hard fail-open deadline for prompt hooks
BACKENDGUARD_FILE_EMBEDDINGS=0            disable file-path embedding retrieval
```

Run `backendguard --config` to choose which prompt sections BackendGuard injects and how many suggestions each shows. Defaults use adaptive "auto" budgets: up to 15 files, 8 skills, 3 workflows.

## Hook Flow

```text
Agent prompt
  -> UserPromptSubmit hook
  -> auto-start backendguard-mcp daemon if the private bridge socket is missing
  -> call backendguard-mcp through private bridge
  -> backendguard-mcp scores rules and relevant files
  -> write last-prompt-context.json
  -> return additionalContext unless quiet mode is enabled
  -> agent runs task
  -> Stop hook
  -> read git diff/status
  -> measure rule evidence + run structural analysis, classify severity/category
  -> write last-report.json and report-history.jsonl
```

## Rule Outcomes

```text
followed     = evidence in the diff suggests the rule was applied
ignored      = evidence in the diff (or structural analysis) suggests the rule was violated
unknown      = the rule was relevant, but the diff does not prove either way
unmeasurable = BackendGuard lacks the required evidence source, such as git diff lines or runtime telemetry
```

For runtime-only rules, BackendGuard also checks `telemetry.jsonl` for hook-visible tool names, MCP server names, and command metadata. Rules describing the agent's runtime environment (e.g. "run shell commands as user X") rather than project behavior are filtered before scoring and never count toward `unknown`.

## Development

```bash
npm install
npm test                    # unit tests
npm run test:mcp            # MCP protocol + warm performance smoke
npm run validate:plugin     # validate plugin schema
npm pack --dry-run          # check the npm package contents
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

## Project Layout

See [docs/architecture/](docs/architecture/overview.md) for a full domain map and how to extend each part: [overview.md](docs/architecture/overview.md), [rule-engine.md](docs/architecture/rule-engine.md), [compliance-engine.md](docs/architecture/compliance-engine.md), [integrations.md](docs/architecture/integrations.md).

Each root directory is one domain, named for what it is responsible for.

```text
cli/               command table, argument parsing, per-command --help, exit codes
rules/             AGENTS.md reader, rule parser, rule scorer, context scheduler
retrieval/         task-aware retrieval: embeddings, import graph, file ranking
analysis/          static analyzers + the analyzer registry
  ├── security/       NestJS/HTTP security checks           (SEC-*)
  ├── database/       TypeORM (TORM-*), Prisma (PRISMA-*), PostgreSQL (PG-*)
  ├── performance/    static performance checks             (PERF-*)
  └── scalability/    multi-replica correctness checks      (SCALE-*)
compliance/        diff compliance, report building, deterministic category scoring
agent-context/     hooks, output budget, skill & workflow sync, starter context generation
integrations/      per-agent installers (claude, antigravity, copilot, codex) + MCP server
skills/            the markdown rule packs themselves
runtime/           shared infrastructure: process spawning, fs, telemetry, terminal UI
evaluation/        detection quality, rule routing, hallucination, scale, release readiness
tests/             all automated tests
tooling/           maintenance scripts
plugins/backendguard/   the Codex plugin: manifests and thin hook/MCP entrypoints
```

## Limitations

- Codex and Claude Code get prompt context through `additionalContext`; Antigravity gets it through `PreInvocation`'s `ephemeralMessage`.
- File suggestions require local file-path embeddings or graph matches; there is no filename-heuristic fallback when embedding caches are unavailable.
- AGENTS.md rule compliance is heuristic (git diff/status plus keyword matching), not static analysis — it prioritizes review, it does not replace one.
- The structural analysis layer resolves entity/service/controller relationships by following decorators and constructor-parameter types across the project. It is not a full semantic type-checker (no `ts.Program`, no module resolution), so cross-file resolution is best-effort, not a guarantee.
- Analyzers currently cover NestJS/HTTP security, TypeORM, Prisma, PostgreSQL, static performance, and scalability. **Not implemented:** Redis-specific checks, API-design and response-shape consistency, resource-ownership/IDOR detection (which needs data-flow analysis this layer does not do), Express-specific routing checks, and any framework outside the list above. `backendguard analyze --list-analyzers` is the authoritative list of what runs.
- Neither layer is a formal security audit or a certification. The absence of a finding is not proof of the absence of a vulnerability.
- Severity/category classification on `AGENTS.md` rules (as opposed to skill packs and structural findings, which carry exact metadata) is keyword-based, not exact.
- Some rules can only be `unknown` unless BackendGuard records richer telemetry such as tool calls or shell command metadata.
- **Performance and scalability findings are static observations about code shape, not measurements.** BackendGuard reports that a query runs once per loop iteration, or that state lives in one process's memory. It does not measure latency, throughput, or capacity, and it makes no claim about how many users your service supports. Nothing in this repository load-tests anything.
- The detection-quality numbers in [Benchmarks](#benchmarks) describe BackendGuard's own labelled fixture corpus. They are a regression gate, not a claim about detection quality on arbitrary code.
- Injection mode may show a visible hook context block in some agents; quiet mode records and measures without injecting.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md). Current focus: a public hallucination leaderboard, an "Agent Replay" post-task narrative view, structured severity metadata on AGENTS.md rules, and additional framework/ORM rule packs (Fastify, Drizzle, Sequelize). Not on the roadmap: a hosted dashboard product.

## License

[MIT](LICENSE)
