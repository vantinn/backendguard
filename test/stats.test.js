import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { appendJsonLine, writeJsonFile } from "../plugins/ctx/lib/fs-utils.js";
import { formatStats, loadStats } from "../plugins/ctx/lib/stats.js";

describe("stats", () => {
  it("summarizes prompt and report history", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stats-"));
    appendJsonLine(path.join(tmp, "debug.log"), { event: "UserPromptSubmit" });
    appendJsonLine(path.join(tmp, "debug.log"), { event: "Stop" });
    appendJsonLine(path.join(tmp, "prompt-history.jsonl"), {
      prompt: "Recheck authen flow",
      elapsedMs: 12,
      injected: true,
      relevantFiles: [{ path: "src/auth.ts" }],
      scheduled: { highRules: [{ content: "Use zod" }], midRules: [] }
    });
    appendJsonLine(path.join(tmp, "prompt-history.jsonl"), {
      prompt: "fix billing",
      elapsedMs: 18,
      injected: false,
      relevantFiles: [],
      scheduled: { highRules: [], midRules: [] }
    });
    appendJsonLine(path.join(tmp, "report-history.jsonl"), {
      efficiencyScore: 100,
      followed: [{ rule: { content: "Use zod" } }],
      ignored: [],
      unknown: [],
      unmeasurable: [{ rule: { content: "Needs runtime telemetry" } }],
      changedFiles: ["src/auth.ts"]
    });
    writeJsonFile(path.join(tmp, "last-report.json"), {
      efficiencyScore: 50,
      followed: [],
      ignored: [],
      unknown: [],
      changedFiles: ["ignored-when-history-exists.ts"]
    });

    const stats = loadStats(tmp);
    const output = formatStats(stats);

    expect(stats.promptCount).toBe(2);
    expect(stats.reportCount).toBe(1);
    expect(stats.injectedCount).toBe(1);
    expect(stats.averagePromptMs).toBe(15);
    expect(stats.averageEfficiency).toBe(100);
    expect(stats.unmeasurable).toBe(1);
    expect(output).toContain("Prompts analyzed");
    expect(output).toContain("Rule Outcomes");
    expect(output).toContain("Hook Events");
    expect(output).toContain("1 injected, 1 quiet");
    expect(output).toContain("src/auth.ts");
    expect(output).toContain("unmeasurable");
  });

  it("explains unknown efficiency when no rule evidence is measurable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stats-unknown-"));
    writeJsonFile(path.join(tmp, "last-report.json"), {
      efficiencyScore: null,
      followed: [],
      ignored: [],
      unknown: [{ rule: { content: "Use code-review-graph before reading files." } }],
      unmeasurable: [{ rule: { content: "Needs runtime telemetry." } }],
      unknownRuleCount: 1,
      unmeasurableRuleCount: 1,
      measuredRuleCount: 0,
      changedFiles: []
    });

    const output = formatStats(loadStats(tmp));

    expect(output).toContain("unknown (no measurable followed/ignored rule evidence yet)");
    expect(output).toContain("Measured rules");
    expect(output).toContain("Unknown rules");
    expect(output).toContain("Unmeasurable rules");
  });
});
