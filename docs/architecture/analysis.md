# Analysis Engine

The analysis engine is the part of BackendGuard that reads your source and reports concrete, evidence-anchored findings. It is separate from — and much stronger than — the rule-keyword compliance layer described in [compliance-engine.md](compliance-engine.md).

## Shape

```
detect stack  ──►  parse project once  ──►  run every applicable analyzer  ──►  merge, dedupe, sort
   │                      │                            │
stack-detector.js   source-index.js          analyzer-registry.js
```

| File | Responsibility |
| --- | --- |
| `analysis/stack-detector.js` | What technologies does this repository actually use, and what is the evidence? |
| `analysis/project-scanner.js` | Bounded, deterministic, symlink-safe file collection. |
| `analysis/source-index.js` | One TypeScript parse of the project; cross-file facts (entities, controllers, DTOs, repository fields, entity-returning methods). |
| `analysis/ast-utils.js` | Syntax helpers shared by every analyzer. |
| `analysis/finding.js` | The single finding shape, severity/confidence weighting, ordering, dedupe, and supersession. |
| `analysis/analyzer-registry.js` | Registration, applicability, isolated execution. |
| `analysis/index.js` | The pipeline, plus the adapters `check` and the Stop hook use. |

Analysis is **syntax-level**: `ts.createSourceFile`, no `ts.Program`, no type checker. Building a full Program over an arbitrary user project is slow and fails outright on any project whose `tsconfig.json` does not resolve — precisely the situation an analysis tool has to keep working in. Cross-file relationships are resolved from decorators and declared constructor parameter types instead, which covers the NestJS/TypeORM/Prisma shapes without that fragility. Where a check cannot prove something at this level, it says so through its confidence value rather than guessing.

## The finding shape

Every analyzer produces the same object:

| Field | Meaning |
| --- | --- |
| `id` | Stable check id: `SEC-003`, `TORM-001`, `PRISMA-010`, `PG-002`, `PERF-001`, `SCALE-004`. Prefixes never overlap between analyzers. |
| `category` | Security · Database · Performance · Scalability · Architecture · Testing |
| `severity` | CRITICAL · HIGH · MEDIUM · LOW · INFO |
| `confidence` | How much was *proven* from syntax — see below |
| `analyzer` | Which analyzer produced it |
| `title` / `detail` | What is wrong, and why this specific code triggers it |
| `evidence` | The source construct the finding is anchored to |
| `remediation` | The concrete fix |
| `file` / `line` / `column` | Where |

### Confidence

| Value | Meaning |
| --- | --- |
| `certain` | The construct itself is the defect. `synchronize: true` is `synchronize: true`. |
| `high` | One inference step: a declared type, a decorator, a resolved DTO class. |
| `medium` | Several steps, or a naming convention. |
| `low` | A real signal that is legitimate in some designs. Needs a human. |

Confidence is not a hedge — it is what makes a report triageable, and it feeds the deterministic compliance score directly (`severity points x confidence factor`).

### Supersession

A broad, low-confidence finding is dropped when a specific, higher-confidence finding already explains the same code. `PERF-003` ("awaited work is serialised across loop iterations") fires on exactly the same loop as `TORM-002` ("repository query inside a loop") — reporting both says the same thing twice and buries the one with the actionable fix. A finding opts in by carrying `supersededWithin: { startLine, endLine }`.

## Registered analyzers

| id | Prefix | Runs when | Covers |
| --- | --- | --- | --- |
| `nestjs-security` | `SEC-` | always | guards, hardcoded secrets, request validation, entity exposure, error leakage, CORS, rate limiting, shell execution, path traversal |
| `typeorm` | `TORM-` | TypeORM detected | unbounded reads, N+1, transaction boundaries, eager relations, missing indexes, QueryBuilder bounds, `synchronize`, SQL interpolation |
| `prisma` | `PRISMA-` | Prisma detected | schema indexes/constraints/types/primary keys/datasource URL; `findMany` bounds, queries in loops, `include` depth, `$queryRawUnsafe`, `$transaction` |
| `postgresql` | `PG-` | PostgreSQL detected | migration lock hazards, `CREATE INDEX` concurrency, unscoped writes, `SELECT *`, pool sizing, inline SQL interpolation |
| `performance` | `PERF-` | always | network calls in loops, synchronous blocking calls on request paths, serialised awaits, unbounded fan-out |
| `scalability` | `SCALE-` | always | in-process state, per-replica rate limiting, local filesystem writes, uncoordinated cron, in-memory sessions, shutdown and health contracts |

`appliesTo` is what keeps a Prisma project from receiving repository-shaped TypeORM advice. `backendguard analyze --list-analyzers` prints the live list; `--analyzer <ids>` overrides applicability when you want to force one.

## Adding an analyzer

An analyzer is a plain object. No base class, no dependency-injection container.

```js
// analysis/database/mongodb-analyzer.js
import { createFinding } from "../finding.js";

export const mongodbAnalyzer = {
  id: "mongodb",
  title: "MongoDB",
  categories: ["Database", "Performance"],
  // Omit appliesTo to always run.
  appliesTo: ({ stack }) => stack?.database === "MongoDB",
  analyze({ index, cwd, stack }) {
    const findings = [];
    for (const { sourceFile, relativePath } of index.files) {
      // ... walk the AST, push createFinding({ ... })
    }
    return findings;
  }
};
```

Then:

1. Register it in `defaultAnalyzers` in `analysis/index.js`.
2. Pick an unused id prefix and document it in the table above.
3. Add `tests/mongodb-analyzer.test.js` with a true positive **and** a true negative for every check.
4. Add a labelled fixture under `evaluation/detection-quality/fixtures/`, or extend an existing one, so the check is covered by the recall/precision gate.

Nothing else in the codebase changes. An analyzer that throws is caught by the registry, reported by id in `result.errors`, and does not suppress any other analyzer's findings.

## Adding a check

Inside an existing analyzer:

1. Write the check as a function taking `{ sourceFile, relativePath }` (plus the index if it needs cross-file facts) and returning `Finding[]`.
2. Choose severity by consequence and confidence by how much you proved. If a correct design can trigger it, it is `low` — say so in `detail`, and say what to verify.
3. Add three tests: the defect, correct code that must stay clean, and any ambiguous shape you deliberately decided to report or ignore.
4. Extend a labelled fixture. `tests/detection-quality.test.js` fails on a missed defect *and* on a finding inside a file labelled correct, so a check that gains recall by losing precision cannot land quietly.

## Adding stack detection

`analysis/stack-detector.js` is a table of evidence rules. A detection is a dependency in a specific `package.json`, a file that exists, or a matched line in a config file — never prose. Add a `record("<platform>", detector.any([...]))` line and map it into `buildStackReport`, then add a positive **and** a negative case to `tests/stack-detection.test.js`. A README that says "we use Prisma" must not produce a Prisma detection; there is a test for exactly that.

## Bounds

| Bound | Value | Why |
| --- | --- | --- |
| Max files scanned | 2000 | Beyond a few thousand the parser dominates CLI runtime. Reaching the cap is reported in the output, not applied silently. |
| Max file size | 512 KB | Anything larger in a backend project is generated. |
| Max directory depth | 12 | |
| Symlinks | never followed | Analysis must not read outside the project it was pointed at. |

Measured on a generated NestJS + TypeORM corpus (`npm run evaluate` → scale benchmark): 2000 files parse and analyze in roughly 300 ms, scaling linearly at about 0.15 ms per file. That is a regression signal from one machine, not a published performance figure.
