import { describe, expect, it } from "vitest";

import { runScaleBenchmark } from "../evaluation/performance/run-scale-benchmark.js";

/**
 * A usability floor, not a performance claim: analysis must stay roughly linear
 * in file count and finish a 500-module service in seconds, not minutes.
 * The ceilings are deliberately loose so a slow CI machine does not fail the
 * build — they catch an order-of-magnitude regression, which is what matters.
 */
describe("analysis at scale", () => {
  const result = runScaleBenchmark({ sizes: [100, 500] });

  it("analyzes every file in a 2000-file project", () => {
    const large = result.rows.at(-1);
    expect(large.files).toBe(2000);
    expect(large.filesAnalyzed).toBe(2000);
    expect(large.findings).toBeGreaterThan(0);
  });

  it("stays under a usable wall-clock ceiling", () => {
    for (const row of result.rows) {
      expect(row.analysisMs, `${row.files} files took ${row.analysisMs}ms`).toBeLessThan(30_000);
    }
  });

  it("scales roughly linearly rather than quadratically", () => {
    const [small, large] = result.rows;
    const fileRatio = large.files / small.files;
    const timeRatio = large.analysisMs / Math.max(small.analysisMs, 1);
    // 5x the files must not cost more than 15x the time.
    expect(timeRatio).toBeLessThan(fileRatio * 3);
  });
}, 300_000);
