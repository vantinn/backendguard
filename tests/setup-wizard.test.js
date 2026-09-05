import { describe, expect, it } from "vitest";

import {
  normalizeSetupAgent,
  parseAgentList,
  parseSetupArgs,
  setupSummaryLines
} from "../runtime/setup-wizard.js";

describe("setup wizard", () => {
  it("parses setup defaults", () => {
    expect(parseSetupArgs([])).toEqual({
      agents: [],
      agentsProvided: false,
      yes: false,
      quiet: false,
      syncRules: true,
      syncSkills: true,
      generateProjectContext: false
    });
  });

  it("uses codex as the non-interactive setup target", () => {
    expect(parseSetupArgs(["--yes"])).toMatchObject({
      agents: ["codex"],
      agentsProvided: false,
      yes: true
    });
  });

  it("parses setup flags", () => {
    expect(parseSetupArgs([
      "--yes",
      "--quiet",
      "--no-rules",
      "--no-skills",
      "--generate-project-context",
      "--agents",
      "codex,antigravity,agy"
    ])).toEqual({
      agents: ["codex", "agy"],
      agentsProvided: true,
      yes: true,
      quiet: true,
      syncRules: false,
      syncSkills: false,
      generateProjectContext: true
    });
  });

  it("normalizes agent aliases", () => {
    expect(normalizeSetupAgent("Antigravity")).toBe("agy");
    expect(parseAgentList("codex, claude, antigravity")).toEqual(["codex", "claude", "agy"]);
  });

  it("formats setup summary lines with always-on injection", () => {
    expect(setupSummaryLines({
      cwd: "/repo",
      agents: ["codex"],
      syncRules: false,
      syncSkills: true,
      generateProjectContext: true,
      promptSections: "files, skills",
      promptLimits: "files: 5, skills: 5, workflows: 5"
    })).toEqual([
      "Installation directory: /repo",
      "Agents: codex",
      "Prompt context injection: always enabled",
      "Ruler rule/MCP sync: skipped",
      "skillshare skill sync: enabled",
      "Project context generation: enabled",
      "Prompt sections shown: files, skills",
      "Prompt suggest limits: files: 5, skills: 5, workflows: 5"
    ]);
  });
});
