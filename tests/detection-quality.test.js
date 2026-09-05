import { describe, expect, it } from "vitest";

import { evaluateFixture, listFixtures, runDetectionEval } from "../evaluation/detection-quality/run-detection-eval.js";

/**
 * Regression gate on detection quality.
 *
 * These assertions are what stops a future change from quietly trading recall
 * for precision (or the reverse): the labelled corpus has to stay at zero
 * missed defects and zero findings inside files asserted to be correct.
 */
describe("detection quality against labelled fixtures", () => {
  const result = runDetectionEval();

  it("has fixtures to evaluate", () => {
    expect(listFixtures().length).toBeGreaterThanOrEqual(3);
    expect(result.totals.expected).toBeGreaterThanOrEqual(25);
  });

  it("finds every planted defect (no false negatives)", () => {
    const missed = result.fixtures.flatMap((fixture) =>
      fixture.falseNegatives.map((entry) => `${fixture.name}: ${entry.id} in ${entry.file}`));
    expect(missed).toEqual([]);
  });

  it("reports nothing inside files labelled correct (no false positives)", () => {
    const wrong = result.fixtures.flatMap((fixture) =>
      fixture.falsePositives.map((entry) => `${fixture.name}: ${entry.id} in ${entry.file}:${entry.line}`));
    expect(wrong).toEqual([]);
  });

  it("detects the stack each fixture declares", () => {
    const mismatches = result.fixtures.flatMap((fixture) =>
      fixture.stackMismatches.map((entry) => `${fixture.name}: ${entry.field} expected ${entry.expected}, got ${entry.actual}`));
    expect(mismatches).toEqual([]);
  });

  it("never runs an ORM analyzer against the wrong ORM", () => {
    const wrongAnalyzers = result.fixtures.flatMap((fixture) =>
      fixture.forbiddenAnalyzersRun.map((id) => `${fixture.name}: ${id}`));
    expect(wrongAnalyzers).toEqual([]);
  });

  it("runs every analyzer without error", () => {
    const errors = result.fixtures.flatMap((fixture) => fixture.analyzerErrors);
    expect(errors).toEqual([]);
  });

  it("produces zero findings on the adversarial secure baseline", () => {
    // The strongest precision signal in the corpus: a correct service that uses
    // password/passwordHash/secret/token/refreshToken/query throughout.
    const baseline = listFixtures().find((dir) => dir.endsWith("secure-baseline"));
    const evaluated = evaluateFixture(baseline);
    expect(evaluated.totalFindings).toBe(0);
  });
});
