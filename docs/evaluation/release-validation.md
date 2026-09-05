# Release Validation

## What was measured, and what could not be

The starting point for this work was an independent validation that scored the repository at commit `b43f511` **57/100 — NOT READY**. That validation ran outside this repository. Its scoring code is not here, so **it cannot be re-executed, and no "after" number against it can be claimed.** Asserting one would be fabrication.

What is measured instead is a rubric that lives in this repository:

```bash
npm run evaluate                    # this checkout
node evaluation/release-readiness/run-evaluation.js /path/to/other/checkout
```

Because it takes a path, the *same code* was run against a `git worktree` of the pre-refactor commit and against the current tree. That comparison is a real measurement rather than an assertion.

### Read the score with this caveat

The rubric was written by the same author as the changes it scores, and its categories are the areas the work targeted. A 100 on it means "every property this project decided to hold itself to is satisfied", not "this is a 100-quality product". Two specific weaknesses are worth stating:

1. **Per-check ceilings saturate.** "Covers a meaningful range of security risks" caps at 6 points, reached at 6 distinct checks; there are 9. A stronger implementation and an adequate one score the same.
2. **The rubric cannot measure what it does not ask about.** Nothing here scores documentation prose quality, API ergonomics for a second contributor, or behaviour on a codebase that looks nothing like the fixtures.

The **release gates** are the more meaningful signal, because each is a binary property with an external referent: the tests pass or they do not; the packed tarball installs or it does not.

## Before / after

Identical rubric, identical machine, run against commit `b43f511` and against the current tree.

| Category | Weight | Before | After | Δ |
| --- | ---: | ---: | ---: | ---: |
| Correctness and tests | 18 | 17 | 18 | +1 |
| Security analysis capability | 12 | 8 | 12 | +4 |
| Database, ORM and PostgreSQL analysis | 12 | 3 | 12 | +9 |
| Performance and scalability analysis | 8 | 0 | 8 | +8 |
| Detection quality (false positives and negatives) | 12 | 0 | 12 | +12 |
| Context retrieval quality | 8 | 8 | 8 | 0 |
| CLI reliability | 8 | 2 | 8 | +6 |
| Package integrity | 8 | 3 | 8 | +5 |
| Security of the tool itself | 6 | 1 | 6 | +5 |
| Architecture and extensibility | 8 | 0 | 8 | +8 |
| **Total** | **100** | **42** | **100** | **+58** |

| Release gate | Before | After | Evidence (after) |
| --- | --- | --- | --- |
| All automated tests pass | PASS | PASS | 372 passed, 0 failed |
| No known critical security issue in the tool itself | FAIL | PASS | 0 shell-interpolation sites, 0 leaked developer paths |
| The packed npm artefact installs and its CLI runs | FAIL | PASS | 19/19 package checks |
| Every documented command has working `--help` | FAIL | PASS | 21/21 commands |
| No unintended legacy product terminology remains | FAIL | PASS | 0 references (was 220) |
| Every relative import resolves | PASS | PASS | 0 unresolved |
| No secret material or developer path is committed or packed | FAIL | PASS | 143 packed files, none unwanted |
| Documentation describes behaviour that exists | FAIL | PASS | 6 analyzers registered and documented |
| **Gates passed** | **2/8** | **8/8** | |

The "before" run is not a re-creation of the external 57/100 and should not be read as one. It is what this repository's own rubric says about that commit.

### One measurement bug, found and fixed

The first "before" run scored security analysis 0/12, because the probe scanned `analysis/` — a directory that did not exist before the refactor. The pre-refactor tree did have five structural security checks and three database checks, in `plugins/ctx/lib/`. The probe now scans every product directory in either layout, and counts the pre-0.9.0 `DB-*` prefix alongside `TORM-*`. That correction moved the "before" total from 31 to 42. It is recorded here rather than quietly applied, because a flattering "before" is the easiest way to inflate a delta.

## Supporting measurements

### Detection quality — `npm run evaluate:detection`

