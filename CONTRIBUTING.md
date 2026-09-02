# Contributing to BackendGuard

BackendGuard is a Node.js CLI + local MCP server (see [docs/architecture/overview.md](docs/architecture/overview.md) for the full domain map). This document covers the practical parts of contributing; architecture and extension points are documented in [docs/architecture/](docs/architecture/overview.md) rather than duplicated here.

## Development Setup

Requires Node.js >= 20.

```bash
git clone https://github.com/vantinn/backendguard.git
cd backendguard
npm install
```

No build step — `bin/ctx.js` and `plugins/ctx/lib/*.js` run directly as ES modules.

## Running Checks

```bash
npm test                    # unit tests (vitest)
npm run test:mcp            # MCP protocol + warm-performance smoke test
npm run validate:plugin     # validate the Codex plugin schema
npm pack --dry-run          # check what would actually ship in the npm package
```

There is currently no separate lint or typecheck script — `npm test` is the gate PRs are expected to pass.

To exercise the CLI against this checkout instead of an installed copy:

```bash
node bin/ctx.js --help
node bin/ctx.js stack
node bin/ctx.js context -- "add a registration endpoint"
```

## Repository Structure

```text
bin/ctx.js                CLI entrypoint (backendguard / backendguard-codex)
plugins/ctx/lib/           rule engine, compliance engine, stack detection, scoring
plugins/ctx/bin/           hook entrypoints (UserPromptSubmit, Stop, ...)
plugins/ctx/mcp/           ctx-mcp server + tool registrations
plugins/ctx/integrations/  per-agent hook/MCP installers (Claude, Antigravity, Copilot)
community-skills/          backend rule library + community skill packs
docs/architecture/         how the system is built, and where to extend it
test/                      unit tests (vitest)
eval/                      skill-routing and hallucination benchmark fixtures/runners
```

## Extension Points

Full instructions live in [docs/architecture/](docs/architecture/overview.md) — this is just the index:

| I want to... | Start here |
| --- | --- |
| Add a new rule pack (e.g. a new framework/ORM's security guidance) | [rule-engine.md#adding-a-rule-pack](docs/architecture/rule-engine.md#adding-a-rule-pack) |
| Add stack detection for a new framework/ORM/database | [rule-engine.md#adding-stack-detection-for-a-new-frameworkormdatabase](docs/architecture/rule-engine.md#adding-stack-detection-for-a-new-frameworkormdatabase) |
| Add a new AI agent integration | [integrations.md#adding-a-new-agent](docs/architecture/integrations.md#adding-a-new-agent) |
| Change what counts as a compliance violation, or its severity | [compliance-engine.md](docs/architecture/compliance-engine.md) |
| Add a new CLI command | The `command === "..."` dispatch chain in `bin/ctx.js` |
| Add a new MCP tool | `plugins/ctx/mcp/backendguard-server.js` |

When you add a first-party rule pack, also add its id to `expectedSeeds` in `test/community-skills.test.js`, and run `npm run benchmark:skills` to confirm it doesn't regress routing accuracy in `eval/skill-routing/cases.yaml`.

## Pull Requests

- Keep changes focused; avoid unrelated formatting/refactor churn in the same PR.
- Add or update a test in `test/` for any behavior change. `plugins/ctx/lib/` files each have a matching `test/<name>.test.js`.
- Update `README.md` and `CHANGELOG.md` for user-visible behavior changes.
- Run the full check list above before opening the PR: `npm test`, `npm run test:mcp`, `npm run validate:plugin`, `npm pack --dry-run`.
- Don't claim a detection/analysis capability in docs that the code doesn't actually implement — see the README's [Limitations](README.md#limitations) section for the standard this project holds itself to.

## Reporting Bugs / Security Issues

- Functional bugs: [open a GitHub issue](https://github.com/vantinn/backendguard/issues).
- Security vulnerabilities in BackendGuard itself: see [SECURITY.md](SECURITY.md) — do not open a public issue.
