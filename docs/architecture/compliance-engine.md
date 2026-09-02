# Compliance Engine

This covers how BackendGuard decides whether a completed task actually followed the rules it was shown, and how the severity-ranked compliance report is built. It is the "post-task analysis" half of the product — the counterpart to [rule-engine.md](rule-engine.md)'s "before the task" retrieval.

## Two independent scores — don't conflate them

BackendGuard has two separate report-shaped outputs that are easy to confuse:

1. **Repository readiness** (`backendguard doctor`, `plugins/ctx/lib/certification.js` — `inspectBackendGuardReady()`): a *static* score of whether a repo has enough `AGENTS.md` rules, rule-pack coverage, and workflows for BackendGuard to be useful at all. It does not look at any specific task or diff. Output: `{ rules, skills, workflows, overall, tier, recommendations }`, tiers Not Ready → Bronze → Silver → Gold.
2. **Compliance report** (`backendguard report`/`backendguard check`, `plugins/ctx/lib/measure.js` + `reporter.js`): whether *this specific task's* changes actually followed the rules that were scheduled for it. This is the one with severity/category findings.

## Compliance checking pipeline

```text
git diff HEAD (or git status fallback)   [measure.js — readGitSnapshot()]
        │
        ▼
for each scheduled rule:
  - extract compliance keywords from rule text (backtick-quoted terms + significant tokens)
  - classify as "forbidden" (never/no/khong) or "required"
  - runtime-only rules (e.g. "always use X before Y") checked against telemetry.jsonl instead of the diff
  - search added diff lines for keyword evidence
        │
        ▼
classify each rule: followed | ignored | unknown | unmeasurable   [measure.js — checkCompliance()]
        │
        ▼
buildReport()   [reporter.js]  — assembles the full report object
        │
        ▼
buildComplianceSummary()   [reporter.js]  — the severity-ranked Security/Architecture/Database/Performance/Testing view
        │
        ▼
formatReport() → markdown printed by `backendguard report` / `backendguard check`
```

`readGitSnapshot()` prefers `git diff HEAD`; if that's unavailable it falls back to `git status --short` plus reading each changed file's own content (bounded to 400 lines / 200KB) so compliance can still be measured on an unstaged/untracked-only change.

### Rule outcome semantics

```text
followed     = evidence in the diff suggests the rule was applied
ignored      = evidence in the diff suggests the rule was violated
unknown      = the rule was relevant, but the diff does not prove either way
unmeasurable = BackendGuard lacks the required evidence source (no diff lines, or a
               runtime-only rule with no telemetry source available)
```

This is heuristic keyword matching against a git diff, not static analysis or a security audit — see the README's [Limitations](../../README.md#limitations) section. It prioritizes review; it does not replace one.

## Severity classification

File: `plugins/ctx/lib/reporter.js` — `buildComplianceSummary()`.

Every `ignored`/`unknown`/`followed` compliance item is classified into a category by keyword pattern-matching its rule text (`SEVERITY_RULES`, checked in order — first match wins):

| Category | Baseline severity | Trigger pattern (abbreviated) |
| --- | --- | --- |
| Security | HIGH | password, secret, token, jwt, auth, rbac, permission, inject, sanitize, cors, rate limit, csrf, xss |
| Database | MEDIUM | index, migration, transaction, query, N+1, constraint, foreign key, schema, orm, prisma, typeorm, postgres, sql |
| Performance | MEDIUM | cache, redis, scal(e/ing/ability), concurrency, connection pool, throughput, latency, queue, pagination |
| Testing | LOW | test(s/ing), coverage, assert, mock, e2e |
| Architecture (default) | INFO | everything else |

A category's overall status is `FAIL` if it has any `ignored` item with HIGH/CRITICAL severity, `WARNING` if it has any `ignored`/`unknown` item, `PASS` if every measured item in that category was `followed`, and `not evaluated` — never a false `PASS` — if no rule in that category was measured at all for this task. This is the one honesty guarantee worth calling out explicitly: **an unmeasured category is reported as unmeasured**, not as passing.

This is intentionally a *heuristic on free-text rule content*, not a structured severity field, because AGENTS.md rules have no metadata schema (see [rule-engine.md](rule-engine.md)). Rule packs (`skill.yaml`) do carry richer structured metadata already — extending severity classification to read it from there when a matched rule pack is known is tracked in the README's [Roadmap](../../README.md#roadmap).

### Changing severity classification

Edit `SEVERITY_RULES` in `plugins/ctx/lib/reporter.js`. Keep patterns narrow and check order-sensitive — a rule mentioning both "password" and "test" should classify as Security (checked first), not Testing. `test/reporter.test.js` has focused unit tests for this; add a case there for any new pattern.

