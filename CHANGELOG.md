# Changelog

All notable changes to `@vantin/backendguard` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

> **Note:** this file was recreated from scratch. The project's release history prior to this entry was not available to reconstruct accurately, and this changelog does not fabricate it. Entries from this point forward are accurate.

## [0.9.2] - 2026-09-06

Post-release fixes for problems users hit while installing 0.9.1 into real backend projects, plus the additional faults found while auditing the paths those reports pointed at. No breaking changes: every command and flag documented for 0.9.1 still works.

### Fixed

- **`backendguard sync --skills` crashed with `ReferenceError: spawn is not defined`.** The function that streams the skillshare installer's output called `spawn` without importing it, so *every* skillshare auto-install failed before the installer started — and because a `ReferenceError` is an internal fault, the CLI correctly but unhelpfully answered "This is a bug in BackendGuard". Streaming now goes through a shared `spawnStreaming` helper in `runtime/shell-runner.js`, which also handles a missing executable, a permission error, a non-zero exit, a signal and a timeout.
- **`backendguard install claude` did nothing and exited 0.** The positional agent form is documented in the README, but only `--agent`/`--agents` were implemented; the positional argument was ignored, the command fell through to the interactive prompt, and with no TTY and nothing preselected it installed nothing and reported success. `install <agent>` now works, alongside both flag forms.
- **The interactive agent prompt started with nothing selected.** Pressing Enter produced an empty selection. Agents already present on the machine are now preselected (`~/.claude`, `~/.codex`, …); when none are found, Codex is. The prompt states what Space does and how many items are selected.
- **An empty agent selection was only detected at the very end of the setup wizard.** `backendguard setup` asked about Ruler, skillshare, prompt sections and starter context, printed its full plan, and only then failed — with a bare `Error`, so the run ended in exit code 70 and "This is a bug in BackendGuard". Selection is now validated immediately after the prompt, and before anything is printed or written in non-interactive runs. It exits 2 with instructions.
- **An unknown agent name was reported as an internal bug, after side effects.** `backendguard install bogus` printed "Installing bogus...", copied the package, and *then* failed with exit 70. Agent names are validated before any file is written, and an unknown name exits 2. `--agents ""` no longer silently installs nothing and exits 0.
- **A failing optional integration aborted the whole setup.** A skillshare failure discarded a completed Ruler and agent install. Ruler, skillshare and each agent install are now run as individually recoverable steps: failures are collected and listed under "ready, with skipped steps", and the run continues. A setup where no agent could be installed still fails.
- **A missing third-party CLI was reported as a BackendGuard bug.** `spawnSync skillshare ENOENT` reached the user as exit 70. `runProcess` now classifies `ENOENT`/`EACCES` as an environment error naming the command and how to install it.
- **A malformed user config was either a crash or silent data loss.** `~/.claude.json` was parsed with no guard, so invalid JSON crashed the install with exit 70; the other five config readers caught the error and **overwrote the file with defaults**, discarding whatever the user had — `~/.claude.json` holds every project Claude Code knows about. All six now share `readJsonConfig`, which leaves the file untouched and reports a `ConfigurationError` naming it.
- **One malformed source file aborted the entire analysis.** The TypeScript parser is recursive, so an expression nested a few thousand levels deep overflowed the stack and `backendguard analyze` failed with "Maximum call stack size exceeded" — a denial of service reachable from any analyzed repository. Parsing is now isolated per file: the bad file is skipped and named, the rest are analyzed.
- **Files skipped during analysis were not reported.** Files too large to read were dropped silently, so a partial analysis looked like a clean one. `analyze` now prints a "Not analyzed" line per reason.
- **`backendguard sync --rules --yes`, `--skills --yes` and `--rules --force` were rejected as unknown options.** All three are implemented, and `--force` is documented, but none were declared, so the flag validator rejected them with exit 2 — which made the non-interactive sync path unusable in CI. They are now declared and covered by tests.
- **`backendguard rules doctor` without a task, and `report`/`evidence` with no stored report, exited 70 as internal bugs.** They now exit 2 and 3 respectively, with a hint.
- **Ctrl+C at a selection prompt exited 0.** A cancelled setup reported success to any script wrapping it. Cancelling now exits 130.
- The two branches of the multi-select prompt disagreed on what an option with no explicit `selected` meant; both now read it the same way.
- The agent leaderboard's binary lookup contained a hardcoded Windows path with one developer's username. It is derived from the environment instead.

