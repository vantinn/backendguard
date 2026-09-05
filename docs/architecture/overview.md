# Architecture Overview

This document maps BackendGuard's domain vocabulary onto the code. It exists so a new contributor — or a returning one — can find the right file in minutes instead of grepping the tree.

**Read this first, then go straight to the file.** The other documents go deeper: [analysis.md](analysis.md) (static analyzers), [rule-engine.md](rule-engine.md) (rules and retrieval), [compliance-engine.md](compliance-engine.md) (reports and scoring), [integrations.md](integrations.md) (agents and MCP).

## What BackendGuard is, architecturally

A Node.js CLI plus a local MCP server. There is no build step, no formal domain classes, no dependency-injection container. The concepts below are real, but in code they are plain objects passed between focused modules grouped into domain directories. That is a legitimate, low-overhead architecture for a tool of this size, and this document treats it as the target shape rather than pretending a class hierarchy exists that does not.

The root directory is the architecture:

```text
cli/            command table, argument parsing, per-command --help, exit codes
rules/          rule engine: AGENTS.md reader, parser, scorer, context scheduler
retrieval/      task-aware retrieval: embeddings, import graph, file ranking, code-graph MCP
analysis/       static analyzers + the analyzer registry
compliance/     diff compliance, report building, deterministic category scoring
agent-context/  what reaches the agent: hooks, output budget, skill/workflow sync, starter context
integrations/   per-agent installers + the MCP server
skills/         the markdown rule packs themselves
runtime/        shared infrastructure: process spawning, fs, git ignore, telemetry, terminal UI
evaluation/     benchmarks: detection quality, routing, hallucination, scale, release readiness
tests/          all automated tests
tooling/        maintenance scripts
plugins/backendguard/   the Codex plugin: manifests and thin hook/MCP entrypoints
```

## Domain map

| Domain concept | What it means | Where it lives | Real shape |
| --- | --- | --- | --- |
| **Backend Stack** | The framework, language, database, ORM, cache and auth this repository actually uses, with the evidence for each | `analysis/stack-detector.js` — `detectProjectProfile()`, `buildStackReport()`, `detectStack()` | `{ framework, language, database, orm, cache, queue, containerization, authentication, validation, ci, testing, observability, platforms, evidence }`. Every field is `null` unless backed by a dependency, file, or config match; `evidence[field]` says which. |
| **Engineering Task** | The prompt an agent is about to act on | A plain string passed through `scoreContext()` / `scoreRules()`, tokenized on demand | n/a |
| **Engineering Rule** | One bullet or paragraph parsed out of `AGENTS.md` | `rules/rule-engine.js` — `parseRules()`, `filterActionableRules()`, `scoreRules()` | `{ id, sourcePath, content, originalOrder }`; scored rules add `.score` and `.reasons` |
| **Rule Pack** ("skill") | An installable bundle of guidance for one technology, with prompt/file/dependency triggers | `skills/<pack>/SKILL.md` + `skill.yaml`, parsed by `agent-context/skill-discoverer.js` | See [rule-engine.md](rule-engine.md) |
| **Context Retrieval** | Ranking rules, files, packs and workflows against the task and assembling what the agent sees | `retrieval/context-retriever.js` orchestrates; `retrieval/file-retriever.js` ranks files; `rules/context-scheduler.js` lays out the budget | See [rule-engine.md](rule-engine.md) |
| **Analyzer** | A registered unit of static analysis for one technology or concern | `analysis/analyzer-registry.js`, `analysis/{security,database,performance,scalability}/` | `{ id, title, categories, appliesTo?, analyze }` — see [analysis.md](analysis.md) |
| **Finding** | One evidence-anchored defect | `analysis/finding.js` — `createFinding()` | `{ id, category, severity, confidence, analyzer, title, detail, evidence, remediation, file, line, column }` |
| **Compliance Check** | Diffing the working tree against the rules scheduled for the task | `compliance/rule-compliance.js` — `checkCompliance()`, `readGitSnapshot()` | `{ rule, status: followed\|ignored\|unknown\|unmeasurable, kind, keywords, evidence, matchedLines? }` |
| **Compliance Report** | The post-task summary: rule outcomes, findings, and per-category scores | `compliance/compliance-reporter.js` — `buildReport()`, `buildComplianceSummary()`, `buildComplianceScorecard()` | See [compliance-engine.md](compliance-engine.md) |
| **Repository Readiness** | Whether a repository has enough rules, packs and workflows for BackendGuard to help at all | `compliance/readiness-scorer.js` — `inspectBackendGuardReady()` | `{ rules, skills, workflows, overall, tier, recommendations }` |
| **Agent Integration** | How context reaches Codex / Claude Code / Antigravity / Copilot | `integrations/{claude,antigravity,copilot,codex}/`, `integrations/mcp/` | See [integrations.md](integrations.md) |

