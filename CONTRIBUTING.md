# Contributing to BackendGuard

BackendGuard is a Node.js CLI plus a local MCP server (see [docs/architecture/overview.md](docs/architecture/overview.md) for the full domain map). This document covers the practical parts of contributing; architecture and extension points are documented in [docs/architecture/](docs/architecture/overview.md) rather than duplicated here.

## Development Setup

Requires Node.js >= 20.

```bash
git clone https://github.com/vantinn/backendguard.git
cd backendguard
npm install
```

No build step — every file under the domain directories runs directly as an ES module.

## Running Checks

```bash
npm test                    # unit + integration + CLI tests (vitest)
npm run test:mcp            # MCP protocol + warm-performance smoke test
npm run validate:plugin     # validate the Codex plugin and marketplace manifests
npm run test:package        # npm pack, install the tarball into a clean project, run the CLI from it
npm run evaluate:detection  # detection quality against the labelled fixture corpus
npm run benchmark:skills    # rule/skill routing benchmark
npm run evaluate            # the full release-readiness rubric
```

`npm test` is the gate a PR is expected to pass. `npm run test:package` is the gate a *release* is expected to pass, because running from a source checkout proves nothing about what npm publishes.

To exercise the CLI against this checkout instead of an installed copy:

```bash
node cli/backendguard.js --help
node cli/backendguard.js stack --evidence
node cli/backendguard.js analyze ./path/to/a/backend --severity high
node cli/backendguard.js context -- "add a registration endpoint"
```

## Repository Structure

Each root directory is one domain. The name says what the code in it is responsible for.

```text
cli/               command table, argument parsing, per-command --help, exit codes
rules/             rule engine: AGENTS.md reader, rule parser, rule scorer, context scheduler
retrieval/         task-aware context retrieval: embeddings, import graph, file ranking
analysis/          static analyzers + the analyzer registry
  ├── security/       NestJS/HTTP security checks (SEC-*)
  ├── database/       TypeORM (TORM-*), Prisma (PRISMA-*), PostgreSQL (PG-*)
  ├── performance/    static performance checks (PERF-*)
  └── scalability/    multi-replica correctness checks (SCALE-*)
compliance/        diff compliance, report building, deterministic category scoring
agent-context/     what reaches the agent: prompt/stop hooks, skill & workflow sync, starter context
integrations/      per-agent installers (claude, antigravity, copilot, codex) + MCP server
skills/            the markdown rule/skill packs themselves
runtime/           shared infrastructure: process spawning, fs, git ignore, telemetry, terminal UI
evaluation/        benchmarks: detection quality, rule routing, hallucination, scale, release readiness
tests/             all automated tests
tooling/           maintenance scripts
plugins/backendguard/   the Codex plugin package: manifests and thin hook/MCP entrypoints
docs/architecture/ how the system is built, and where to extend it
```

## Extension Points

Full instructions live in [docs/architecture/](docs/architecture/overview.md) — this is the index:

| I want to... | Start here |
| --- | --- |
| Add a new analyzer (framework, ORM, database, or analysis category) | [analysis.md#adding-an-analyzer](docs/architecture/analysis.md#adding-an-analyzer) |
| Add a check to an existing analyzer | [analysis.md#adding-a-check](docs/architecture/analysis.md#adding-a-check) |
| Add stack detection for a new technology | [analysis.md#adding-stack-detection](docs/architecture/analysis.md#adding-stack-detection) |
| Add a new rule pack (a framework's written guidance) | [rule-engine.md#adding-a-rule-pack](docs/architecture/rule-engine.md#adding-a-rule-pack) |
| Add a new AI agent integration | [integrations.md#adding-a-new-agent](docs/architecture/integrations.md#adding-a-new-agent) |
| Change what counts as a compliance violation, or its severity | [compliance-engine.md](docs/architecture/compliance-engine.md) |
| Add a new CLI command | Add an entry to `cli/command-registry.js`, then a branch in `cli/backendguard.js`. A test asserts the two never drift apart. |
| Add a new MCP tool | `integrations/mcp/tools.js` |

When you add a first-party rule pack, also add its id to `expectedSeeds` in `tests/skill-packs.test.js`, and run `npm run benchmark:skills` to confirm routing accuracy does not regress.

## Testing Standards

- **Every behaviour change needs a test.** Most modules have a matching `tests/<name>.test.js`.
- **Every new analyzer check needs three cases**: a true positive, a true negative (correct code that must stay clean), and where relevant an ambiguous case documenting the confidence level chosen.
- **Add the defect to the labelled corpus.** `evaluation/detection-quality/fixtures/` holds realistic projects with `expected-findings.json` labels. `tests/detection-quality.test.js` fails the build on any missed defect or any finding inside a file labelled correct, so a check that trades precision for recall cannot land unnoticed.
- **Do not weaken or delete a failing test to make a build green.** If a test is wrong, fix the test and say why in the PR.

## Pull Requests

- Keep changes focused; avoid unrelated formatting churn in the same PR.
- Update `README.md` and `CHANGELOG.md` for user-visible behaviour changes.
- Run the check list above before opening the PR.
- Don't claim a detection or analysis capability in docs that the code does not implement — see the README's [Limitations](README.md#limitations) section for the standard this project holds itself to.

## Reporting Bugs / Security Issues

- Functional bugs: [open a GitHub issue](https://github.com/vantinn/backendguard/issues).
- Security vulnerabilities in BackendGuard itself: see [SECURITY.md](SECURITY.md) — do not open a public issue.
