import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseVitestSummary, runTestSuite, stripAnsi } from "../evaluation/release-readiness/run-evaluation.js";
import { makeFixture } from "./helpers/fixture.js";

/**
 * The release evaluator decides whether this project may be published, so a
 * silent failure in the *measurement* is as damaging as one in the product.
 *
 * A CI run once reported "0 passed, 0 failed" and blocked the release while the
 * same workflow's `npm test` step had just passed 398 tests: the evaluator was
 * writing vitest's JSON report to `/dev/stdout`, which worked on macOS and
 * produced nothing on a Linux runner, and its text fallback did not strip the
 * ANSI colours vitest emits. These tests cover both causes.
 */

const evaluatorSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "evaluation", "release-readiness", "run-evaluation.js"),
  "utf8"
);

describe("release evaluator: test-suite measurement", () => {
  it("parses a colourised vitest summary", () => {
    const esc = "";
    const coloured = [
      ` ${esc}[2m Test Files ${esc}[22m ${esc}[1m${esc}[32m51 passed${esc}[39m${esc}[22m${esc}[90m (51)${esc}[39m`,
      ` ${esc}[2m      Tests ${esc}[22m ${esc}[1m${esc}[32m398 passed${esc}[39m${esc}[22m${esc}[90m (398)${esc}[39m`
    ].join("\n");
    expect(parseVitestSummary(coloured)).toEqual({ passed: 398, failed: 0 });
  });

  it("parses a summary that reports failures", () => {
    expect(parseVitestSummary("Tests  1 failed | 397 passed (398)")).toEqual({ passed: 397, failed: 1 });
  });

  it("returns null rather than guessing when there is no summary", () => {
    expect(parseVitestSummary("something else entirely")).toBeNull();
    expect(parseVitestSummary("")).toBeNull();
  });

  it("strips ANSI escape sequences", () => {
    const esc = "";
    expect(stripAnsi(`${esc}[1m${esc}[32mok${esc}[39m${esc}[22m`)).toBe("ok");
  });

  it("never reports a silent 0/0 — an unrunnable suite carries the reason", () => {
    const result = runTestSuite(makeFixture("no-vitest"));
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/vitest/i);
  });

  it("does not route its report through a process stream", () => {
    // The property under test is that no `--outputFile` targets a process
    // stream. The comment in the source that explains why still names
    // `/dev/stdout`, so a bare substring check would assert the wrong thing.
    expect(evaluatorSource).not.toMatch(/outputFile=\/dev\//);
    expect(evaluatorSource).toMatch(/outputFile=\$\{reportPath\}/);
  });

  it("runs vitest directly instead of through npx", () => {
    // `npx` can attempt a network install when resolution fails, which is not
    // acceptable inside a release gate.
    expect(evaluatorSource).not.toMatch(/runCommand\([^)]*"npx"/);
  });
});
