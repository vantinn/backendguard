# Implementation Gap Analysis

Source: the pre-NPM validation run performed against this repository (score: **31/100**, NOT READY). This document turns that evidence into implementation items. Every row below is grounded in a reproduced command and output, not a guess — see "Evidence" for the exact repro.

## How compliance/security findings are produced today

`plugins/ctx/lib/measure.js` — `checkCompliance()` — is pure text: for each `AGENTS.md` rule it (1) tokenizes the rule sentence into "compliance keywords," (2) classifies the whole rule as `forbidden` if the sentence contains `never`/`no `/`khong` anywhere, else `required`, (3) greps the git diff's added lines for any of those keyword substrings, and (4) reports `followed`/`ignored` based on presence/absence. There is no parsing of the changed *code* at all — no AST, no type information, no understanding of what a controller returns or whether a DTO validates. This is the root cause of nearly every finding below.

---

## Gap 1 — Compound-clause misclassification (root cause of the worst false positive)

- **Current capability:** `checkCompliance()` classifies an entire rule sentence as `forbidden` if it contains "never" anywhere in the sentence.
- **Weakness:** A rule like *"Hash passwords with bcrypt (or argon2)... Never store plaintext"* is one sentence with a required clause and a forbidden clause. The whole rule gets classified `forbidden`, so the keyword `hash` (extracted from the required clause) gets treated as a forbidden keyword — meaning **using bcrypt correctly triggers a violation**.
- **Evidence:** `backendguard check` on the validation fixture (56 files) → `**[HIGH]** Hash passwords with bcrypt (or argon2)... Never — Evidence: found forbidden hash in src/auth/auth.service.ts:34`, where line 34 is a correct `bcrypt.hash(...)` call.
- **Root cause:** `kind` is computed once per whole rule string (`measure.js`, `const kind = lower.includes("no ") || lower.includes("never") ... ? "forbidden" : "required"`) instead of per clause.
- **Required implementation:** Split rule content on clause boundaries (sentence-ending punctuation, or explicit `.`/`;`) before keyword extraction and kind classification; classify and score each clause independently, keeping the clause with the strongest signal (or, more conservatively, keep required-clause keywords out of the forbidden set entirely when a required verb like "hash"/"validate"/"use" precedes them).
- **Priority:** P0.
- **Expected measurable improvement:** Zero false "ignored" verdicts on rules whose required clause shares a word with an unrelated forbidden clause, verified by a fixture rule of exactly this shape.
- **Test required:** `test/measure.test.js` — compound-clause rule, added-lines containing only the compliant/required behavior → must report `followed`, not `ignored`.

## Gap 2 — Generic-English-word keyword extraction (false positives *and* false negatives)

- **Current capability:** `extractComplianceKeywords()` takes backtick-quoted terms plus any token ≥3 chars that isn't in an 18-word stoplist.
- **Weakness:** Ordinary programming/English words in rule prose (`return`, `hash`, `build`, `authorize`, `environment`, `find()`) become "evidence" keywords. Because these words appear constantly in unrelated code, matches are coincidental, not diagnostic — and evidence line citations point at the wrong file/function entirely.
- **Evidence:** On the same fixture run: `"Never authorize on role alone..."` → evidence `found forbidden authorize in src/auth/auth.service.ts:1` (the real IDOR bug is in `orders.controller.ts`, never cited); `"Never return a TypeORM entity directly..."` → evidence `found forbidden return in src/auth/auth.controller.ts:12` (the real passwordHash leak is in `users.controller.ts`, which is **never mentioned anywhere in the report**); `"Rate-limit authentication endpoints"` marked **compliant** because the substring `rate` matches inside the unrelated identifier `PrimaryGeneratedColumn` ("geneRATEd").
- **Root cause:** No distinction between semantically load-bearing nouns (`passwordHash`, `refreshToken`, `unique`) and structural/filler words; substring matching with no word-boundary or identifier-boundary check.
- **Required implementation:** (a) word-boundary-aware matching instead of raw substring `.includes()`; (b) a much larger stopword list covering common verbs/prepositions that appear in rule prose but carry no diagnostic signal on their own (return, use, keep, build, authorize, hash, respect, load, wrap, wrap, wrap, wrap); (c) prefer backtick-quoted / camelCase-identifier-shaped tokens over plain English words when both are available for a rule.
- **Priority:** P0.
- **Expected measurable improvement:** Evidence citations land in the file that actually contains the described pattern, verified against the fixture's known bug locations.
- **Test required:** `test/measure.test.js` — diff containing the word "rate" only inside an unrelated identifier must NOT satisfy a "rate-limit" rule.

