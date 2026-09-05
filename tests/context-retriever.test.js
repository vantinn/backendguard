import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scoreContext } from "../retrieval/context-retriever.js";
import { scanSkills } from "../agent-context/skill-discoverer.js";
import { scanWorkflows } from "../agent-context/workflow-discoverer.js";

describe("score context", () => {
  it("excludes system-user shell rules from scored context", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-data-"));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), [
      "- All shell commands MUST run as deploy_user, not root.",
      "- Do not prefix every command with sudo -u deploy_user.",
      "- Always use zod for validation."
    ].join("\n"));

    const result = await scoreContext({
      cwd: tmp,
      prompt: "fix zod validation",
      dataDir,
      skills: [],
      embeddingTimeoutMs: 20,
      fileEmbeddingTimeoutMs: 1
    });

    expect(result.scoredRules.map((rule) => rule.content)).toEqual([
      "Always use zod for validation."
    ]);
    expect(result.telemetry.rulesFiltered).toBeGreaterThanOrEqual(2);
  });

  it("suggests relevant skills from project skill catalog", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-skills-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-skills-data-"));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Prefer focused skills for specialized tasks.\n");
    const skillDir = path.join(tmp, ".codex", "skills", "payment-integration");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: payment-integration",
      "description: Use when creating payment checkout sessions and billing webhooks.",
      "---"
    ].join("\n"));

    const skills = scanSkills({
      cwd: tmp,
      roots: [path.join(tmp, ".codex", "skills")]
    });
    const seenSkillTimeouts = [];
    const result = await scoreContext({
      cwd: tmp,
      prompt: "create payment checkout webhook integration",
      dataDir,
      skills,
      embeddingTimeoutMs: 20,
      fileEmbeddingTimeoutMs: 1,
      skillEmbeddingTimeoutMs: 456,
      skillSearchOptions: {
        indexedSearcher: async ({ timeoutMs }) => {
          seenSkillTimeouts.push(timeoutMs);
          return {
            status: "enabled",
            items: [{ id: "payment integration", text: "payment-integration", embeddingScore: 0.92 }]
          };
        }
      }
    });

    expect(result.suggestedSkills[0].name).toBe("payment-integration");
    expect(seenSkillTimeouts).toEqual([456]);
    expect(result.telemetry.skillsScanned).toBeGreaterThanOrEqual(1);
    expect(result.telemetry.skillsSuggested).toBeGreaterThanOrEqual(1);
  });

  it("suggests relevant workflows from project workflow catalog", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-workflows-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-workflows-data-"));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Use workflow hints when they match the task.\n");
    const workflowDir = path.join(tmp, ".claude", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(path.join(workflowDir, "primary-workflow.md"), [
      "# Primary Workflow",
      "",
      "Feature development workflow.",
      "",
      "#### Code Implementation",
      "Implementation work delegates to `planner`, `tester`, and `code-reviewer`.",
      "",
      "#### Debugging",
      "Fix failing tests and CI issues."
    ].join("\n"));

    const result = await scoreContext({
      cwd: tmp,
      prompt: "implement auth flow with tests",
      dataDir,
      skills: [],
      workflows: scanWorkflows({
        cwd: tmp,
        roots: [workflowDir]
      }),
      embeddingTimeoutMs: 20,
      fileEmbeddingTimeoutMs: 1
    });

    expect(result.suggestedWorkflows[0].name).toBe("primary-workflow");
    expect(result.telemetry.workflowsScanned).toBeGreaterThanOrEqual(1);
    expect(result.telemetry.workflowsSuggested).toBeGreaterThanOrEqual(1);
  });

  it("returns partial context when a section times out", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-partial-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-score-partial-data-"));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Always keep prompt hooks responsive.\n");
    const skillDir = path.join(tmp, ".codex", "skills", "slow-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: slow-skill",
      "description: Use for slow skill scoring.",
      "---"
    ].join("\n"));

    const result = await scoreContext({
      cwd: tmp,
      prompt: "slow skill scoring",
      dataDir,
      skills: scanSkills({ cwd: tmp, roots: [path.join(tmp, ".codex", "skills")] }),
      workflows: [],
      embeddingTimeoutMs: 1,
      fileEmbeddingTimeoutMs: 1,
      sectionTimeoutMs: 10,
      skillSearchOptions: {
        indexedSearcher: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: "enabled", items: [] };
        }
      }
    });

    expect(result.scoredRules).toHaveLength(1);
    expect(result.suggestedSkills).toEqual([]);
    expect(result.telemetry.partial).toBe(true);
    expect(result.telemetry.warnings).toContain("skills_timeout");
  });
});
