import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inspectBackendGuardReady } from "../plugins/ctx/lib/certification.js";
import { generateProjectContext } from "../plugins/ctx/lib/project-context-generator.js";

describe("project context generator", () => {
  it("creates starter skills and workflow without overwriting existing files", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "AGENTS.md"), [
      "- Always inspect project config before changing deployment code.",
      "- Always check tests before editing implementation.",
      "- For deployment issues, verify the actual platform from repo files first."
    ].join("\n"));
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "expo-test",
      dependencies: {
        expo: "^53.0.0",
        "react-native": "^0.79.0"
      },
      devDependencies: {
        jest: "^30.0.0"
      }
    }, null, 2));
    fs.writeFileSync(path.join(repo, "eas.json"), "{}\n");

    const before = inspectBackendGuardReady({ cwd: repo, home: path.join(repo, "home") });
    expect(before.tier).toBe("Not Ready");

    const result = generateProjectContext({ cwd: repo });

    expect(result.skills).toContain("mobile-deployment");
    expect(result.created.some((filePath) => filePath.endsWith(".agents/workflows/primary.md"))).toBe(true);
    const skillMarkdown = fs.readFileSync(path.join(repo, ".agents", "skills", "mobile-deployment", "SKILL.md"), "utf8");
    expect(skillMarkdown).toMatch(/^---\nname: mobile-deployment\ndescription: /);
    expect(fs.existsSync(path.join(repo, ".agents", "skills", "mobile-deployment", "skill.yaml"))).toBe(true);

    const after = inspectBackendGuardReady({ cwd: repo, home: path.join(repo, "home") });
    expect(after.skills.score).toBeGreaterThanOrEqual(50);
    expect(after.workflows.score).toBeGreaterThanOrEqual(50);

    const second = generateProjectContext({ cwd: repo });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-project-context-"));
  fs.mkdirSync(path.join(repo, ".git"));
  return repo;
}
