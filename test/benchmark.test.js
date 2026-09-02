import { describe, expect, it } from "vitest";

import { benchmarkContext, formatBenchmark } from "../plugins/ctx/lib/benchmark.js";

describe("benchmark", () => {
  it("compares baseline middle placement with BackendGuard scheduling", () => {
    const result = benchmarkContext({
      task: "Recheck authen flow",
      markdown: `## Source: /repo/AGENTS.md
- Prefer CSS modules for styling.
- Use compact UI spacing.
- Always use auth guards for login endpoints.
- Never commit console.log.
- Prefer dark mode colors.
`
    });

    expect(result.rulesParsed).toBe(5);
    expect(result.actionableRules).toBe(5);
    expect(result.relevantRules).toBeGreaterThan(0);
    expect(result.baseline.relevantRulesInMiddle).toBeGreaterThan(0);
    expect(result.contextOS.highRules).toBeGreaterThan(0);
    expect(formatBenchmark(result)).toContain("Baseline middle-risk");
    expect(formatBenchmark(result)).toContain("Top Rules");
  });
});