## Gap 3 — No structural code understanding (the core gap)

- **Current capability:** None. All "detection" is keyword presence/absence in diff text.
- **Weakness:** The tool cannot verify a controller returns a DTO instead of an entity, that a route has a guard, that a DTO class has validator decorators, that a query is paginated, or that writes are transactional — the exact capabilities the product's own README and skill files describe as what AI agents should get guidance on.
- **Evidence:** Same fixture run — 8 deliberately planted bugs (passwordHash leak, IDOR, unvalidated `body: any`, hardcoded JWT secret ×2, missing transaction, N+1, unbounded `find()`, missing unique constraint). Only 1 of 8 (`unbounded find()`) was correctly attributed to the right file/line; that one match was still keyword-coincidental, not derived from understanding the code.
- **Root cause:** No parser is used anywhere in the codebase; `dependencies` in `package.json` has no AST/parsing library.
- **Required implementation:** A structural analyzer using the TypeScript compiler API (`typescript` — already the standard, minimal choice for parsing TS/decorators; not a "big framework") that walks controller/entity/DTO files and answers concrete structural questions. See Gaps 4-7 below for the specific checks this implementation covers in P0.
- **Priority:** P0.
- **Expected measurable improvement:** True positives on the fixture's planted bugs rise from 1/8 (coincidental) to real structural detections with correct file/line for the checks implemented; see the "Before / After" section at the end of this document once implemented.
- **Test required:** New `test/ast-security-analyzer.test.js` with true-positive, true-negative, and false-positive-control fixtures per check.

## Gap 4 — Sensitive-field response exposure never detected structurally

