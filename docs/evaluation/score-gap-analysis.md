# Score Gap Analysis

Starting point: an independent validation of this repository at commit `b43f511` (version 0.8.0) scored it **57/100 — NOT READY**.

That validation was performed outside this repository and its scoring code is not available here, so its exact number cannot be recomputed. What this document does instead is turn each of its subject areas into concrete, checkable implementation items, and record for each one what the code actually did before the change. The measured before/after comparison is in [release-validation.md](release-validation.md), using a rubric that lives in this repository and can be run against any commit.

Priorities: **P0** release-blocking · **P1** high value · **P2** important · **P3** optional.

---

## P0 — Correctness

### G1. `backendguard check` crashed on every invocation

- **Expected:** the command that reports compliance on the current diff runs.
- **Before:** `const workspaceDir = workspaceDir(cwd);` — a `const` shadowing the function it calls. Any invocation threw a temporal-dead-zone `ReferenceError`.
- **Root cause:** introduced during an earlier rename, with no test invoking `check` as a process.
- **Implementation:** renamed the local to `reportDir`.
- **Test:** `tests/cli-contract.test.js` now runs the CLI as a subprocess and asserts its exit code, so a crash in any command surfaces as a failing test rather than at a user's terminal.
- **Improvement:** the command works.

### G2. Command injection in the tool's own process spawning

- **Expected:** a security tool does not itself have an injection path.
- **Before:** seven call sites passed `{ shell: true }` together with an argument array. Node concatenates command and arguments into one `sh -c` command line in that mode (which is why it emits `DEP0190`). Arguments reaching those sites included agent names, project paths, MCP server names, and everything after `--` in `backendguard ruler -- <args>`.
- **Root cause:** `shell: true` was added to make Windows `.cmd` shims runnable; the POSIX consequence was not considered.
- **Implementation:** `runtime/process-runner.js`. All child processes go through it with `shell: false`. The Windows shim case is handled by quoting each argument individually for `cmd.exe` and **refusing** any argument containing a cmd metacharacter.
- **Test:** `tests/process-runner.test.js` — asserts `shell` is never set, that `"; rm -rf ~"` arrives as one literal argv entry, and that the Windows fallback refuses metacharacters.
- **Improvement:** zero shell-interpolation sites; enforced by a release gate.

### G3. Leaked developer machine paths in committed configuration

- **Expected:** nothing in the repository points at one person's machine.
- **Before:** `.vscode/mcp.json` contained `/home/minh_dev/workspaces/contextOS/...`, `/home/minh_dev/.ctx/...`, and a personal pipx virtualenv path. A `.vscode/mcp.json.bak` was committed alongside it. A rule filter in `analyzer.js` matched the literal username `minh_dev`.
- **Implementation:** the config is now `${workspaceFolder}`-relative, the `.bak` is deleted, and the username regex is replaced by a generic shell-user-switching pattern.
- **Test:** release gate `no-secret-leakage`; `npm run test:package` fails if anything secret-shaped is packed.

### G4. No verification of what npm actually publishes

- **Expected:** the published package installs and runs.
- **Before:** `npm pack --dry-run` ran in CI, but nothing checked the *contents*, and nothing ever installed the tarball. A domain directory missing from `package.json#files` would install cleanly and fail on first use.
- **Implementation:** `tests/package-lifecycle.test.mjs` (`npm run test:package`) — packs, installs into an empty project, runs `--version`, `--help`, `stack` and `analyze` from the installed copy, and verifies every relative import resolves, every imported dependency is declared, and nothing secret-shaped or test-shaped is published.
- **Improvement:** 19 package checks, all passing; a release gate.

### G5. CLI usage errors were indistinguishable from failures

- **Expected:** a mistyped flag and an internal crash are different things.
- **Before:** one global `catch` printed `error.message` and set exit code 1 for everything. No command had its own `--help`. An unknown flag was silently ignored, so `--sevrity high` looked like it had applied a filter.
- **Implementation:** `cli/command-registry.js` (one description per command, driving both help renderings and flag validation), `cli/exit-codes.js` (0 success / 1 findings / 2 usage / 3 environment / 70 internal), `cli/options.js` (validated values with actionable hints, unknown-flag rejection).
- **Test:** `tests/cli-contract.test.js` drives the CLI as a process; a test asserts the command table and the dispatch chain never drift apart.
- **Improvement:** 21/21 commands have working `--help`; usage errors exit 2 with one readable line and no stack trace.

