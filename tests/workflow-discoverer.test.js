import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseWorkflowFile, scanWorkflows, suggestWorkflows, syncWorkflows } from "../agent-context/workflow-discoverer.js";

function writeWorkflow(root, name, content) {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${name}.md`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("workflow discoverer", () => {
  it("parses markdown workflow files without frontmatter", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-"));
    const workflowsRoot = path.join(tmp, ".claude", "workflows");
    const filePath = writeWorkflow(workflowsRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Use this workflow for feature delivery.",
      "",
      "#### 1. Code Implementation",
      "Delegate design work to `planner`.",
      "",
      "#### 2. Testing",
      "Use `tester` and `code-reviewer` before finishing.",
      "",
      "#### 3. Documentation",
      "Ask `docs-manager` when docs change."
    ].join("\n"));

    const workflow = parseWorkflowFile(filePath, { cwd: tmp, root: workflowsRoot });

    expect(workflow).toMatchObject({
      name: "primary-workflow",
      title: "Primary Workflow",
      scope: "project"
    });
    expect(workflow.description).toContain("Code Implementation");
    expect(workflow.chain).toEqual(expect.arrayContaining(["planner", "tester", "code-reviewer", "docs-manager"]));
    expect(workflow.relativePath).toBe(path.join(".claude", "workflows", "primary-workflow.md"));
  });

  it("scans project workflow directories and skips tiny stubs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-scan-"));
    const workflowsRoot = path.join(tmp, ".claude", "workflows");
    writeWorkflow(workflowsRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Use this workflow for feature delivery.",
      "",
      "#### Code Implementation",
      "Delegate to `planner` and `tester` for complex implementation tasks."
    ].join("\n"));
    fs.writeFileSync(path.join(workflowsRoot, "empty.md"), "# Empty\n");

    const workflows = scanWorkflows({ cwd: tmp, roots: [workflowsRoot] });

    expect(workflows.map((workflow) => workflow.name)).toEqual(["primary-workflow"]);
  });

  it("scans Antigravity workflow directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-agy-workflows-"));
    const workflowsRoot = path.join(tmp, ".gemini", "antigravity", "workflows");
    writeWorkflow(workflowsRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Feature implementation workflow for Antigravity.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n"));

    const workflows = scanWorkflows({ cwd: tmp, roots: [workflowsRoot] });

    expect(workflows.map((workflow) => workflow.name)).toContain("primary-workflow");
  });

  it("scans shared .agents workflow directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-shared-workflows-"));
    const workflowsRoot = path.join(tmp, ".agents", "workflows");
    writeWorkflow(workflowsRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Shared feature implementation workflow for every installed agent.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n"));

    const workflows = scanWorkflows({ cwd: tmp });

    expect(workflows.map((workflow) => workflow.name)).toContain("primary-workflow");
    expect(workflows[0].relativePath).toBe(path.join(".agents", "workflows", "primary-workflow.md"));
  });

  it("deduplicates workflows by name across agent roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-dedupe-"));
    const claudeRoot = path.join(tmp, ".claude", "workflows");
    const codexRoot = path.join(tmp, ".codex", "workflows");
    const content = [
      "# Primary Workflow",
      "",
      "Feature implementation workflow.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n");
    writeWorkflow(claudeRoot, "primary-workflow", content);
    writeWorkflow(codexRoot, "primary-workflow", content);

    const workflows = scanWorkflows({ cwd: tmp, roots: [claudeRoot, codexRoot] });

    expect(workflows.map((workflow) => workflow.name)).toEqual(["primary-workflow"]);
    expect(workflows[0].root).toBe(claudeRoot);
  });

  it("syncs unique workflows to global agent roots", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-sync-"));
    const home = path.join(tmp, "home");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-sync-data-"));
    const claudeRoot = path.join(tmp, ".claude", "workflows");
    const codexRoot = path.join(tmp, ".codex", "workflows");
    writeWorkflow(claudeRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Feature implementation workflow.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n"));
    writeWorkflow(codexRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Duplicate workflow that should lose to Claude root priority.",
      "",
      "#### Code Implementation",
      "Use `planner`."
    ].join("\n"));
    writeWorkflow(claudeRoot, "documentation-management", [
      "# Documentation Management",
      "",
      "Documentation workflow for README and changelog updates.",
      "",
      "### Docs",
      "Use `docs-manager`."
    ].join("\n"));

    const result = await syncWorkflows({
      cwd: tmp,
      home,
      dataDir,
      allowRemote: false,
      args: ["--agents", "codex,agy"],
      logger: () => {}
    });

    expect(result.workflows.map((workflow) => workflow.name)).toEqual(expect.arrayContaining(["primary-workflow", "documentation-management"]));
    expect(fs.existsSync(path.join(home, ".codex", "workflows", "primary-workflow.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".gemini", "antigravity", "workflows", "documentation-management.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "workflows", "primary-workflow.md"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".codex", "workflows", "primary-workflow.md"), "utf8")).toContain("Feature implementation workflow.");
  });

  it("supports dry-run workflow sync without writing target files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-sync-dry-"));
    const home = path.join(tmp, "home");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-sync-dry-data-"));
    writeWorkflow(path.join(tmp, ".claude", "workflows"), "primary-workflow", [
      "# Primary Workflow",
      "",
      "Feature implementation workflow.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n"));

    const result = await syncWorkflows({
      cwd: tmp,
      home,
      dataDir,
      allowRemote: false,
      args: ["--dry-run"],
      logger: () => {}
    });

    expect(result.sync.copied).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(home, ".codex", "workflows", "primary-workflow.md"))).toBe(false);
  });

  it("suggests the implementation workflow for feature prompts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-score-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-data-"));
    const workflowsRoot = path.join(tmp, ".claude", "workflows");
    writeWorkflow(workflowsRoot, "primary-workflow", [
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
    writeWorkflow(workflowsRoot, "documentation-management", [
      "# Documentation Management",
      "",
      "Documentation workflow for README, changelog, and roadmap updates.",
      "",
      "### Documentation Updates",
      "Use `docs-manager` when docs need to be updated."
    ].join("\n"));

    const suggested = await suggestWorkflows({
      prompt: "implement a new payment feature and add tests",
      workflows: scanWorkflows({ cwd: tmp, roots: [workflowsRoot] }),
      dataDir,
      limit: 2,
      timeoutMs: 1
    });

    expect(suggested[0].name).toBe("primary-workflow");
    expect(suggested[0].chain).toEqual(expect.arrayContaining(["planner", "tester", "code-reviewer"]));
  });

  it("suggests documentation workflow for docs prompts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-docs-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-workflow-docs-data-"));
    const workflowsRoot = path.join(tmp, ".claude", "workflows");
    writeWorkflow(workflowsRoot, "primary-workflow", [
      "# Primary Workflow",
      "",
      "Feature implementation and testing workflow.",
      "",
      "#### Code Implementation",
      "Use `planner`, `tester`, and `code-reviewer`."
    ].join("\n"));
    writeWorkflow(workflowsRoot, "documentation-management", [
      "# Documentation Management",
      "",
      "Documentation workflow for docs, README, changelog, and roadmap updates.",
      "",
      "### README Updates",
      "Use `docs-manager` and `project-manager` for documentation changes."
    ].join("\n"));

    const suggested = await suggestWorkflows({
      prompt: "update API documentation and README",
      workflows: scanWorkflows({ cwd: tmp, roots: [workflowsRoot] }),
      dataDir,
      limit: 2,
      timeoutMs: 1
    });

    expect(suggested[0].name).toBe("documentation-management");
  });
});