## Structural analysis layer

File: `plugins/ctx/lib/ast-security-analyzer.js`, wired into both `backendguard check` (`bin/ctx.js`) and the Stop hook (`stop-hook.js`) via `structuralComplianceForChangedFiles()`.

This is a second, independent finding source alongside AGENTS.md rule compliance above. It does not read `AGENTS.md` at all — it parses TypeScript source with the TypeScript compiler API (`ts.createSourceFile`, no full `ts.Program`/type-checker) and pattern-matches on real AST structure: decorators, class members, constructor-parameter generic type arguments, and call-expression shape. Findings are normalized to `{ id, category, severity, confidence, title, detail, remediation, file, line }` and adapted into the same `{ rule, status, evidence, ... }` shape as AGENTS.md compliance items via `toComplianceItems()`, so `reporter.js` renders both through one path — `classifyItem()` in `reporter.js` reads a structural item's explicit `category`/`severity`/`confidence` instead of keyword-guessing them the way it does for AGENTS.md rule content.

```text
git diff HEAD (changed files)
        │
        ▼
analyzeProjectSource({ cwd })   [ast-security-analyzer.js]
  — parses the WHOLE project (bounded to 400 .ts files), not just the diff,
    because resolving "does this controller leak entity X" requires reading
    the entity/service files even when only the controller changed
        │
        ▼
filter findings to changedFiles only   [structuralComplianceForChangedFiles()]
  — keeps `check`/the Stop hook report scoped to the current change, while
    still benefiting from whole-project cross-file resolution
        │
        ▼
toComplianceItems()  — adapt into the compliance-item shape
        │
        ▼
merged with checkCompliance()'s output before buildReport()/buildComplianceSummary()
```

Current checks (see the module for exact logic and `test/ast-security-analyzer.test.js` for true-positive/true-negative/false-positive-control coverage of each):

| ID | Check | Confidence |
| --- | --- | --- |
| SEC-001 | Sensitive entity field (`passwordHash`, `refreshToken`, ...) returned from a controller with no response DTO. Resolves entity ⟷ service ⟷ controller by following `@InjectRepository(Entity) private x: Repository<Entity>` constructor types and matching `return this.field.method(...)` (directly or via a local variable). | medium-structural |
| SEC-002 | Route handler (`@Get`/`@Post`/...) with no `@UseGuards(...)` at method or class level, and no public-route naming convention match (login/register/health/webhook/...). | high-structural (state-changing verbs) / low-structural (`GET` — often intentionally public) |
| SEC-003 | Plain string literal assigned to a `secret`/`secretOrKey`/`apiKey`/`clientSecret`-shaped object property. | high-structural |
| SEC-004 | `@Body()` parameter typed `any`/untyped, or typed to a same-project DTO class with zero `class-validator` decorators on any property. | high-structural |
| SEC-005 | A `catch` block builds `err.stack`/`err.message` into an object literal (response/thrown payload) rather than only logging it. | high-structural |
| DB-001 | `repo.find(...)` (name pattern `*repo`/`*repository`) with no `take`/`skip`/`cursor`. Excludes `Array.prototype.find(predicate)` by checking the first argument isn't a function. | high-structural |
| DB-002 | A repo read call (`find`/`findOne`/`findOneBy`/`findBy`) nested inside a loop (`for`/`for-of`/`while`/`.forEach`/`.map`). | high-structural |
| DB-003 | 2+ repo write calls (`save`/`remove`/`insert`/`update`/`delete`) in one function body with no `.transaction(`/`queryRunner` anywhere in that function's text. | medium-structural (the "no transaction" side is a textual containment check within the AST-located function boundary, not a full data-flow proof) |

### Adding a structural check

Add a new `checkX(sourceFile, relativePath, index?)` function following the existing ones, call it from `analyzeProjectSource()`, and give it a stable `ID` (`SEC-00N`/`DB-00N`/a new prefix for a new category). Add true-positive, true-negative, and false-positive-control cases to `test/ast-security-analyzer.test.js` — the false-positive-control test in particular (a fully secure module using words like "password"/"token"/"query" in benign ways) is the regression guard against the exact failure mode the keyword-diff layer above has: a check that fires on vocabulary instead of structure.

## Where reports are stored

`~/.ctx/backendguard/workspaces/<workspace-id>/last-report.json` (written by the Stop hook, `plugins/ctx/lib/stop-hook.js`, or directly by `backendguard check`) and `report-history.jsonl` for the full history. See the README's [Runtime Files](../../README.md#runtime-files) section for the full layout.