| Metric | Result |
| --- | ---: |
| Planted defects found (recall) | 29/29 — 100% |
| Findings inside files labelled correct | 0 |
| Findings on the adversarial secure baseline | 0 |
| Ambiguous cases reported at low confidence | 2 |
| Stack detection mismatches | 0 |
| ORM analyzer run against the wrong ORM | 0 |
| Analyzer errors | 0 |

Corpus: `nest-typeorm-postgres` (21 planted defects across auth, users, orders, products, payments, notifications), `nest-prisma-postgres` (8 planted defects across schema and client call sites), `secure-baseline` (16 files, all controls).

**How much this is worth:** recall of 100% on fixtures written alongside the checks is a *regression gate*, not evidence about unseen code. The row that carries real weight is the third: a realistic, correct 16-file service — using `password`, `passwordHash`, `secret`, `token`, `refreshToken` and `query` throughout — produces zero findings. That is the failure mode (crying wolf) that gets an analyzer switched off, and it is tested against code deliberately written to bait a naive checker.

### Routing — `npm run benchmark:skills`

| Metric | Before | After |
| --- | ---: | ---: |
| Cases | 52 | 60 |
| Top-1 accuracy | 92.3% | 90.0% |
| Top-3 recall | 93.0% | 93.8% |
| False positive rate | 0.0% | 0.0% |
| Negative gate accuracy | 100.0% | 100.0% |

Top-1 accuracy fell 2.3 points while the corpus grew by 8 backend cases and top-3 recall rose. The eight new cases are in the product's actual domain (N+1 diagnosis, index placement, transaction boundaries, secret exposure, pagination, unique constraints, caching), where the previous corpus had almost no coverage. Reporting the fall rather than only the recall gain: a benchmark that only ever improves is not measuring anything.

### Scale — `node evaluation/performance/run-scale-benchmark.js`

| Files | Analyzed | Findings | Stack detection | Parse + index | Full analysis | ms/file |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 400 | 400 | 180 | 5 ms | 55 ms | 59 ms | 0.15 |
| 2000 | 2000 | 900 | 18 ms | 199 ms | 308 ms | 0.15 |

Node v25.2.0 on darwin/arm64. Linear in file count. This is wall-clock time on one machine used as a regression signal, not a published performance figure. `tests/scale.test.js` fails if 500 modules take more than 30 seconds or if scaling turns quadratic.

### Package — `npm run test:package`

19/19 checks: `npm pack --dry-run` contents, real `npm pack`, install into an empty project, `--version` / `--help` / `stack` / `analyze` from the installed copy, every relative import resolves, every imported dependency declared, no test/fixture/secret-shaped file published, 143 files at 0.78 MB unpacked.

## Remaining risks

1. **The strongest evidence is self-authored.** The fixtures, the rubric and the code share an author. The externally-referenced numbers — 372 tests passing, 19/19 package checks, a real `npm install` of a real tarball — are the load-bearing ones.
2. **Transitive dependency advisories persist.** `npm audit` reports advisories via `@xenova/transformers → onnxruntime-web → onnx-proto → protobufjs` and `sharp`, with no upstream fix. Disclosed in `SECURITY.md`; not fixable here.
3. **Detection breadth is bounded by design.** Redis correctness, IDOR/data-flow, API-design and Express-specific checks are not implemented. `backendguard analyze --list-analyzers` is the authoritative list; the README's Limitations section names the gaps.
4. **`0.9.0` contains breaking changes** to the MCP server name, the Codex plugin id and the data root. The data root migrates automatically by reading the old location; the other two are handled by the installer removing the old registration first. Anyone who hand-wrote `ctx-mcp` into their own config must update it.
5. **Windows is reasoned about, not exercised.** The `cmd.exe` fallback in `runtime/process-runner.js` is unit-tested with a stubbed platform, but no CI runner executes it on Windows.
6. **Agent integrations are verified structurally, not end-to-end.** Tests assert the hook and MCP configuration each installer writes. They do not launch Codex, Claude Code, Antigravity or Copilot and observe the injected context.
