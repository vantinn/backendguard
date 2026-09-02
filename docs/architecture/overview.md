# Architecture Overview

This document maps BackendGuard's actual code to the product's domain vocabulary. It exists so a new contributor (or a returning one) can find the right file in minutes instead of grepping the whole tree.

**Read this first, then go straight to the file.** The other documents in `docs/architecture/` go deeper on the rule engine, compliance engine, and AI-agent integrations.

## What BackendGuard actually is, architecturally

BackendGuard is a Node.js CLI + local MCP server. It is **not** a TypeScript hexagonal-architecture service — there is no build step, no formal domain classes, no dependency-injection container. The concepts below (`EngineeringRule`, `BackendStack`, `ComplianceFinding`, ...) are real domain concepts the product is built around, but in code they are plain JS objects passed between focused, single-responsibility modules under `plugins/ctx/lib/`. That is a legitimate, low-overhead architecture for a CLI tool of this size, and this document treats it as the target shape rather than pretending a class hierarchy exists that doesn't.

## Domain map

| Domain concept | What it means | Where it lives | Real shape |
| --- | --- | --- | --- |
| Backend Project / Stack | The detected framework, language, database, ORM, cache, auth for the repo BackendGuard is running in | `plugins/ctx/lib/project-context-generator.js` — `detectProjectProfile()`, `buildStackReport()`, `detectStack()` | `{ framework, language, database, orm, cache, queue, containerization, authentication, validation, ci, testing, platforms }` — every field is `null` unless backed by a dependency/file match |
| Engineering Task | The current prompt/task text an agent is about to work on | Passed as `task`/`prompt` string through `scoreContext()`, `scoreRules()` — not a wrapped object, just the string, tokenized on demand | n/a (string) |
| Engineering Rule | One bullet/paragraph parsed out of `AGENTS.md` | `plugins/ctx/lib/analyzer.js` — `parseRules()`, `scoreRules()` | `{ id, sourcePath, content, originalOrder }`, scored rules add `.score` and `.reasons` |
| Rule Pack (a.k.a. "skill") | A structured, installable bundle of rules for one technology (security, nestjs, postgresql, typeorm, prisma, redis, ...) with prompt/file/dependency triggers | `community-skills/<pack>/SKILL.md` + `skill.yaml`; parsed by `plugins/ctx/lib/skill-discoverer.js` — `parseSkillMetadata()`, `normalizeSkillMetadata()` | `{ id, name, positivePrompts, files, dependencies, negativePrompts, negativeFiles, negativeDependencies, workflow, relatedSkills, ... }` — see [rule-engine.md](rule-engine.md) |
| Context Retrieval | Ranking rules/files/skills/workflows against the current task and assembling the text an agent actually sees | `plugins/ctx/lib/score-context.js` (`scoreContext`, orchestrator) → `plugins/ctx/lib/scheduler.js` (`scheduleContext`, layout) | See [rule-engine.md](rule-engine.md) |
| Compliance Check | Diffing the working tree against the rules that were scheduled for the task | `plugins/ctx/lib/measure.js` — `checkCompliance()`, `readGitSnapshot()` | Array of `{ rule, status: followed\|ignored\|unknown\|unmeasurable, kind, keywords, evidence, matchedLines? }` |
| Compliance Report | The full post-task summary: rule outcomes plus the severity-ranked Security/Architecture/Database/Performance/Testing breakdown | `plugins/ctx/lib/reporter.js` — `buildReport()`, `buildComplianceSummary()`, `formatReport()` | See [compliance-engine.md](compliance-engine.md) |
| Finding | One severity-ranked compliance issue inside a report | `reporter.js` — `buildComplianceSummary()` issues array | `{ severity: CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO, category, summary, evidence }` |
| Repository Readiness | Whether a repo has enough `AGENTS.md` rules / rule packs / workflows for BackendGuard to be useful (the "BackendGuard Ready" badge) | `plugins/ctx/lib/certification.js` — `inspectBackendGuardReady()` | `{ rules, skills, workflows, overall, tier, recommendations }` |
| AI Agent Integration | How prompt context gets into Codex / Claude Code / Antigravity / Copilot, and how each agent's hooks/MCP config get installed | `plugins/ctx/integrations/{claude,antigravity,copilot}/` (Codex is the primary plugin itself — see [integrations.md](integrations.md)) | n/a |

## The end-to-end flow

```text
AI coding agent submits a prompt
        │
        ▼
UserPromptSubmit hook (plugins/ctx/bin/on-prompt.js)
        │
        ▼
scoreContext()  [score-context.js]
  ├─ parseRules() + scoreRules()        [analyzer.js]        — rank AGENTS.md rules against the task
  ├─ file retrieval                     [file-embedding-retriever.js, import-graph.js]
  ├─ rule-pack ("skill") retrieval      [skill-discoverer.js]
  └─ workflow retrieval                 [workflow-discoverer.js]
        │
        ▼
scheduleContext()  [scheduler.js]  — lays out the final injected text (critical rules, suggested files, skills, workflow)
        │
        ▼
Agent does the task
        │
        ▼
Stop hook (plugins/ctx/bin/on-stop.js)
        │
        ▼
readGitSnapshot() + checkCompliance()  [measure.js]  — diff the working tree against the scheduled rules
        │
        ▼
buildReport() + buildComplianceSummary()  [reporter.js]  — severity-ranked compliance report
        │
        ▼
written to ~/.ctx/backendguard/workspaces/<id>/last-report.json
        │
        ▼
backendguard report / backendguard evidence / backendguard check
```

`backendguard stack` and `backendguard check` (`bin/ctx.js`) run the same `detectStack()`/`checkCompliance()` machinery on demand, outside the hook lifecycle, for a developer running the CLI directly.

## Where do I add X?

| I want to... | Go to |
| --- | --- |
| Add a new engineering rule for an existing technology | Edit `AGENTS.md` in the target repo, or add a rule pack — see [rule-engine.md](rule-engine.md#adding-a-rule-pack) |
| Add support for a new framework/ORM/database | `detectProjectProfile()` in `project-context-generator.js` (detection) + a new `community-skills/<pack>/` (rules) — see [rule-engine.md](rule-engine.md#adding-a-rule-pack) |
| Change what counts as a compliance violation | `checkCompliance()` in `measure.js` — see [compliance-engine.md](compliance-engine.md) |
| Change severity/category classification | `SEVERITY_RULES` in `reporter.js` — see [compliance-engine.md](compliance-engine.md#severity-classification) |
| Add a new AI agent integration | `plugins/ctx/integrations/<agent>/` — see [integrations.md](integrations.md#adding-a-new-agent) |
| Add a new CLI command | `bin/ctx.js` — the `command === "..."` dispatch chain near the bottom of the file |
| Add a new MCP tool | `plugins/ctx/mcp/backendguard-server.js` |
| Change stack detection | `detectProjectProfile()` / `buildStackReport()` in `project-context-generator.js` |

## Non-goals of this refactor

This documentation pass and the `plugins/ctx/integrations/` grouping (see [integrations.md](integrations.md)) intentionally did **not** physically restructure `plugins/ctx/lib/` into `domain/application/infrastructure/analysis/retrieval/` directories. The existing flat `lib/` layout already uses specific, responsibility-named files (`analyzer.js`, `scheduler.js`, `reporter.js`, `measure.js`, `certification.js`, `skill-discoverer.js`, `embedding-scorer.js`, ...) — the kind of layered TypeScript tree a larger service would want doesn't pay for itself in a single-package CLI tool with no compiler-enforced module boundaries. Forcing it on would be churn without a corresponding clarity gain; this document exists to provide that clarity instead.