## The two analysis layers

These are genuinely different in strength, and conflating them is how a tool loses trust.

| | Structural analysis | Rule-keyword compliance |
| --- | --- | --- |
| Reads | Parsed TypeScript, `schema.prisma`, `.sql` | The text of `AGENTS.md` rules and the added lines of a git diff |
| Answers | "This route has no guard." | "Did the diff mention words from this rule?" |
| Evidence | The exact construct, at `file:line:column` | A matched line |
| Confidence | `certain` … `low`, per check | `heuristic` |
| Where | `analysis/` — see [analysis.md](analysis.md) | `compliance/rule-compliance.js` |

`backendguard analyze` runs the structural layer alone. `backendguard check` runs both over the current diff and merges them into one report.

## End-to-end: an agent prompt

```text
Agent submits a prompt
        │
        ▼
UserPromptSubmit hook            plugins/backendguard/bin/on-prompt.js
        │
        ▼
scoreContext()                   retrieval/context-retriever.js
  ├─ parseRules(), scoreRules()   rules/rule-engine.js          rank AGENTS.md rules against the task
  ├─ findRelevantFiles()          retrieval/file-retriever.js   rank source files
  ├─ suggestSkills()              agent-context/skill-discoverer.js
  └─ suggestWorkflows()           agent-context/workflow-discoverer.js
        │
        ▼
scheduleContext()                rules/context-scheduler.js     apply the context budget
        │
        ▼
Injected into the agent's prompt
```

## End-to-end: `backendguard analyze`

```text
detectStack()                    analysis/stack-detector.js     what is this project, with evidence
        │
        ▼
buildSourceIndex()               analysis/source-index.js       one parse; entities, controllers, DTOs, repo fields
        │
        ▼
registry.run()                   analysis/analyzer-registry.js  every analyzer whose appliesTo accepts this stack
        │
        ▼
dedupe + supersede + sort        analysis/finding.js
        │
        ▼
Formatted report, or --json      cli/analyze-command.js
```

## End-to-end: `backendguard check`

```text
readGitSnapshot()                compliance/rule-compliance.js  the current diff
        │
        ├─► checkCompliance()                                   rule-keyword layer over added lines
        └─► analyzeChangedFiles()   analysis/index.js           structural layer, scoped to changed files
                    │
                    ▼
        buildReport() + buildComplianceScorecard()              compliance/compliance-reporter.js
```

The structural layer analyzes the **whole project** and then filters output to the changed files: cross-file resolution (entity → service → controller) needs files the diff did not touch, but the report should still answer "what did this change introduce or leave behind" rather than dumping every pre-existing finding on every run.

## Runtime state

Everything BackendGuard writes lives under `~/.backendguard/` (a pre-0.9.0 `~/.ctx/backendguard/` is still read if present) plus a `.backendguard/` marker directory inside each analysed project, which the tool adds to that project's `.gitignore`. See the README's [Runtime Files](../../README.md#runtime-files) section.