### Fixed — found by a second, independent adversarial audit

The audit below was run against the *packed npm artifact* installed into clean environments, not against the repository, and its security fixtures were written from a vulnerability checklist rather than from the analyzers.

- **A `~/.claude.json` that was a JSON array made `install` report success while registering nothing.** `typeof [] === "object"`, so an array passed every shape check, and a named property added to an array is silently dropped by `JSON.stringify`. The install printed its success banner having written no MCP server at all — and, for `["a","b"]`, having rewritten the user's file. The same flaw was present in all six config builders (Claude MCP and hooks, Codex hooks, Antigravity MCP and hooks, Copilot MCP). A config that cannot be merged into is now refused with exit code 2 and left byte-for-byte untouched.
- **A read-only or root-owned config crashed with exit code 70 and "This is a bug in BackendGuard".** Config writes are now atomic — written to a sibling temp file and renamed — and every failure mode (`EACCES`, `EPERM`, `EROFS`, `ENOSPC`, `EISDIR`, `ELOOP`) is classified as a configuration or environment problem. A config path that is a directory, or a symlink loop, is likewise no longer reported as an internal fault.
- **An interrupted install could leave a truncated config.** A direct write truncates before it writes; the atomic replace means an interrupted run leaves the previous file intact. Verified across 21 kill scenarios (SIGINT/SIGTERM/SIGKILL at seven points in the install): no corruption, no user data lost, and re-running always recovered.
- **A symlinked config file was replaced by a regular file.** Dotfiles repositories symlink `~/.claude.json`; the writer now resolves the link and replaces its target, so the symlink survives.
- **The prompt hook took ~32s on a 200KB prompt and over 200s on a 500KB one, freezing the agent on every message.** `findExplicitPromptFiles` matched path-like tokens with `X+(?:/X+)+`; on a long run of those characters with no `/` — a base64 blob, a minified line, a pasted stack trace — the engine backtracks over every split point, which is quadratic. The 8.5s hook deadline could not help, because a `setTimeout` cannot fire while synchronous work holds the event loop. Matching is now done per whitespace-delimited token (exact, since the character class excludes whitespace) and skips tokens with no `/` or longer than a path. A 2MB single-token prompt now costs the same as an empty one.
- **`SEC-003` missed a committed credential unless it sat under one of twelve property names.** `KNOWN_CREDENTIAL_FORMATS` is documented as matching formats that are "unambiguously credentials, whatever they are assigned to", but it was only consulted for object property assignments whose key already matched. `export const STRIPE_KEY = "sk_live_..."` — the shape a real leak takes — was reported as no finding at all. Any string literal in a recognised issuer format (Stripe, GitHub, GitLab, Slack, AWS, Google, npm, SendGrid, PEM, JWT) is now reported wherever it appears; a connection URI pointing at `localhost` or a compose service name is excluded, because that is a development default rather than a leak.
- **`TORM-008` reported the recommended fix for dynamic sorting as a CRITICAL injection.** A dynamic `ORDER BY` cannot be bound as a parameter, so the documented remedy is to interpolate a value from a constant allow-list — and that pattern was flagged at CRITICAL/high, teaching users to ignore the tool's most severe finding. An interpolation is now a finding only when something in it is not provably a compile-time constant; `let` bindings, maps holding non-literal values, function calls and parameters are all still reported.
- **The skill-library fetcher followed redirects without a limit, accepted any scheme, and read responses without a size cap.** A server answering 302 with its own URL recursed until the stack ran out. Redirects are now bounded to five, restricted to https, and bodies are capped.

### Testing — independent validation

- Added `tests/config-safety.test.js`, `tests/prompt-hook-redos.test.js`, `tests/secret-literal-scope.test.js`, `tests/sql-interpolation-allowlist.test.js`, `tests/documentation-contract.test.js` and `tests/windows-behaviour.test.js`. Each of the bugs above has a test that failed before its fix.
- The documentation-contract test extracts every `backendguard ...` invocation from the README and checks it against the CLI's declared surface, so documentation and implementation cannot drift apart silently. It caught a stale marker in this release's own README edit.
- Beyond the suite, run against the installed artifact: 800 randomized CLI invocations, 140 shell-metacharacter and Unicode agent-name payloads, 90 malformed hook payloads, 14 configuration shapes, 21 process-kill/recovery scenarios, and 500 randomly malformed TypeScript sources. No shell injection, no hang, no out-of-scope write, no internal-bug misclassification.
- The suite goes from 405 tests to 578.

