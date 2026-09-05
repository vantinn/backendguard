# BackendGuard — Repository Refactor Audit

Date: 2026-09-05
Baseline commit: `b43f511` (version 0.8.0)

This audit was produced by reading every project-owned file in the repository
before any change was made. It records what each directory *actually does*
(not what its name suggests), the legacy terminology found inside it, and the
migration decision taken.

## 0. Method

- `git ls-files` (205 tracked files) was used as the authority for what is
  project-owned. `node_modules/`, `.git/` and `.backendguard/` are not tracked.
- Every root directory, including hidden ones, was opened and read.
- Legacy terminology was found with a repository-wide case-insensitive scan for
  the previous product's vocabulary (`ctx`, `contextOS`, `skillshare`, `ruler`,
  `code-review-graph`) plus a scan for leaked absolute developer paths.

## 1. Directory-by-directory audit (before state)

| Current directory | Actual responsibility | Legacy terminology found | Project-owned | Ecosystem-required | New domain | Migration risk | Tests affected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bin/` | Single 1342-line file `ctx.js`: the whole CLI — argument parsing, command dispatch, install orchestration, interactive wizards, output formatting | `ctx` (filename, `[ctx]` log prefix, `contextOSDataDir()`) | yes | no (`package.json#bin` maps names, path is free) | `cli/` | Medium — `package.json#bin`, `files`, CI workflows, README, plugin install all reference `bin/ctx.js` | indirect (`test/hooks.test.js` spawns the CLI) |
| `plugins/ctx/lib/` | 43 mixed-responsibility modules: rule engine, retrieval, embeddings, analyzers, compliance, hooks, skills sync, agent installers, and generic utilities all in one flat folder | `ctx` (dir name), `ctx-mcp-client.js`, `skillshare-sync.js`, `ruler-sync.js`, `code-review-graph` couplings | yes | no | split across `rules/`, `retrieval/`, `analysis/`, `compliance/`, `agent-context/`, `integrations/`, `runtime/` | High — every import in the repo points here | all 41 test files import from here |
| `plugins/ctx/bin/` | 5 tiny hook entrypoint shims invoked by agent hook runners (`on-prompt`, `on-stop`, `on-session-start`, antigravity variants) | `ctx` (parent dir) | yes | partly — the *paths* are written into `~/.codex/hooks.json` by the installer, so they are a public interface | `plugins/backendguard/bin/` | Medium — installed hook configs on existing machines embed the old absolute path | `test/hooks.test.js`, `test/agent-hooks.test.js`, `test/global-hooks.test.js` |
| `plugins/ctx/mcp/` | MCP stdio server (`server.js`), tool registrations (`backendguard-server.js`), telemetry proxy (`proxy.js`) | `ctx` (parent dir), MCP server registered under the name `ctx-mcp` | yes | partly — the MCP server *name* `ctx-mcp` is recorded in user MCP configs | `integrations/mcp/` + thin `plugins/backendguard/mcp/` shim | Medium — server name is a public identifier | `test/mcp-proxy.test.js`, `test/mcp-protocol-smoke.js`, `test/ctx-mcp-client.test.js` |
| `plugins/ctx/integrations/` | Per-agent hook + MCP config writers for Claude Code, Antigravity, Copilot | `ctx` (parent dir) | yes | no | `integrations/` | Low | `test/agent-hooks.test.js` |
| `plugins/ctx/.codex-plugin/`, `hooks.json`, `.mcp.json` | Codex plugin manifest, hook declaration, MCP declaration. Plugin is registered as `ctx@backendguard`. | plugin `name: "ctx"`, MCP server `ctx-mcp` | yes | **yes** — Codex resolves a plugin directory containing `.codex-plugin/plugin.json`; `.agents/plugins/marketplace.json` points at `./plugins/ctx` | `plugins/backendguard/` (directory renamed, ecosystem *shape* preserved) | Medium — installed Codex plugins reference `ctx@backendguard` | `test/validate-plugin.js` |
| `community-skills/` | 11 markdown "skill" knowledge packs (nestjs, postgresql, prisma, typeorm, redis, security, jwt-auth, oauth-google, eas, vercel) + `_template` + README. Content, not code. | none | yes | no | `skills/` | Low — referenced by `package.json#files`, a GH workflow and a sync script | `test/community-skills.test.js` |
| `eval/` | Two benchmarks: `skill-routing` (routing precision/recall over 17 fixture repos) and `hallucination` (offline + live agent leaderboards) | none | yes | no | `evaluation/` | Low | `test/skill-routing-eval.test.js`, `test/hallucination-leaderboard.test.js`, `test/agent-leaderboard.test.js` |
| `test/` | 41 vitest files + `validate-plugin.js` + `mcp-protocol-smoke.js` (the latter two are scripts, not vitest suites) | imports `plugins/ctx/...` throughout | yes | no | `tests/` | Low | itself |
| `scripts/` | One script: `sync-community-skills.mjs`, mirrors an external skills repo into `community-skills/` | none | yes | no | `tooling/` | Low | none |
| `docs/` | `architecture/` (4 real design docs), `implementation-gap-analysis.md`, `roadmap.md`, `launch-demos.md`, `demo/` (recorded terminal transcripts + two capture scripts) | `ctx` in prose and demo transcripts | yes | **conventional** — `docs/` is the near-universal convention and is special-cased by GitHub. Renaming it to `documentation/` would trade recognisability for nothing. | **kept as `docs/`** (documented exception) | Low | none |
| `launch/` | 5 marketing copy files (Reddit/HN/dev.to/Twitter drafts). Not runtime, not bootstrap — pure launch collateral. | none | yes | no | `docs/launch/` (it is documentation, not a code domain) | Low | none |
| `.agents/` | One file: `plugins/marketplace.json`, the agent-plugin marketplace manifest consumed by `codex plugin marketplace add` | plugin entry `name: "ctx"` | yes | **yes** — the `.agents/` location and the manifest shape are what the agent toolchain looks for | **kept as `.agents/`** (documented exception); internal `name` updated | Low | `test/validate-plugin.js` |
| `.codex/` | `workflows/primary.md`, `workflows/release.md` — Codex workflow definitions shipped with the package | none | yes | **yes** — Codex reads `.codex/workflows/` | **kept** | Low | none |
| `.github/` | CI, release, community-skills-sync workflows; one issue template | workflow checks out the repo into a path literally named `contextOS`; CI warms embeddings with a Vietnamese prompt left over from the previous product | yes | **yes** — GitHub requires `.github/workflows/` | **kept**; legacy content inside fixed | Low | none |
| `.vscode/` | `mcp.json` + a committed `mcp.json.bak` | **Leaked absolute developer paths**: `/home/minh_dev/workspaces/contextOS/...`, `/home/minh_dev/.ctx/...`, plus a `code-review-graph` server pointing at a personal pipx venv | yes | **yes** — VS Code requires `.vscode/` | **kept**; file rewritten to a portable workspace-relative config, `.bak` deleted | Low | none |
| `.backendguard/` | Runtime state written by the tool into whatever project it scans (`workspace.json`, `last-prompt-context.json`, `error.log`). Gitignored; present here only because the tool was run on itself. | none | **no** — generated artefact | n/a | **not a source directory**; left as-is, remains gitignored | none | none |

