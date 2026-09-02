import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { checkForUpdate } from "../plugins/ctx/lib/update-notifier.js";

describe("update-notifier", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-update-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints nothing when version is current", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.0.0" })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir });
    await notify();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints update box when new version is available in cache", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "2.0.0" })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir });
    await notify();
    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0];
    expect(output).toContain("Update available: 1.0.0 → 2.0.0");
    expect(output).toContain("npm install -g @vantin/backendguard");
    expect(output).toContain("backendguard install --agents codex");
    expect(output).toContain("╭");
    expect(output).toContain("╰");
    spy.mockRestore();
  });

  it("prints nothing when installed version is newer than cached", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.5.0" })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir });
    await notify();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("skips network and prints nothing when cache is fresh but corrupt", async () => {
    // Fresh timestamp but missing latestVersion → no update to show, no network needed
    fs.writeFileSync(
      path.join(tmpDir, ".update-check.json"),
      JSON.stringify({ checkedAt: Date.now() })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir });
    await notify();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles patch version comparison correctly", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: "0.5.40" })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = checkForUpdate({ currentVersion: "0.5.39", dataDir: tmpDir });
    await notify();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain("0.5.39 → 0.5.40");
    spy.mockRestore();
  });
});