### Changed

- Agent names, aliases and the supported-agent list live in one module, `runtime/agents.js`, instead of being written down separately in the install command, the setup wizard and two normalizer functions that disagreed.
- `ConfigurationError` and `IntegrationError` join `UsageError` and `EnvironmentError`, so a malformed user config and a third-party tool's failure are classified as what they are. Only genuine BackendGuard faults are reported as bugs.
- `backendguard install --help` documents the positional agent form.

### Documentation

- The README documented `backendguard install --quiet` and `--inject`, neither of which was ever implemented; both were rejected with exit 2. Prompt injection is always on, and the section now says so.
- The install section documents the positional form, the prompt's preselection behaviour, and that selecting nothing is a usage error.

### Testing

- `tests/post-release-0.9.2-regressions.test.js` adds 60 tests covering each bug above, driving the CLI as a process so the exit code and the absence of "This is a bug in BackendGuard" are asserted directly. It includes a check that no module reachable from the CLI calls a process function it never imported — the specific mistake behind the skillshare crash.
- Hostile-input coverage: deeply nested expressions, oversized files, unterminated templates, binary files, symlinks that escape the project or loop, and shell-metacharacter filenames.

## [0.9.1] - 2026-09-06

Fixes from an adversarial audit that ran the tool against realistic backend fixtures written independently of the analyzers. Three of these were release blockers; all of them were invisible to the repository's own release rubric, which scored 100/100 while they were present.

### Fixed

- **The ORM analyzers silently produced nothing on idiomatic dependency-injection naming.** TypeORM required the injected field to be named `xRepo`/`xRepository`; Prisma required the call path to contain the word `prisma`. `private readonly products: Repository<Product>` and `private readonly db: PrismaService` — both extremely common — matched neither, so unbounded reads, N+1 loops and missing transaction boundaries went unreported with no indication anything had been skipped. Repository and client fields are now resolved from their **declared constructor parameter type**, recorded in the source index; the name pattern remains only as a fallback for untyped fields. A class extending `Repository<T>` is now recognised too, so a bare `this.find()` inside a custom repository is analyzed.
- **`SEC-003` reported environment-variable names as committed credentials, at `certain` confidence.** `{ secret: "JWT_SIGNING_SECRET", apiKey: "PARTNER_API_KEY" }` — a config map holding env var *names* — produced three HIGH findings at the highest confidence tier. A value is now judged a credential only on positive evidence: a recognised credential format (Stripe, GitHub, GitLab, Slack, AWS, Google, npm, SendGrid, PEM, JWT), a connection URI with an embedded password, or genuine entropy. Property names whose value is consumed *directly* as key material (`secretOrKey`, `privateKey`, `clientSecret`) still flag any literal, because nothing but a credential is ever written there. See `analysis/security/secret-detection.js`.
- **`backendguard check` returned zero structural findings on Windows.** `finding.file` came from `path.relative()` (`src\users\x.ts`) while `changedFiles` came from git (`src/users/x.ts`), and the two were joined by a `Set.has()`. The filter never matched, so `check` and the Stop hook silently reported nothing. All analysis paths are now normalised to forward slashes at the scanner boundary.
- **`SEC-002` ignored the `@Controller()` path prefix.** `@Controller("webhooks/stripe")` + `@Post()`, `@Controller("auth/login")` + `@Post()` and `@Controller("v1/health")` + `@Post()` were all flagged as unguarded, even though `webhook`, `login` and `health` were already in the public-route pattern — it was only ever matched against the method-level path. The full route is now composed before matching.
- **`SEC-001` ignored `@Exclude()` and `ClassSerializerInterceptor`** — the pattern NestJS documents for exactly this problem — and reported a correct implementation as a data leak. Excluded columns no longer count as sensitive, and a controller applying `ClassSerializerInterceptor` is not flagged.
- **Six commands answered a missing argument with exit code 70 and "This is a bug in BackendGuard. Please report it."** `context`, `benchmark`, `leaderboard`, `embeddings`, `sync` and `ruler`/`skillshare` threw bare `Error`s that the CLI could only classify as internal faults. `UsageError`/`EnvironmentError` moved to `runtime/errors.js` so modules below the CLI can raise them; those commands now exit 2 (usage) or 3 (environment) with an actionable hint.
- **Multi-line SQL statements bypassed every migration check.** A conventionally formatted `ALTER TABLE orders\n  ADD COLUMN region varchar(8) NOT NULL;` matched nothing, because the scan was line-by-line and every migration tool emits multi-line statements. SQL is now split into statements, each analyzed whole and reported at its starting line.
- **SQL injection by string concatenation was not detected.** `"SELECT * FROM orders WHERE status = '" + req.params.status + "'"` — the oldest and most common form — was missed; only template literals were inspected. `PG-012` now covers both, and ignores a concatenation of string constants.
- **Project-scope scalability findings were anchored to an arbitrary file.** `SCALE-006`/`SCALE-007` pinned a whole-project observation to whichever file happened to be scanned first, which reads as a claim about that file. They now anchor to the service entrypoint, or report against `(project)` and say so.
- The MCP smoke test's warm-path assertion and the package-lifecycle secret fixture were updated to match the corrected detector rather than the old behaviour.

