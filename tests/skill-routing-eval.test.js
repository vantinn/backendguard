import { describe, expect, it } from "vitest";

import { formatSkillRoutingBenchmark, parseEvalYaml, runSkillRoutingEval } from "../evaluation/skill-routing/run-eval.js";

describe("skill routing eval", () => {
  it("parses skill routing cases yaml", () => {
    const parsed = parseEvalYaml([
      "skills:",
      "  - id: eas",
      "    description: Expo EAS deployment.",
      "    positive_triggers:",
      "      prompts: [deployed, eas]",
      "      files: [eas.json]",
      "cases:",
      "  - prompt: fix deployed",
      "    fixture: expo-eas",
      "    expected: [eas]",
      "    allowed: [github-actions-ci-cd]",
      "    rejected: [vercel-deployment]"
    ].join("\n"));

    expect(parsed.skills[0]).toMatchObject({
      id: "eas",
      positive_triggers: {
        prompts: ["deployed", "eas"],
        files: ["eas.json"]
      }
    });
    expect(parsed.cases[0]).toMatchObject({
      prompt: "fix deployed",
      fixture: "expo-eas",
      expected: ["eas"],
      allowed: ["github-actions-ci-cd"],
      forbidden: ["vercel-deployment"]
    });
  });

  it("runs skill routing benchmark metrics", async () => {
    const result = await runSkillRoutingEval();
    const output = formatSkillRoutingBenchmark(result);

    expect(result.caseCount).toBeGreaterThanOrEqual(50);
    expect(result.top3Recall).toBeGreaterThanOrEqual(0.9);
    expect(result.falsePositiveRate).toBeLessThanOrEqual(0.08);
    expect(result.confidenceCalibration).toBeGreaterThanOrEqual(0.9);
    expect(result.negativeGateAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(output).toContain("Skill Routing Benchmark");
    expect(output).toContain("Top-3 Recall");
  }, 15000);
});
