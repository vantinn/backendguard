import { describe, expect, it } from "vitest";

import {
  formatHallucinationLeaderboard,
  runHallucinationLeaderboard
} from "../eval/hallucination/run-leaderboard.js";

describe("hallucination leaderboard", () => {
  it("compares raw prompt guesses against BackendGuard routing", async () => {
    const result = await runHallucinationLeaderboard();
    const output = formatHallucinationLeaderboard(result);
    const raw = result.systems.find((system) => system.name === "Raw heuristic baseline");
    const backendguard = result.systems.find((system) => system.name === "BackendGuard evidence benchmark");

    expect(result.caseCount).toBe(20);
    expect(result.repoCount).toBeGreaterThanOrEqual(10);
    expect(backendguard.correctRate).toBeGreaterThan(raw.correctRate);
    expect(output).toContain("Hallucination Leaderboard");
    expect(output).toContain("BackendGuard evidence benchmark");
  }, 15000);
});