### Changed

- **MCP tool names are now `backendguard_*`** (`backendguard_health`, `backendguard_detect_stack`, …). Eight of the ten still carried the pre-rename `ctx_` prefix — an agent-facing public interface. Every old `ctx_*` id is registered as a deprecated alias that forwards to the current tool, so an agent configuration written against 0.8.x keeps working; the MCP protocol smoke test drives the legacy ids end to end to prove it. The release gate's legacy-terminology scan now covers `ctx_`, which is why it missed these.
- The MCP server reports the package version instead of a hardcoded `0.1.0`.
- `evaluation/detection-quality/fixtures/idiomatic-naming/` was added to the labelled corpus: every defect in it was missed before this release, and its controls are the exact shapes that produced the high-confidence false positives.

## [0.9.0] - 2026-09-05

Architecture refactor and release hardening. The repository is reorganised by domain, the analysis engine becomes an extensible registry with Prisma, PostgreSQL, performance and scalability analyzers alongside the existing security and TypeORM checks, and the CLI, packaging and the tool's own security are brought to a releasable standard.

Full rationale and measurements: [docs/architecture/refactor-audit.md](docs/architecture/refactor-audit.md), [docs/evaluation/score-gap-analysis.md](docs/evaluation/score-gap-analysis.md), [docs/evaluation/release-validation.md](docs/evaluation/release-validation.md).

### Added

