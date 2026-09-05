import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { checkForUpdate, isUpdateCheckDisabled } from "../runtime/update-notifier.js";

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
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir, env: {} });
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
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir, env: {} });
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
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir, env: {} });
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
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: tmpDir, env: {} });
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
    const notify = checkForUpdate({ currentVersion: "0.5.39", dataDir: tmpDir, env: {} });
    await notify();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain("0.5.39 → 0.5.40");
    spy.mockRestore();
  });
});

describe("update check opt-out", () => {
  it("is disabled by the standard environment switches", () => {
    for (const env of [{ CI: "1" }, { NO_UPDATE_NOTIFIER: "1" }, { BACKENDGUARD_NO_UPDATE_CHECK: "1" }]) {
      expect(isUpdateCheckDisabled(env)).toBe(true);
    }
    expect(isUpdateCheckDisabled({})).toBe(false);
  });

  it("makes no network request when disabled", async () => {
    // checkForUpdate starts its request eagerly; when disabled it must return a
    // no-op notifier without touching the network or the cache file.
    const notify = checkForUpdate({ currentVersion: "1.0.0", dataDir: "/nonexistent", env: { CI: "1" } });
    await expect(notify()).resolves.toBeUndefined();
  });
});
