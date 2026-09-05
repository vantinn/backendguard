import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { syncPackageRoot } from "../runtime/package-install.js";

describe("package install", () => {
  it("syncs a package root into the active marketplace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-package-sync-"));
    const rootDir = path.join(tmp, "source");
    const targetRoot = path.join(tmp, "marketplace");
    fs.mkdirSync(path.join(rootDir, "plugins", "backendguard"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "evaluation", "skill-routing"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "package.json"), "{}");
    fs.writeFileSync(path.join(rootDir, "plugins", "backendguard", "marker.txt"), "fresh");
    fs.writeFileSync(path.join(rootDir, "evaluation", "skill-routing", "run-eval.js"), "export {};");

    expect(syncPackageRoot({ rootDir, targetRoot })).toEqual({ targetRoot, synced: true });
    expect(fs.readFileSync(path.join(targetRoot, "plugins", "backendguard", "marker.txt"), "utf8")).toBe("fresh");
    expect(fs.existsSync(path.join(targetRoot, "evaluation", "skill-routing", "run-eval.js"))).toBe(true);
  });

  it("does not remove files when the package root is already active", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-package-active-"));
    fs.writeFileSync(path.join(rootDir, "package.json"), "{}");

    expect(syncPackageRoot({ rootDir, targetRoot: rootDir })).toEqual({
      targetRoot: rootDir,
      synced: false
    });
    expect(fs.existsSync(path.join(rootDir, "package.json"))).toBe(true);
  });
});