- **`backendguard analyze`** — whole-project static analysis, with `--json`, `--severity`, `--confidence`, `--category`, `--analyzer`, `--list-analyzers` and `--fail-on` for CI. `check` still answers "what did this change introduce"; `analyze` answers "what is in this repository".
- **Analyzer registry** (`analysis/analyzer-registry.js`). An analyzer is a plain object with `id`, `categories`, an optional `appliesTo(stack)` and an `analyze(context)`. Adding support for a framework, ORM, database or analysis category means writing one such object and registering it; nothing else changes. An analyzer that throws is reported by id and never suppresses another analyzer's findings.
- **Prisma analyzer** (`PRISMA-*`, 10 checks): a dedicated `schema.prisma` parser plus generated-client call-site analysis — unindexed relation scalars, missing unique constraints, monetary `Float` columns, models with relations but no primary key, hardcoded datasource URLs, unbounded `findMany`, queries in loops, deeply nested `include` with no `select`, `$queryRawUnsafe`, and writes without `$transaction`.
- **PostgreSQL analyzer** (`PG-*`, 7 checks): migration lock hazards (`ADD COLUMN NOT NULL` with no default, `ALTER COLUMN TYPE`, `ADD CONSTRAINT` without `NOT VALID`), `CREATE INDEX` without `CONCURRENTLY`, unscoped `UPDATE`/`DELETE` in a migration, unbounded `SELECT *`, connection-pool sizing and idle timeout, and SQL assembled by template interpolation.
- **Performance analyzer** (`PERF-*`, 4 checks) and **scalability analyzer** (`SCALE-*`, 7 checks): network calls in loops, synchronous filesystem and key-derivation calls on request paths, serialised awaits, unbounded `Promise.all` fan-out; request-spanning in-process state, per-replica rate limiting, local-filesystem user content, uncoordinated scheduled jobs, in-memory sessions, and missing graceful-shutdown/health contracts on a containerised service. Both are labelled as static observations in every output — no throughput or latency is claimed.
- **New security checks**: permissive CORS with credentials (`SEC-006`), unthrottled authentication endpoints (`SEC-007`), shell commands built from non-literal values (`SEC-008`), filesystem paths built from request input (`SEC-009`).
- **Labelled detection-quality corpus** (`evaluation/detection-quality/`) — three realistic projects: NestJS + TypeORM + PostgreSQL with planted defects, NestJS + Prisma, and an adversarial "secure baseline" written correctly while using `password`/`passwordHash`/`secret`/`token`/`query` throughout. `npm run evaluate:detection` reports recall, precision, false positives and false negatives; `tests/detection-quality.test.js` fails the build on any regression in either direction.
- **Package lifecycle verification** (`npm run test:package`): `npm pack`, install the tarball into an empty project, and run the CLI from the installed copy — including checks that every relative import resolves, every imported dependency is declared, and no test, fixture, or secret-shaped file is published.
- **Release-readiness rubric** (`npm run evaluate`): a deterministic, weighted scorecard plus eight release gates, runnable against any checkout so a before/after comparison is measured rather than asserted.
- **Scale benchmark** (`evaluation/performance/`): analysis of a generated 2000-file NestJS service, with a regression test asserting roughly linear scaling.
- **Deterministic compliance scoring**: per-category scores derived from `severity points x confidence factor`, with every deduction itemised and the formula printed, so a score can be checked by hand. A category with nothing to measure reports "not evaluated", never a false 100.
- **Per-command `--help`**, distinct exit codes (0 success, 1 findings, 2 usage, 3 environment, 70 internal), rejection of unknown flags, and `--json` on `analyze`, `check`, `stack`, `doctor` and `health`.
- **Evidence-based stack detection**: `backendguard stack --evidence` shows the dependency, file, or config line behind every detection; `--json` includes the same provenance.
- **Update-check opt-out**: `BACKENDGUARD_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, or any environment with `CI` set.

### Changed

- **Repository reorganised by domain.** `bin/ctx.js` became `cli/backendguard.js`; the 43 mixed-responsibility modules in `plugins/ctx/lib/` were split into `rules/`, `retrieval/`, `analysis/`, `compliance/`, `agent-context/`, `integrations/` and `runtime/`; `community-skills/` became `skills/`; `eval/` became `evaluation/`; `test/` became `tests/`; `scripts/` became `tooling/`; `launch/` moved under `docs/`. `.github/`, `.vscode/`, `.codex/`, `.agents/` and `docs/` keep their names because their ecosystems require or universally expect them — see [refactor-audit.md](docs/architecture/refactor-audit.md).
- **The Codex plugin directory is now `plugins/backendguard/`** and holds only manifests plus thin hook and MCP entrypoints; the implementation lives in the domain directories.
- **Stack detection resolves the nearest package**, not the nearest `.git`, so running inside one service of a monorepo describes that service.
- **DB-001/002/003 became TORM-001/002/003** and moved into the TypeORM analyzer, which only runs when TypeORM is actually detected. Prisma projects no longer receive repository-shaped advice.
- **Finding confidence** is now `certain` / `high` / `medium` / `low` (previously `high-structural` / `medium-structural` / `low-structural` / `heuristic`), describing how much of the finding was proven from syntax.
- **Retrieval vocabulary is generic backend vocabulary.** A table of one specific customer's service names (`content-access-service`, `tutorials`, `collections`) was biasing retrieval in every other repository and has been replaced by symmetric backend concept groups (payment/billing/invoice, cache/redis/ttl, queue/job/worker, ...).
- **The routing benchmark now covers the product's own domain**: eight backend cases over NestJS + TypeORM + PostgreSQL and NestJS + Prisma fixtures, and its backend skill definitions mirror the shipped packs in `skills/` rather than a thinner synthetic set.

### Fixed

- **Command injection in the tool's own process spawning.** Seven call sites combined `shell: true` with an argument array, which Node concatenates into a single `sh -c` command line; agent names, project paths, and `backendguard ruler -- <args>` passthrough arguments all reached those sites. All child processes now go through `runtime/process-runner.js` with `shell: false`.
- **Leaked developer machine paths** (`/home/<user>/workspaces/...`, a personal pipx virtualenv) committed in `.vscode/mcp.json`, and a committed `.vscode/mcp.json.bak`. The config is now workspace-relative and the backup is removed.
- **`backendguard check` crashed** on a `const workspaceDir = workspaceDir(...)` self-reference introduced while renaming.
- **Tokenizer kept sentence punctuation**, so `notifications.` never matched `notifications` anywhere in rule scoring or retrieval.
- **`--severity huge` reported "No such directory: huge"** — flag values were being read as positional path arguments.
- **A bullet that is only a file path or an `@include`** is no longer scheduled as a rule; its path segments were becoming scoring tokens.
- **Rule filtering no longer contains a hardcoded personal username**; the shell-user-switching pattern it was part of is now generic.
- Tests no longer depend on the ambient environment (`CI=1` legitimately disables the update check and was failing two update-notifier tests).

### Security

- See the new "Security Practices In This Codebase" section of [SECURITY.md](SECURITY.md).

### Breaking

- **The MCP server is registered as `backendguard-mcp`** (was `ctx-mcp`). Installers remove the old registration before adding the new one; a hand-written config that references `ctx-mcp` must be updated.
- **The Codex plugin id is `backendguard@backendguard`** (was `ctx@backendguard`). The installer removes the old id first.
- **The data root is `~/.backendguard`** (was `~/.ctx/backendguard`). If the new location does not exist and the old one does, the old one is used, so an upgrade keeps its warmed model and caches. Nothing is copied or deleted automatically.
- **`backendguard install --copy`** now copies a self-contained package root rather than the plugin directory alone, because the plugin directory is no longer runnable on its own.
- **Benchmark fixtures are no longer published** in the npm package. `npm run benchmark:skills` and `npm run evaluate:detection` require a repository checkout, and say so when run from an install.
- The `backendguard-codex` binary alias is retained.

## [0.8.0] - 2026-09-02

Implementation pass driven by a pre-NPM validation that scored the compliance/security checking pipeline 31/100. Full rationale and before/after evidence: [docs/implementation-gap-analysis.md](docs/implementation-gap-analysis.md).

### Added
- Structural (AST-based) analysis layer (`analysis/security/nestjs-security-analyzer.js`, then at `plugins/ctx/lib/ast-security-analyzer.js`) using the TypeScript compiler API, merged into `backendguard check` and the Stop hook alongside the existing AGENTS.md keyword-diff layer. Checks: sensitive entity field exposed via a controller with no response DTO (SEC-001), missing authentication guard on a route (SEC-002), hardcoded secret literal (SEC-003), unvalidated `@Body()` (SEC-004), raw `error.stack`/`error.message` built into a response (SEC-005), unbounded TypeORM query (DB-001), N+1 query pattern (DB-002), missing transaction boundary across multiple writes (DB-003). See [docs/architecture/compliance-engine.md](docs/architecture/compliance-engine.md#structural-analysis-layer).
- `confidence` field (`heuristic` / `high-structural` / `medium-structural` / `low-structural`) on every compliance finding, printed in `backendguard check`/`report` output.
- `typescript` as a runtime dependency (parser only, no `tsc`/build step).
- `SECURITY.md`, `CONTRIBUTING.md`.

### Fixed
- Compliance checker misclassified compound rule sentences (a required clause and a forbidden clause in one sentence) as entirely "forbidden," flagging correct code as a violation. Keyword extraction now scopes to the forbidden clause specifically.
- Compliance-check keyword matching used raw substring search, so a short keyword could match inside an unrelated identifier (`rate` inside `PrimaryGeneratedColumn`). Matching is now word-boundary-aware.
- Expanded the compliance-keyword stopword list to exclude generic prose verbs (`return`, `build`, `authorize`, `hash`, ...) that matched constantly in unrelated code and produced misleading evidence citations.
- Stack detection (`backendguard stack`, `detectProjectProfile()`) recursively merged dependencies from any nested `package.json`, including test/fixture directories, causing false-positive technology detection on repos with nested fixtures (reproduced on this repo's own routing benchmark fixtures). Fixture/test/example directories are now excluded from the walk.
- Context retrieval's "imperative language" scoring bonus (`always`/`never`/`must`) applied unconditionally, so nearly every well-written rule cleared the relevance-selection threshold regardless of task relevance — an irrelevant prompt still injected the full rule set. The bonus now only applies when the rule already has some task-relevance signal (exact or semantic token overlap), or when no specific task was given.

## [0.7.0] - 2026-09-02

Current published version. See [README.md](README.md) for full feature documentation, [docs/architecture/](docs/architecture/overview.md) for how the system is built, and [docs/roadmap.md](docs/roadmap.md) for planned work.
