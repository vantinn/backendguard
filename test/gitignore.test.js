import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeInnerGitignore, ensureRootGitignore } from "../plugins/ctx/lib/gitignore.js";

describe("gitignore", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-gitignore-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeInnerGitignore", () => {
    it("creates .gitignore with node_modules, bin, lib, mcp", () => {
      const dir = path.join(tmpDir, "backendguard");
      writeInnerGitignore(dir);

      const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).toContain("node_modules/");
      expect(content).toContain("bin/");
      expect(content).toContain("lib/");
      expect(content).toContain("mcp/");
    });

    it("creates the directory if it does not exist", () => {
      const dir = path.join(tmpDir, "deep", "nested", "dir");
      writeInnerGitignore(dir);
      expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    });

    it("overwrites existing .gitignore", () => {
      const dir = path.join(tmpDir, "backendguard");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".gitignore"), "old-content\n");
      writeInnerGitignore(dir);

      const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
      expect(content).not.toContain("old-content");
      expect(content).toContain("node_modules/");
    });
  });

  describe("ensureRootGitignore", () => {
    it("creates .gitignore if it does not exist", () => {
      ensureRootGitignore(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
      expect(content).toContain(".codex/marketplaces/backendguard/");
      expect(content).toContain(".claude/settings.json");
      expect(content).toContain(".gemini/");
    });

    it("appends missing entries to existing .gitignore", () => {
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");
      ensureRootGitignore(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
      expect(content).toContain("node_modules/");
      expect(content).toContain(".codex/marketplaces/backendguard/");
      expect(content).toContain(".claude/settings.json");
      expect(content).toContain(".gemini/");
    });

    it("does not duplicate entries on repeated calls", () => {
      ensureRootGitignore(tmpDir);
      ensureRootGitignore(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
      const matches = content.match(/\.codex\/marketplaces\/backendguard\//g);
      expect(matches).toHaveLength(1);
    });

    it("skips entries that already exist", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".gitignore"),
        ".codex/marketplaces/backendguard/\n.claude/settings.json\n.gemini/\n"
      );
      ensureRootGitignore(tmpDir);

      const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
      // Should not add the block header if nothing is missing
      const headerCount = (content.match(/BackendGuard install/g) || []).length;
      expect(headerCount).toBe(0);
    });
  });
});