## 2. Ecosystem exceptions (kept deliberately)

| Directory | Why it must keep its name |
| --- | --- |
| `.github/` | GitHub only reads workflows from `.github/workflows/`. |
| `.vscode/` | VS Code only reads `mcp.json`/`settings.json` from `.vscode/`. |
| `.codex/` | The Codex CLI resolves project workflows/skills from `.codex/`. |
| `.agents/` | The agent plugin marketplace manifest is looked up at `.agents/plugins/marketplace.json`. |
| `docs/` | Universal convention; recognised by GitHub and by every contributor. `documentation/` would be a pure-cost rename. |
| `plugins/<name>/` | `.agents/plugins/marketplace.json` declares `source.path` into `plugins/`; the plugin folder itself must contain `.codex-plugin/plugin.json`, `hooks.json`, `.mcp.json` at its root. Only the `<name>` segment was legacy, so only that was renamed (`ctx` → `backendguard`). |

For each of these the rule applied was: *remove legacy product terminology
**inside** the directory, keep the directory where the ecosystem expects it.*

## 3. Legacy terminology inventory (before state)

| Term | Origin | Occurrences | Disposition |
| --- | --- | --- | --- |
| `ctx` | previous product name | 45 in README, 54 in `bin/ctx.js`, directory names, MCP server name `ctx-mcp`, log prefix `[ctx]`, data dir `~/.ctx` | Renamed throughout. `~/.ctx` data root kept readable for one release via a documented fallback (see §5). |
| `contextOS` | previous product name | `.vscode/mcp.json`, `.github/workflows/sync-community-skills.yml`, `contextOSDataDir()`, `contextOSEntry()`, `[ctx]` messages | Removed entirely. |
| `skillshare` | third-party CLI (`runkids/skillshare`) that the sync module was originally built around | `skillshare-sync.js` (43 refs), passthrough command | The *file* is renamed to `agent-context/skill-sync.js` because its responsibility is "sync skills across agents", not "wrap skillshare". The passthrough command keeps the literal name `skillshare` because it is a **legitimate third-party binary name** — renaming it would break the passthrough. |
| `ruler` | third-party CLI (`@intellectronica/ruler`) | `ruler-sync.js` (35 refs), passthrough command | Same treatment: file → `agent-context/rule-sync.js`; passthrough keeps the real binary name. |
| `code-review-graph` | an external MCP server the previous product integrated with | `graph-strategy.js`, `graph-retriever.js`, `global-hooks.js`, `.vscode/mcp.json` | This is a **real, optional third-party MCP integration**, not dead legacy: the retriever genuinely queries it when present. Kept, but moved under `integrations/`/`retrieval/` and documented as optional. The hardcoded personal pipx path in `.vscode/mcp.json` is removed. |
| Vietnamese domain vocabulary (`kiem duyet`, `tai len`, `xac nhan`, `thong bao`) and hardcoded retrieval hints (`purchase`, `wallet`, `library access`) in `analyzer.js` | tuning for one specific previous customer project | `analyzer.js` `SEMANTIC_ALIASES`, `expandFileRetrievalTask()`; CI workflow prompt | Domain-specific hardcoded hints removed from the retrieval path (they biased every project's retrieval toward one unrelated app). Bilingual imperative-word support is kept because it is generic, not project-specific. |
| `/home/minh_dev/...` | leaked developer machine paths | `.vscode/mcp.json`, `.vscode/mcp.json.bak`, `analyzer.js` `SYSTEM_USER_RULE_PATTERNS` (`minh_dev` regex) | Removed from config. The `minh_dev` regex in the rule filter is replaced by a generic "shell-user-switching instruction" pattern that does not name a person. |

## 4. Target architecture (after state)

```
cli/               command table, argument parsing, per-command --help, exit codes
rules/             rule engine: AGENTS.md reader, rule parser, rule scorer, context scheduler
retrieval/         task-aware context retrieval: embeddings, import graph, graph MCP, file ranking
analysis/          static analyzers + analyzer registry (security, typeorm, prisma, postgresql,
                   performance, scalability) over a shared TypeScript source index
compliance/        diff compliance, report building/formatting, repository readiness scoring
agent-context/     what actually reaches the agent: prompt/stop hooks, hook IO, output budget,
                   skill & workflow discovery/sync, starter project context generation
integrations/      per-agent installers (claude, antigravity, copilot, codex) + MCP server/proxy
skills/            the markdown skill packs themselves (content)
runtime/           shared infrastructure: fs, git ignore, workspace data, telemetry, stats,
                   config, process spawning, terminal UI
evaluation/        benchmarks (skill routing, hallucination) + detection-quality + release-readiness
tests/             all automated tests
tooling/           maintenance scripts
docs/              documentation (kept by convention)
plugins/backendguard/   the Codex plugin package: manifests + hook shims + MCP shim
```

## 5. Backward compatibility decisions

| Public surface | Decision |
| --- | --- |
| `backendguard` / `backendguard-codex` bin names | Unchanged. Only the file behind them moved (`bin/ctx.js` → `cli/backendguard.js`). |
| All CLI command names and flags | Unchanged; new commands and new `--help`/`--json`/exit-code behaviour added. |
| Data root `~/.ctx/backendguard` | Moved to `~/.backendguard`. A one-time automatic migration reads the old location if the new one is absent, so existing installs keep their caches. Documented as a behaviour change in CHANGELOG. |
| MCP server name `ctx-mcp` | Renamed to `backendguard-mcp`. Installers remove the old `ctx-mcp` registration before adding the new one, so no orphan entry is left. **Breaking** for anyone who wrote `ctx-mcp` into their own config by hand — documented in CHANGELOG. |
| Codex plugin id `ctx@backendguard` | Renamed to `backendguard@backendguard`. The installer removes the old id first. **Breaking**; documented. |
| `plugins/ctx/bin/on-*.js` hook paths written into `~/.codex/hooks.json` | The installer rewrites its own entries every run (it filters by a marker), and the marker now matches both the old and new path so stale entries are cleaned up rather than duplicated. |
| `community-skills/` path in the sync workflow and `package.json#files` | Updated to `skills/`. The GitHub workflow is updated in the same commit. |
