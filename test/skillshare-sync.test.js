import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectAntigravityLegacySkills,
  dedupeAgentVisibleSkills,
  detectExistingSkills,
  detectOS,
  discoverSkillRoots,
  parseSyncSkillsArgs,
  repairSkillSymlinks,
  skillshareSourceDir,
  syncSkills
} from "../plugins/ctx/lib/skillshare-sync.js";

describe("skillshare sync", () => {
  it("parses sync --skills flags", () => {
    expect(parseSyncSkillsArgs(["--skills"])).toMatchObject({
      skills: true,
      agents: ["codex", "claude", "antigravity", "copilot"],
      dryRun: false,
      noCollect: false
    });
    expect(parseSyncSkillsArgs(["--skills", "--agents", "codex,claude", "--dry-run", "--no-collect"]).agents).toEqual(["codex", "claude"]);
    expect(parseSyncSkillsArgs(["--skills", "--agents", "codex,claude,agy"]).agents).toEqual(["codex", "claude", "antigravity"]);
    expect(parseSyncSkillsArgs(["--skills", "--dry-run"]).dryRun).toBe(true);
    expect(parseSyncSkillsArgs(["--skills", "--no-collect"]).noCollect).toBe(true);
    expect(parseSyncSkillsArgs(["--skills", "--no-embeddings"]).noEmbeddings).toBe(true);
    expect(parseSyncSkillsArgs(["--skills", "--verbose"]).verbose).toBe(true);
  });

  it("detects host OS names", () => {
    expect(detectOS("darwin")).toBe("mac");
    expect(detectOS("win32")).toBe("windows");
    expect(detectOS("linux")).toBe("linux");
    expect(detectOS("freebsd")).toBe("linux");
  });

  it("detects existing skills across global and project roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-detect-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    writeSkill(path.join(home, ".codex", "skills", "reviewer"), "reviewer");
    writeSkill(path.join(cwd, ".gemini", "antigravity", "skills", "payments"), "payments");

    const existing = detectExistingSkills({ cwd, home });

    expect(existing).toEqual(expect.arrayContaining([
      { path: path.join(home, ".codex", "skills"), count: 1 },
      { path: path.join(cwd, ".gemini", "antigravity", "skills"), count: 1 }
    ]));
  });

  it("discovers nested skill roots under gemini, codex, and claude", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-discover-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    writeSkill(path.join(home, ".gemini", "antigravity", "skills", "payments"), "payments");
    writeSkill(path.join(home, ".gemini", "vendor", "nested", "skills", "seo"), "seo");
    writeSkill(path.join(home, ".codex", "skills", "reviewer"), "reviewer");
    writeSkill(path.join(cwd, ".claude", "team", "skills", "planner"), "planner");

    expect(discoverSkillRoots({ cwd, home })).toEqual(expect.arrayContaining([
      path.join(home, ".gemini", "antigravity", "skills"),
      path.join(home, ".gemini", "vendor", "nested", "skills"),
      path.join(home, ".codex", "skills"),
      path.join(cwd, ".claude", "team", "skills")
    ]));
  });

  it("initializes, collects, syncs, and rebuilds embeddings with a fake runner", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-flow-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    writeSkill(path.join(home, ".claude", "skills", "planning"), "planning");
    const calls = [];
    const logs = [];

    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "skillshare" && args[0] === "--version") return { stdout: "skillshare 0.19.24\n" };
      if (command === "skillshare" && args[0] === "init") {
        fs.mkdirSync(skillshareSourceDir({ home }), { recursive: true });
      }
      if (command === "skillshare" && args[0] === "collect") {
        writeSkill(path.join(skillshareSourceDir({ home }), "planning"), "planning");
      }
      return { stdout: "" };
    };

    const result = await syncSkills({
      cwd,
      home,
      args: ["--skills", "--agents", "codex,claude"],
      run,
      logger: (line) => logs.push(line),
      rebuildSkillEmbeddings: async ({ sourceDir }) => ({ count: countSkillFiles(sourceDir), cachePath: "/tmp/embeddings.db" })
    });

    expect(calls.map(([command, args]) => `${command} ${args.join(" ")}`)).toEqual([
      "skillshare --version",
      "skillshare init --no-copy --no-git --no-skill --all-targets",
      "skillshare backup",
      "skillshare collect --all",
      "skillshare sync --quiet --agents codex,claude"
    ]);
    expect(result.syncedCount).toBe(1);
    expect(result.embeddings.count).toBe(1);
    expect(logs.join("\n")).toContain("Rebuilding skill embeddings...         started (1 skills)");
    expect(logs.join("\n")).toContain("Rebuilding skill embeddings...         1 skills indexed");
  });

  it("copies discovered agent skills into the skillshare source before sync", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-agy-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    fs.mkdirSync(skillshareSourceDir({ home }), { recursive: true });
    writeSkill(path.join(home, ".gemini", "antigravity", "skills", "payment-integration"), "payment-integration");
    writeSkill(path.join(home, ".gemini", "skills", "visible-to-skillshare"), "visible-to-skillshare");
    writeSkill(path.join(home, ".codex", "extra", "skills", "codex-extra"), "codex-extra");

    const result = collectAntigravityLegacySkills({ cwd, home });

    expect(result.copied).toContain("payment-integration");
    expect(result.copied).toContain("codex-extra");
    expect(result.copied).toContain("visible-to-skillshare");
    expect(fs.existsSync(path.join(skillshareSourceDir({ home }), "payment-integration", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillshareSourceDir({ home }), "codex-extra", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillshareSourceDir({ home }), "visible-to-skillshare", "SKILL.md"))).toBe(true);
  });

  it("uses custom skillshare source path from config.yaml", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-source-"));
    const home = path.join(tmp, "home");
    const customSource = path.join(tmp, "agent-skills");
    fs.mkdirSync(path.join(home, ".config", "skillshare"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "skillshare", "config.yaml"), [
      "sources:",
      `  skills: ${customSource}`
    ].join("\n"));
    writeSkill(path.join(home, ".gemini", "antigravity", "skills", "payments"), "payments");

    collectAntigravityLegacySkills({ cwd: tmp, home });

    expect(skillshareSourceDir({ home })).toBe(customSource);
    expect(fs.existsSync(path.join(customSource, "payments", "SKILL.md"))).toBe(true);
  });

  it("bridges Antigravity legacy skills during sync even when skillshare is already initialized", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-flow-agy-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    fs.mkdirSync(skillshareSourceDir({ home }), { recursive: true });
    writeSkill(path.join(home, ".gemini", "antigravity", "skills", "payment-integration"), "payment-integration");
    const calls = [];

    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "skillshare" && args[0] === "--version") return { stdout: "skillshare 0.19.24\n" };
      return { stdout: "" };
    };

    const result = await syncSkills({
      cwd,
      home,
      args: ["--skills", "--agents", "codex,claude"],
      run,
      logger: () => {},
      rebuildSkillEmbeddings: async ({ sourceDir }) => ({ count: countSkillFiles(sourceDir), cachePath: "/tmp/embeddings.db" })
    });

    expect(calls.map(([command, args]) => `${command} ${args.join(" ")}`)).toEqual([
      "skillshare --version",
      "skillshare sync --quiet --agents codex,claude"
    ]);
    expect(result.syncedCount).toBe(1);
    expect(fs.existsSync(path.join(skillshareSourceDir({ home }), "payment-integration", "SKILL.md"))).toBe(true);
  });

  it("materializes skill symlinks before installer and sync flows", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-links-"));
    const home = path.join(tmp, "home");
    const realSkill = path.join(tmp, "real", "linked-skill");
    const linkPath = path.join(home, ".agents", "skills", "linked-skill");
    writeSkill(realSkill, "linked-skill");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(realSkill, linkPath, "dir");

    const result = repairSkillSymlinks({
      cwd: tmp,
      home,
      roots: [path.join(home, ".agents", "skills")]
    });

    expect(result.repaired).toEqual([linkPath]);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(linkPath, "SKILL.md"))).toBe(true);
  });

  it("dedupes skills visible to Codex and Antigravity while preserving unique agent skills", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-dedupe-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    const shared = path.join(home, ".agents", "skills", "mcp-builder");
    const codexDuplicate = path.join(home, ".codex", "skills", "mcp-builder");
    const agyDuplicate = path.join(home, ".gemini", "antigravity", "skills", "mcp-builder");
    const codexOnly = path.join(home, ".codex", "skills", "codex-only");

    writeSkill(shared, "mcp-builder");
    writeSkill(codexDuplicate, "mcp-builder");
    writeSkill(agyDuplicate, "mcp-builder");
    writeSkill(codexOnly, "codex-only");

    const result = dedupeAgentVisibleSkills({
      cwd,
      home,
      agents: ["codex", "agy"]
    });

    expect(result.removed).toEqual(expect.arrayContaining([codexDuplicate, agyDuplicate]));
    expect(fs.existsSync(path.join(shared, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codexDuplicate, "SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(agyDuplicate, "SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(codexOnly, "SKILL.md"))).toBe(true);
  });

  it("previews agent-visible skill dedupe in dry-run mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-dedupe-dry-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    const shared = path.join(home, ".agents", "skills", "mcp-builder");
    const codexDuplicate = path.join(home, ".codex", "skills", "mcp-builder");
    writeSkill(shared, "mcp-builder");
    writeSkill(codexDuplicate, "mcp-builder");

    const result = dedupeAgentVisibleSkills({
      cwd,
      home,
      agents: ["codex"],
      dryRun: true
    });

    expect(result.removed).toEqual([codexDuplicate]);
    expect(fs.existsSync(path.join(codexDuplicate, "SKILL.md"))).toBe(true);
  });

  it("does not collect or rebuild embeddings in dry-run mode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-dry-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    const calls = [];

    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "skillshare" && args[0] === "--version") return { stdout: "skillshare 0.19.24\n" };
      return { stdout: "" };
    };

    const result = await syncSkills({
      cwd,
      home,
      args: ["--skills", "--dry-run", "--no-collect"],
      run,
      logger: () => {},
      rebuildSkillEmbeddings: async () => {
        throw new Error("should not rebuild in dry-run");
      }
    });

    expect(calls.map(([, args]) => args.join(" "))).toEqual([
      "--version",
      "init --no-copy --no-git --no-skill --all-targets",
      "sync --dry-run --quiet --agents codex,claude,antigravity,copilot"
    ]);
    expect(result.embeddings.skipped).toBe(true);
  });

  it("can skip embedding rebuild after skill sync", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skillshare-no-embeddings-"));
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    fs.mkdirSync(skillshareSourceDir({ home }), { recursive: true });
    writeSkill(path.join(skillshareSourceDir({ home }), "planning"), "planning");
    const calls = [];
    const logs = [];

    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "skillshare" && args[0] === "--version") return { stdout: "skillshare 0.19.24\n" };
      return { stdout: "" };
    };

    const result = await syncSkills({
      cwd,
      home,
      args: ["--skills", "--no-embeddings"],
      run,
      logger: (line) => logs.push(line),
      rebuildSkillEmbeddings: async () => {
        throw new Error("should not rebuild with --no-embeddings");
      }
    });

    expect(calls.map(([, args]) => args.join(" "))).toContain("sync --quiet --agents codex,claude,antigravity,copilot");
    expect(result.embeddings.skipped).toBe(true);
    expect(logs.join("\n")).toContain("skipped by --no-embeddings");
  });
});

function writeSkill(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Use for ${name} tasks.`,
    "---"
  ].join("\n"));
}

function countSkillFiles(root) {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .length;
}
