import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createScoreService, scoreCacheKey } from "../compliance/scoring-service.js";

describe("scoring service", () => {
  it("coalesces duplicate in-flight score requests and caches the result", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-service-"));
    let calls = 0;
    const service = createScoreService({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-service-data-")),
      cacheTtlMs: 1_000,
      gitHeadReader: () => "head",
      scoreContext: async ({ prompt }) => {
        calls += 1;
        await sleep(30);
        return {
          prompt,
          scoredRules: [],
          suggestedFiles: [],
          suggestedSkills: [],
          suggestedWorkflows: [],
          telemetry: { elapsedMs: 30 }
        };
      }
    });

    const [first, second, third] = await Promise.all([
      service.score({ cwd, prompt: "fix deployed" }),
      service.score({ cwd, prompt: "fix deployed" }),
      service.score({ cwd, prompt: "fix deployed" })
    ]);

    expect(calls).toBe(1);
    expect(first.telemetry.cache_hit).toBe(false);
    expect(second.telemetry.coalesced).toBe(true);
    expect(third.telemetry.coalesced).toBe(true);

    const cached = await service.score({ cwd, prompt: "fix deployed" });
    expect(calls).toBe(1);
    expect(cached.telemetry.cache_hit).toBe(true);
  });

  it("limits concurrent scoring jobs", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-service-queue-"));
    let active = 0;
    let maxActive = 0;
    const service = createScoreService({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-service-queue-data-")),
      concurrency: 1,
      cacheTtlMs: 1_000,
      gitHeadReader: () => "head",
      scoreContext: async ({ prompt }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
        return {
          prompt,
          scoredRules: [],
          suggestedFiles: [],
          suggestedSkills: [],
          suggestedWorkflows: [],
          telemetry: {}
        };
      }
    });

    const [first, second] = await Promise.all([
      service.score({ cwd, prompt: "prompt one" }),
      service.score({ cwd, prompt: "prompt two" })
    ]);

    expect(maxActive).toBe(1);
    expect(first.telemetry.queue_wait_ms).toBeGreaterThanOrEqual(0);
    expect(second.telemetry.queue_wait_ms).toBeGreaterThan(0);
  });

  it("includes git head and scoring options in cache keys", () => {
    const keyA = scoreCacheKey({ cwd: "/repo", prompt: "fix", maxFiles: 5 }, { gitHeadReader: () => "a" });
    const keyB = scoreCacheKey({ cwd: "/repo", prompt: "fix", maxFiles: 5 }, { gitHeadReader: () => "b" });
    const keyC = scoreCacheKey({ cwd: "/repo", prompt: "fix", maxFiles: 6 }, { gitHeadReader: () => "a" });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