---

## P1 — Analysis capability

### G6. No Prisma analysis at all

- **Expected:** Prisma is named in the package description and has a shipped rule pack.
- **Before:** Prisma was *detected* but never *analyzed*. `schema.prisma` is not TypeScript, so the existing AST layer could not read it, and no generated-client call sites were inspected. The previous gap analysis scoped this out explicitly.
- **Implementation:** `analysis/database/prisma-schema.js` (a focused Prisma Schema Language parser preserving line numbers) and `analysis/database/prisma-analyzer.js` — 10 checks across schema and call sites.
- **Test:** `tests/prisma-analyzer.test.js` (13 tests), plus a labelled `nest-prisma-postgres` fixture.
- **Improvement:** 0 → 10 Prisma checks, with a test asserting the analyzer never runs against a TypeORM project.

### G7. TypeORM findings were reported to Prisma projects

- **Expected:** ORM advice matches the ORM in use.
- **Before:** the `DB-001/002/003` checks lived in the security analyzer and ran unconditionally against every project.
- **Implementation:** moved to `analysis/database/typeorm-analyzer.js` behind `appliesTo: stack.orm === "TypeORM"`, renamed `TORM-*`, and extended from 3 checks to 8 (eager relations, missing FK indexes, unbounded QueryBuilder, `synchronize: true`, SQL interpolation).
- **Test:** `tests/typeorm-analyzer.test.js`; `evaluation/detection-quality` asserts `forbiddenAnalyzers` never run.

### G8. No PostgreSQL analysis independent of an ORM

- **Before:** nothing read `.sql` files, migrations, or pool configuration — the places production incidents actually come from.
- **Implementation:** `analysis/database/postgresql-analyzer.js` — 7 checks: migration lock hazards, `CREATE INDEX` without `CONCURRENTLY`, unscoped `UPDATE`/`DELETE`, unbounded `SELECT *`, pool sizing and idle timeout, SQL template interpolation.
- **Test:** `tests/postgresql-analyzer.test.js` (12 tests), each with a positive and a negative case.

### G9. No performance or scalability analysis

- **Before:** both were claimed in the README with nothing behind them. The README also referenced a "roughly 5,000-concurrent-user reference workload".
- **Implementation:** `analysis/performance/` (4 checks) and `analysis/scalability/` (7 checks). Every output states these are static observations, not measurements, and the capacity claim is removed from the README.
- **Test:** `tests/performance-scalability-analyzer.test.js` (11 tests).

### G10. Stack detection described the wrong project, and could not be interrogated

- **Before:** `findProjectRoot()` walked up to the nearest `.git`, so running inside one service of a monorepo described the whole repository. Detections carried no evidence, so a wrong answer could not be diagnosed.
- **Implementation:** the root is the nearest package manifest; every detection records the dependency, file, or matched config line behind it, exposed through `stack --evidence` and `stack --json`.
- **Test:** `tests/stack-detection.test.js` — including a case asserting a README that mentions NestJS/Prisma/PostgreSQL in prose produces no detection.

### G11. Detection quality was never measured

- **Expected:** false-positive and false-negative rates are the thing that decides whether an analyzer is used or switched off.
- **Before:** no labelled corpus, no measurement. The previous gap document's "before/after" section was never filled in.
- **Implementation:** `evaluation/detection-quality/` — three realistic projects with `expected-findings.json` labels, including an adversarial "secure baseline" written correctly while using `password`, `passwordHash`, `secret`, `token` and `query` throughout. `tests/detection-quality.test.js` fails the build on a missed defect *or* a finding inside a file labelled correct.
- **Improvement:** 29/29 planted defects found, 0 false positives, 0 findings on the secure baseline. **The honest caveat is in the README:** the fixtures and the checks were written together, so recall on this corpus is a regression gate, not evidence about unseen code.

### G12. Retrieval was biased toward one customer's vocabulary

