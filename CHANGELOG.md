# Changelog

All notable changes to `@vantin/backendguard` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

> **Note:** this file was recreated from scratch. The project's release history prior to this entry was not available to reconstruct accurately, and this changelog does not fabricate it. Entries from this point forward are accurate.

## [0.8.0] - 2026-09-02

Implementation pass driven by a pre-NPM validation that scored the compliance/security checking pipeline 31/100. Full rationale and before/after evidence: [docs/implementation-gap-analysis.md](docs/implementation-gap-analysis.md).

### Added
- Structural (AST-based) analysis layer (`plugins/ctx/lib/ast-security-analyzer.js`) using the TypeScript compiler API, merged into `backendguard check` and the Stop hook alongside the existing AGENTS.md keyword-diff layer. Checks: sensitive entity field exposed via a controller with no response DTO (SEC-001), missing authentication guard on a route (SEC-002), hardcoded secret literal (SEC-003), unvalidated `@Body()` (SEC-004), raw `error.stack`/`error.message` built into a response (SEC-005), unbounded TypeORM query (DB-001), N+1 query pattern (DB-002), missing transaction boundary across multiple writes (DB-003). See [docs/architecture/compliance-engine.md](docs/architecture/compliance-engine.md#structural-analysis-layer).
- `confidence` field (`heuristic` / `high-structural` / `medium-structural` / `low-structural`) on every compliance finding, printed in `backendguard check`/`report` output.
- `typescript` as a runtime dependency (parser only, no `tsc`/build step).
- `SECURITY.md`, `CONTRIBUTING.md`.

### Fixed
- Compliance checker misclassified compound rule sentences (a required clause and a forbidden clause in one sentence) as entirely "forbidden," flagging correct code as a violation. Keyword extraction now scopes to the forbidden clause specifically.
- Compliance-check keyword matching used raw substring search, so a short keyword could match inside an unrelated identifier (`rate` inside `PrimaryGeneratedColumn`). Matching is now word-boundary-aware.
- Expanded the compliance-keyword stopword list to exclude generic prose verbs (`return`, `build`, `authorize`, `hash`, ...) that matched constantly in unrelated code and produced misleading evidence citations.
- Stack detection (`backendguard stack`, `detectProjectProfile()`) recursively merged dependencies from any nested `package.json`, including test/fixture directories, causing false-positive technology detection on repos with nested fixtures (reproduced on this repo's own `eval/skill-routing/fixtures/`). Fixture/test/example directories are now excluded from the walk.
- Context retrieval's "imperative language" scoring bonus (`always`/`never`/`must`) applied unconditionally, so nearly every well-written rule cleared the relevance-selection threshold regardless of task relevance — an irrelevant prompt still injected the full rule set. The bonus now only applies when the rule already has some task-relevance signal (exact or semantic token overlap), or when no specific task was given.

## [0.7.0] - 2026-09-02

Current published version. See [README.md](README.md) for full feature documentation, [docs/architecture/](docs/architecture/overview.md) for how the system is built, and [docs/roadmap.md](docs/roadmap.md) for planned work.
