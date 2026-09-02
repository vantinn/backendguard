import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { maybeAutoWarmWorkspace } from "../plugins/ctx/lib/auto-warm.js";

describe("auto warm", () => {
  it("starts detached workspace warmup for empty context candidates", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-auto-warm-"));
    const calls = [];
    const result = maybeAutoWarmWorkspace({
      cwd: tmp,
      prompt: "find billing adapter",
      dataDir: tmp,
      reason: "no-context-candidates",
      now: Date.parse("2026-05-31T10:00:00.000Z"),
      spawnProcess: (...args) => {
        calls.push(args);
        return { pid: 123, on() {}, unref() {} };
      }
    });

    expect(result.status).toBe("started");
    expect(result.pid).toBe(123);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toContain("autowarm");
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "auto-warm.json"), "utf8")).reason).toBe("no-context-candidates");
  });

  it("does not override disabled output sections", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-auto-warm-disabled-"));
    const calls = [];
    const result = maybeAutoWarmWorkspace({
      cwd: tmp,
      prompt: "find billing adapter",
      dataDir: tmp,
      reason: "available-sections-disabled:rules,workflows",
      spawnProcess: (...args) => {
        calls.push(args);
        return { pid: 123, on() {}, unref() {} };
      }
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-actionable");
    expect(calls).toHaveLength(0);
  });

  it("uses cooldown to avoid spawning on every prompt", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-auto-warm-cooldown-"));
    fs.writeFileSync(path.join(tmp, "auto-warm.json"), JSON.stringify({
      startedAt: "2026-05-31T10:00:00.000Z"
    }));
    const result = maybeAutoWarmWorkspace({
      cwd: tmp,
      prompt: "find billing adapter",
      dataDir: tmp,
      reason: "no-context-candidates",
      now: Date.parse("2026-05-31T10:05:00.000Z"),
      spawnProcess: () => {
        throw new Error("should not spawn during cooldown");
      }
    });

    expect(result.status).toBe("cooldown");
  });
});