- **Before:** `expandFileRetrievalTask()` injected a hardcoded list including `content-access-service`, `tutorials`, `collections` and `library` into every retrieval query, under the label "BackendGuard retrieval hints". Those are one previous project's module names; in any other repository they are noise.
- **Also:** the tokenizer kept trailing sentence punctuation, so `notifications.` never matched `notifications` anywhere in scoring or retrieval.
- **Implementation:** ten symmetric groups of generic backend vocabulary (payment/billing/invoice, cache/redis/ttl, queue/job/worker, ...) with plural folding; punctuation trimmed at token edges.
- **Test:** `tests/rule-engine.test.js` — asserts no project-specific service name appears in the table and that expansion is symmetric.

### G13. The routing benchmark did not cover the product's own domain

- **Before:** 52 cases, overwhelmingly Expo/Vercel/Firebase deployment. The backend skill definitions inside the benchmark were thinner than the packs actually shipped in `skills/`, so it measured a weaker artifact than the product.
- **Implementation:** 8 backend cases over NestJS + TypeORM + PostgreSQL and NestJS + Prisma fixtures (N+1, indexes, transactions, secret exposure, pagination, unique constraints, caching); the benchmark's backend skill definitions now mirror the shipped packs.
- **Improvement:** 52 → 60 cases; top-3 recall 93.0% → 93.8%; false positive rate 0.0%.

---

## P1 — Reporting

### G14. Compliance scores were not scores

- **Before:** categories reported `PASS`/`WARNING`/`FAIL` with no number and no arithmetic. A category with nothing to measure was reported the same way as a category that passed.
- **Implementation:** `buildComplianceScorecard()` — every category starts at 100 and loses `severity points × confidence factor` per finding, with each deduction itemised and the formula printed so a score can be checked by hand. A category with nothing to measure reports `not evaluated`, never 100.
- **Test:** `tests/compliance-reporter.test.js` — determinism, the exact arithmetic, the floor at zero, and the not-evaluated distinction.

---

## P2 — Architecture

### G15. One flat directory held every responsibility

- **Before:** 43 modules in `plugins/ctx/lib/` covering rule parsing, embeddings, graph retrieval, AST analysis, compliance, hooks, agent installers, skill sync, and generic utilities. `bin/ctx.js` was a 1342-line file mixing argument parsing, install orchestration, interactive wizards and output formatting. `analyzer.js` (749 lines) was both the rule scorer and the file retriever.
- **Implementation:** ten domain directories, documented in [refactor-audit.md](../architecture/refactor-audit.md). `analyzer.js` split into `rules/rule-engine.js` and `retrieval/file-retriever.js`; stack detection split out of the starter-context generator.

### G16. Adding an analyzer meant editing an unrelated file

- **Before:** every check was a function called from one hardcoded list inside the security analyzer. A parse failure in any check lost every finding from the whole run.
- **Implementation:** `analysis/analyzer-registry.js`. An analyzer is a plain object with `id`, `categories`, an optional `appliesTo(stack)` and `analyze(context)`. A throwing analyzer is reported by id and does not suppress the others.
- **Test:** `tests/analyzer-registry.test.js` — duplicate-id rejection, applicability gating, isolated failure, deterministic ordering.

---

## P2 — Not implemented, deliberately

Named here rather than left implied, and reflected in the README's Limitations section:

| Capability | Why not |
| --- | --- |
| Redis-specific analysis | The scalability analyzer covers what matters structurally (shared state, per-replica rate limiting, session storage). Cache-correctness checks (TTL policy, invalidation, stampede) need call-graph analysis this layer does not do. |
| IDOR / resource-ownership detection | Requires data-flow analysis from request parameter to query predicate. A pattern-matched version would produce exactly the confident-but-wrong findings this pass was about eliminating. |
| API design and response-shape consistency | Real, but stylistic. Low signal relative to implementation cost. |
| Express-specific routing checks | The security analyzer's decorator-based checks are NestJS-shaped. Express needs a different traversal; it is a clean addition through the registry. |
| Runtime performance measurement | Would require running the user's service. Everything shipped is explicitly labelled static. |
| Live agent leaderboard as a release gate | Depends on authenticated third-party CLIs being installed; unsuitable for a gate. |