- **Current capability:** Keyword coincidence only (Gap 3).
- **Weakness:** No detection that a controller method returns an entity/object containing a sensitive field name without passing through a response DTO.
- **Evidence:** `users.controller.ts` returning a raw `User` entity (with `passwordHash`, `refreshToken` columns) is never cited in any finding.
- **Required implementation:** AST check: for each `@Entity()` class, collect column property names; for each controller method, find `return` statements; if the returned expression resolves to a call whose declared/inferred return type is that entity (not a `*Dto`/`*ResponseDto`-named class), and the entity has a sensitive-named column (`password`, `passwordHash`, `refreshToken`, `secret`, `apiKey`, `token`), flag `SEC-001`.
- **Priority:** P0.
- **Test required:** True positive (fixture's `users.controller.ts`), true negative (`secure-example` control module, which maps to a DTO).

## Gap 5 — Missing authentication guard never detected structurally

- **Current capability:** None (keyword coincidence only).
- **Weakness:** A controller/route missing `@UseGuards(...)` is not flagged; a *removed* guard is invisible entirely because `checkCompliance` only scans added diff lines, never removed ones.
- **Required implementation:** AST check: for each `@Controller()` class and each `@Get/@Post/@Patch/@Put/@Delete` method, check for `@UseGuards(...)` on the method or the class. Flag methods with neither, unless the route is in an explicit public allowlist pattern (e.g. `@Public()` decorator, or path under `/auth/login`, `/auth/register` — configurable). This also naturally fixes the diff-only blind spot for *this* check, because it analyzes the current file state, not only added lines.
- **Priority:** P0.
- **Test required:** True positive (fixture's payments endpoint with no guard), true negative (guarded endpoints), one "explicitly public" case (login/register) that must NOT be flagged.

## Gap 6 — Hardcoded secret literal never detected structurally

- **Current capability:** Keyword coincidence only; the actual bug (`secret: 'literal-string'` in `jwt.strategy.ts`/`auth.module.ts`) was never cited with correct evidence — the only "hit" was an unrelated match on `docker-compose.yml`'s `environment:` YAML key.
- **Required implementation:** AST check: find object-literal properties named `secret`/`secretOrKey`/`apiKey`/`password` (case-insensitive) whose value is a plain string literal (not a `process.env.*` / config-service call / template literal referencing env). Flag `SEC-003`.
- **Priority:** P0.
- **Test required:** True positive (fixture's hardcoded secret), true negative (`process.env.JWT_SECRET`).

## Gap 7 — Unvalidated request body never detected structurally

- **Current capability:** Keyword coincidence only.
- **Weakness:** `@Body() body: any` (or an untyped `@Body()`) is not detected; a DTO class with no `class-validator` decorators on any property is not detected either.
- **Required implementation:** AST check: (a) flag `@Body()` parameters typed `any` or with no type annotation; (b) for DTO classes referenced by `@Body()`, flag when zero properties carry a `class-validator` decorator (`@IsString`, `@IsEmail`, `@IsNotEmpty`, etc.).
- **Priority:** P0.
- **Test required:** True positive (fixture's `users.create` with `body: any`), true negative (DTOs using `class-validator`).

## Gap 8 — TypeORM query risks never detected structurally

- **Current capability:** The one working "true positive" in the whole validation (`products.findAll` unbounded `find()`) was a keyword coincidence, not a real check, and N+1/missing-transaction/unindexed-FK were all missed.
- **Required implementation:** Three AST checks: (a) `repository.find(...)`/`.find()` call with no `take`/`skip` (or cursor pattern) in the options object → `DB-001` unbounded query; (b) a repository `.find(...)`/`.findOne(...)` call inside a `for`/`for-of`/`.forEach`/`.map` loop body → `DB-002` N+1 pattern; (c) 2+ distinct repository write calls (`.save`/`.remove`/`.insert`/`.update`) in one function body with no enclosing `dataSource.transaction(`/`queryRunner` → `DB-003` missing transaction boundary.
- **Priority:** P0.
- **Test required:** True positive + true negative for each of the 3 checks against the fixture's `orders.service.ts` (N+1), `products.service.ts` (unbounded), `payments.service.ts` (no transaction), and `secure-example.service.ts` (correct pagination/joins, as a false-positive control).

## Gap 9 — Stack-detection false positive on nested package.json files

- **Current capability:** `detectProjectProfile()` walks the whole repo tree (depth ≤4, excluding only `node_modules`/`.git`/`.ctx`) merging dependencies from every `package.json` found.
- **Weakness:** Any nested fixture/example/test `package.json` pollutes top-level stack detection.
- **Evidence:** `backendguard stack` run on this repository's own root falsely reports Framework: NestJS, ORM: Prisma, Cache: Redis, Authentication: JWT — none of which are true for this Node CLI tool — because it merges dependencies from `eval/skill-routing/fixtures/*/package.json`.
- **Root cause:** `walk()` in `plugins/ctx/lib/project-context-generator.js` has no fixture/test/example directory exclusion and no workspace-boundary check.
- **Required implementation:** Exclude conventional non-source directories (`fixtures`, `__fixtures__`, `test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `examples`, `example`) from the walk, in addition to the existing `node_modules`/`.git`/`.ctx` exclusions.
- **Priority:** P0 (cheap, high-impact, already-proven bug).
- **Test required:** `test/stack-detection.test.js` — a repo root with a nested `fixtures/other-stack/package.json` must not leak that stack into the root report.

## Gap 10 — Context retrieval score-floor saturation

- **Current capability:** `scoreRules()` adds a flat `+0.5` to any rule containing an imperative word (always/never/must/...), and the scheduler's "high relevance" bucket starts at `0.5`.
- **Weakness:** Any well-formed rule (which is exactly what the tool's own `doctor` command tells users to write) clears the relevance threshold regardless of task relevance. Measured: for two unrelated tasks ("secure user registration" vs. "optimize a slow PostgreSQL query") the retrieved rule list and ranking were **identical** with embeddings off, and even with embeddings on, an irrelevant "Create a frontend React component" prompt still returned all 15/15 backend rules.
- **Root cause:** The imperative bonus is a flat additive constant large enough to dominate the score on its own, and there is no rejection path for a task with weak/no overlap with any rule.
- **Required implementation:** (a) Reduce the imperative bonus so it nudges ranking among already-relevant rules rather than single-handedly crossing the selection threshold; (b) add a minimum task/domain-overlap floor (e.g. require at least one exact or semantic token match, or an embedding score above a low floor) before a rule is eligible for the "high" bucket at all.
- **Priority:** P1 (real problem, but doesn't produce incorrect/misleading findings the way P0 items do — it produces noise, not wrong verdicts).
- **Test required:** `test/scheduler.test.js` / `test/analyzer.test.js` — an irrelevant prompt against a rule set with zero token overlap must select fewer than the full candidate set.

## Gap 11 — Diff-only scanning misses regressions (structural, not fully fixable by keyword approach)

- **Current capability:** `checkCompliance` only inspects added diff lines.
- **Weakness:** Deleting a security control (e.g. removing `@UseGuards(...)`) produces no signal.
- **Required implementation:** Partially addressed by Gap 5 (the AST guard check analyzes current file state, not the diff, so it catches this case regardless of diff shape). Full diff-aware removal detection for arbitrary rules is out of scope for P0 — tracked as P2.
- **Priority:** P0 (via Gap 5) for the guard case specifically; P2 for the general case.

## Gap 12 — Ships with critical/high transitive dependency advisories

- **Current capability:** N/A (dependency issue, not a code defect).
- **Evidence:** `npm audit` after a fresh install reports 1 critical + 5 high advisories, all transitive via `@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`, plus `sharp`; no upstream fix available.
- **Required implementation:** No fix currently exists upstream. Documented transparently in `SECURITY.md` (already done in the prior documentation pass). Not actionable as a P0/P1 code change; re-check when upstream publishes a fix.
- **Priority:** P2 (monitor), already disclosed.

---

## Resolution status (this implementation pass)

| Gap | Status | Evidence |
| --- | --- | --- |
| Gap 1 — compound-clause misclassification | **Fixed** | `classifyRuleClauses()` in `measure.js`; `test/measure.test.js` — "does not flag a required clause's own keyword..." / "still catches a real violation..." |
| Gap 2 — generic-word keyword extraction | **Fixed** | Word-boundary matching (`keywordMatchPattern()`) + expanded `GENERIC_PROSE_STOPWORDS` in `measure.js`; `test/measure.test.js` — Gap 2 tests |
| Gap 3 — no structural code understanding | **Implemented (P0 subset)** | `plugins/ctx/lib/ast-security-analyzer.js`, 23+ tests in `test/ast-security-analyzer.test.js`; see Gaps 4-8 for per-check status |
| Gap 4 — sensitive-field response exposure | **Implemented** | SEC-001; catches both a direct return and a return-via-local-variable (fetch/null-check/return) shape; true positive + true negative + false-positive-control tests |
| Gap 5 — missing authentication guard | **Implemented** | SEC-002; severity/confidence split for state-changing vs. `GET` routes based on real fixture false-positive review |
| Gap 6 — hardcoded secret literal | **Implemented** | SEC-003 |
| Gap 7 — unvalidated request body | **Implemented** | SEC-004 (untyped/`any` body, and DTO with zero class-validator decorators) |
| Gap 8 — TypeORM query risks | **Implemented** | DB-001 (unbounded), DB-002 (N+1), DB-003 (missing transaction, textual-containment heuristic — documented as a known limitation, not full data-flow proof) |
| Gap 9 — stack-detection false positive | **Fixed** | `NON_WORKSPACE_DIR_NAMES` exclusion in `project-context-generator.js`; reproduced-then-fixed on this repo's own `eval/skill-routing/fixtures/`; `test/stack-detection.test.js` regression test |
| Gap 10 — context retrieval score-floor saturation | **Fixed** | Conditional imperative bonus in `analyzer.js` `scoreRules()`; verified live against the mini-test fixture — an irrelevant prompt now selects 3/15 rules instead of 15/15, and "secure registration" vs. "optimize a slow query" now produce genuinely different top-ranked rules instead of identical lists |
| Gap 11 — diff-only scanning misses regressions | **Partially fixed** | The guard case (Gap 5) now analyzes current file state via structural analysis, not the diff, so a removed `@UseGuards` is caught. General diff-removal-awareness for arbitrary AGENTS.md rules remains P2, not implemented |
| Gap 12 — critical/high transitive dependency advisories | **Unchanged (documented)** | No upstream fix exists; disclosed in `SECURITY.md`. `typescript` itself (added this pass) resolves with zero dependencies and added no new advisories (`npm ls typescript` confirmed) |

Also added beyond the original gap list, found during fixture-driven testing of the new analyzer: **SEC-005** (raw `error.stack`/`error.message` built into a response payload) — the fixture's `payments.controller.ts` had this exact bug, explicitly called out in the original validation's security section but not covered by any gap-list item.

## Explicitly out of scope for this pass (P2/P3 — not implemented now)

Per the instruction not to implement shallow, unverified coverage across every category: Redis-specific analysis, Docker/deployment analysis, observability checks, API-versioning/design checks, architecture (business-logic-in-controller) detection, and Prisma-specific AST checks are **not** implemented in this pass. The codebase already supports Prisma/TypeORM *stack detection* correctly (verified in the prior validation); Prisma-specific *code analysis* would reuse the same TypeScript-AST approach built here but operates on `schema.prisma` (a different, non-TS grammar) and generated-client call sites, which is a distinct piece of work. Scoping these out is a deliberate choice to implement a smaller set of checks with real evidence rather than a large set with none — see the accompanying plan for what P0 actually covers.
