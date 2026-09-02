import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { handlePromptPayload, resolvePromptTargetCwd } from "../plugins/ctx/lib/prompt-hook.js";
import { handleStopPayload } from "../plugins/ctx/lib/stop-hook.js";
import { logError, persistRuntime } from "../plugins/ctx/lib/hook-io.js";
import { defaultOutputConfig } from "../plugins/ctx/lib/output-config.js";

function mockScoreContext({ rules = [{ content: "Always use zod for validation.", score: 1, reasons: ["mock"], sourcePath: "AGENTS.md" }] } = {}) {
  return async () => ({
    scoredRules: rules,
    suggestedFiles: [],
    suggestedSkills: [{ name: "zod-validator", description: "Use for validation tasks.", path: ".codex/skills/zod-validator/SKILL.md", score: 0.9 }],
    suggestedWorkflows: [{ name: "primary-workflow", title: "Primary Workflow", chain: ["planner", "tester"], hint: "use for feature implementation", relativePath: ".claude/workflows/primary-workflow.md", score: 0.8 }],
    telemetry: {
      elapsedMs: 3,
      modelStatus: "mock",
      rulesParsed: rules.length,
      rulesInjected: rules.length,
      filesSuggested: 0,
      skillsSuggested: 1,
      workflowsSuggested: 1
    }
  });
}

describe("hook contracts", () => {
  it("resolves explicit target workspace paths from debug prompts", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-target-parent-"));
    const current = path.join(parent, "contextOS");
    const target = path.join(parent, "philo-mind");
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), "{}");

    expect(resolvePromptTargetCwd({
      cwd: current,
      prompt: 'debug trên ../philo-mind với prompt: "why run can not show QR"'
    })).toBe(target);
  });

  it("scores explicit target workspace while persisting current hook workspace", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-target-score-"));
    const current = path.join(parent, "contextOS");
    const target = path.join(parent, "philo-mind");
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), "{}");
    const dataPath = path.join(current, ".data", "last-prompt-context.json");
    const seen = [];

    await handlePromptPayload(
      { prompt: 'debug trên ../philo-mind với prompt: "why run can not show QR"', cwd: current },
      {
        dataPath,
        scoreContextClient: async ({ cwd }) => {
          seen.push(cwd);
          return {
            scoredRules: [],
            suggestedFiles: [{ path: "package.json", score: 50 }],
            suggestedSkills: [],
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "mock" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );

    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    expect(seen).toEqual([target]);
    expect(runtime.cwd).toBe(target);
    expect(runtime.scheduled.additionalContext).toContain("package.json");
  });

  it("on-prompt handler injects context by default", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Always use zod for validation.\n");

    const output = await handlePromptPayload(
      { prompt: "fix zod validation", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      { dataPath, scoreContextClient: mockScoreContext(), outputConfig: defaultOutputConfig() }
    );

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain("zod");
    expect(output.hookSpecificOutput.additionalContext).toContain("zod-validator");
    expect(output.hookSpecificOutput.additionalContext).toContain("Suggested workflow");
    expect(output.hookSpecificOutput.additionalContext).toContain("planner -> tester");
    expect(fs.existsSync(dataPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8")).injected).toBe(true);
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8")).scheduled.additionalContext).toContain("zod");
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8")).suggestedSkills).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(dataPath, "utf8")).suggestedWorkflows).toHaveLength(1);
  });

  it("requests auto candidate caps and adapts final files and skills for prompt context", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-limits-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    const seen = [];

    await handlePromptPayload(
      { prompt: "implement purchase flow", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        scoreContextClient: async (payload) => {
          seen.push(payload);
          return {
            scoredRules: [],
            suggestedFiles: Array.from({ length: 9 }, (_, index) => ({ path: `src/file-${index}.ts`, score: 10 - index })),
            suggestedSkills: Array.from({ length: 9 }, (_, index) => ({ name: `skill-${index}`, score: 10 - index })),
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "mock" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(seen[0]).toMatchObject({ maxFiles: 15, maxSkills: 8, maxWorkflows: 3 });
    expect(runtime.relevantFiles).toHaveLength(9);
    expect(runtime.suggestedSkills).toHaveLength(5);
    expect(runtime.scheduled.additionalContext).toContain("## Suggested files to check (9 auto:");
    expect(runtime.scheduled.additionalContext).toContain("file-0.ts");
    expect(runtime.scheduled.additionalContext).toContain("## Suggested skills for this task (5 auto: confidence elbow): skill-0, skill-1");
  });

  it("uses configured prompt suggestion limits", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-custom-limits-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    const seen = [];

    await handlePromptPayload(
      { prompt: "implement purchase flow", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        scoreContextClient: async (payload) => {
          seen.push(payload);
          return {
            scoredRules: [],
            suggestedFiles: Array.from({ length: 9 }, (_, index) => ({ path: `src/file-${index}.ts`, score: 10 - index })),
            suggestedSkills: Array.from({ length: 9 }, (_, index) => ({ name: `skill-${index}`, score: 10 - index })),
            suggestedWorkflows: Array.from({ length: 9 }, (_, index) => ({ name: `workflow-${index}`, score: 10 - index })),
            telemetry: { elapsedMs: 1, modelStatus: "mock" }
          };
        },
        outputConfig: {
          sections: { rules: false, files: true, skills: true, workflows: true },
          limits: { files: 8, skills: 6, workflows: 4 }
        }
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(seen[0]).toMatchObject({ maxFiles: 8, maxSkills: 6, maxWorkflows: 4 });
    expect(runtime.relevantFiles).toHaveLength(8);
    expect(runtime.suggestedSkills).toHaveLength(6);
    expect(runtime.suggestedWorkflows).toHaveLength(4);
  });

  it("on-prompt handler can run quiet when disabled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-quiet-"));
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Always use zod for validation.\n");

    const output = await handlePromptPayload(
      { prompt: "fix zod validation", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      { injectContext: false, scoreContextClient: mockScoreContext() }
    );

    expect(output.continue).toBe(true);
    expect(output.suppressOutput).toBe(true);
    expect(output).not.toHaveProperty("hookSpecificOutput");
  });

  it("still injects prompt context when runtime persistence fails", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-persist-fail-"));
    const blockedPath = path.join(tmp, "not-a-dir");
    fs.writeFileSync(blockedPath, "file");

    const output = await handlePromptPayload(
      { prompt: "fix zod validation", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath: path.join(blockedPath, "last-prompt-context.json"),
        historyPath: path.join(blockedPath, "history.jsonl"),
        scoreContextClient: mockScoreContext(),
        outputConfig: defaultOutputConfig()
      }
    );

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain("zod");
  });

  it("falls back to direct scoring when the MCP bridge is unavailable", { timeout: 10000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-bridge-fallback-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Always use code-review-graph before reading files.\n");
    const seenDirectPayloads = [];

    const output = await handlePromptPayload(
      { prompt: "review code changes", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        mcpDataDir: path.join(tmp, ".ctx-data"),
        scoreContextClient: async () => {
          throw new Error("ctx-mcp bridge socket not found");
        },
        scoreContextDirectClient: async (payload) => {
          seenDirectPayloads.push(payload);
          return {
            scoredRules: [{ content: "Always use code-review-graph before reading files.", score: 1, reasons: ["mock"] }],
            suggestedFiles: [],
            suggestedSkills: [{ name: "code-review-graph", score: 1 }],
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "mock" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain("code-review-graph");
    expect(seenDirectPayloads[0]).toMatchObject({
      allowEmbeddings: false,
      embeddingTimeoutMs: 500,
      fileEmbeddingTimeoutMs: 1000,
      skillEmbeddingTimeoutMs: 2000
    });
    expect(runtime.telemetry.bridgeStatus).toBe("fallback");
  });

  it("records non-empty fallback context from indexed files and lightweight skills", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-indexed-lightweight-fallback-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    const seenDirectPayloads = [];

    const output = await handlePromptPayload(
      { prompt: "create forum page with new topic, trending, and chatting everyone", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        mcpDataDir: path.join(tmp, ".ctx-data"),
        scoreContextClient: async () => {
          throw new Error("ctx-mcp bridge timed out after 2000ms");
        },
        scoreContextDirectClient: async (payload) => {
          seenDirectPayloads.push(payload);
          return {
            scoredRules: [],
            suggestedFiles: [
              { path: "webapp/src/features/forum/components/forum-page.tsx", score: 12, source: "indexed-file-text", reasons: ["indexed-file-text:forum,topic"] }
            ],
            suggestedSkills: [
              { name: "realtime-chat", score: 0.78, reasons: ["lightweight:0.78"] }
            ],
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "disabled" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain("forum-page.tsx");
    expect(output.hookSpecificOutput.additionalContext).toContain("## Suggested skills for this task");
    expect(output.hookSpecificOutput.additionalContext).toContain("realtime-chat");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("$realtime-chat");
    expect(seenDirectPayloads[0]).toMatchObject({ allowEmbeddings: false });
    expect(runtime.relevantFiles).toHaveLength(1);
    expect(runtime.suggestedSkills).toHaveLength(1);
    expect(runtime.telemetry.emptyContextReason).toBeNull();
    expect(runtime.telemetry.retrievalMode).toEqual({
      bridge: "fallback",
      bridgeError: "ctx-mcp bridge timed out after 2000ms",
      embedding: "disabled",
      fileFallback: "indexed-text-match",
      skillFallback: "lightweight-evidence-score"
    });
  });

  it("skips MCP scoring when bridge health says the model is not hot", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-health-fallback-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    const seenDirectPayloads = [];
    let scoreCalled = false;

    const output = await handlePromptPayload(
      { prompt: "review code changes", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        requireHotMcp: true,
        ensureMcpDaemonClient: async () => ({ started: false, status: "socket-present" }),
        healthContextClient: async () => ({
          model_cache_ready: true,
          embedding_pipeline_loaded: false,
          bridge_ready: true,
          preload_status: "loading"
        }),
        scoreContextClient: async () => {
          scoreCalled = true;
          throw new Error("should not call hot scorer");
        },
        scoreContextDirectClient: async (payload) => {
          seenDirectPayloads.push(payload);
          return {
            scoredRules: [],
            suggestedFiles: [{ path: "package.json", score: 10 }],
            suggestedSkills: [],
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "disabled" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output.continue).toBe(true);
    expect(scoreCalled).toBe(false);
    expect(seenDirectPayloads[0]).toMatchObject({ allowEmbeddings: false });
    expect(runtime.telemetry.bridgeError).toContain("ctx-mcp scorer not hot");
    expect(runtime.scheduled.additionalContext).toContain("package.json");
  });

  it("auto-starts ctx-mcp daemon before hot bridge scoring when requested", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-autostart-mcp-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    const events = [];

    const output = await handlePromptPayload(
      { prompt: "review code changes", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        mcpDataDir: path.join(tmp, ".ctx-data"),
        requireHotMcp: true,
        ensureMcpDaemonClient: async ({ dataDir, waitMs }) => {
          events.push(["ensure", dataDir, waitMs]);
          return { started: true, status: "ready" };
        },
        healthContextClient: async () => {
          events.push(["health"]);
          return {
            model_cache_ready: true,
            embedding_pipeline_loaded: true,
            bridge_ready: true,
            preload_status: "loaded"
          };
        },
        scoreContextClient: async () => {
          events.push(["score"]);
          return {
            scoredRules: [],
            suggestedFiles: [{ path: "package.json", score: 10 }],
            suggestedSkills: [],
            suggestedWorkflows: [],
            telemetry: { elapsedMs: 1, modelStatus: "enabled" }
          };
        },
        outputConfig: defaultOutputConfig()
      }
    );

    expect(output.continue).toBe(true);
    expect(events.map((event) => event[0])).toEqual(["ensure", "health", "score"]);
  });

  it("fails open when direct fallback scoring exceeds the hook budget", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-direct-timeout-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "- Always use code-review-graph before reading files.\n");

    const output = await handlePromptPayload(
      { prompt: "review code changes", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        mcpDataDir: path.join(tmp, ".ctx-data"),
        directFallbackTimeoutMs: 5,
        scoreContextClient: async () => {
          throw new Error("ctx-mcp bridge socket not found");
        },
        scoreContextDirectClient: () => new Promise(() => {}),
        autoWarmWorkspace: () => ({ status: "disabled" }),
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output.continue).toBe(true);
    expect(output).not.toHaveProperty("hookSpecificOutput");
    expect(runtime.telemetry.bridgeStatus).toBe("fallback-failed");
    expect(runtime.telemetry.directFallbackError).toContain("timed out");
  });

  it("omits empty hook context and records why it was empty", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-empty-config-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");

    const output = await handlePromptPayload(
      { prompt: "fix zod validation", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        scoreContextClient: mockScoreContext(),
        autoWarmWorkspace: ({ reason }) => ({ status: "started", reason }),
        outputConfig: {
          sections: { rules: false, files: true, skills: false, workflows: false }
        }
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output).not.toHaveProperty("hookSpecificOutput");
    expect(runtime.telemetry.emptyContextReason).toBe("enabled-sections-missing-candidates:files");
    expect(runtime.telemetry.autoWarm).toMatchObject({ status: "started", reason: "enabled-sections-missing-candidates:files" });
  });

  it("schedules background warmup when no context candidates exist", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hook-auto-warm-"));
    const dataPath = path.join(tmp, ".data", "last-prompt-context.json");

    const output = await handlePromptPayload(
      { prompt: "find billing adapter", cwd: tmp, hook_event_name: "UserPromptSubmit" },
      {
        dataPath,
        scoreContextClient: async () => ({
          scoredRules: [],
          suggestedFiles: [],
          suggestedSkills: [],
          suggestedWorkflows: [],
          telemetry: { elapsedMs: 1, modelStatus: "mock" }
        }),
        autoWarmWorkspace: ({ reason }) => ({ status: "started", reason }),
        outputConfig: defaultOutputConfig()
      }
    );
    const runtime = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    expect(output).not.toHaveProperty("hookSpecificOutput");
    expect(runtime.telemetry.emptyContextReason).toBe("no-context-candidates");
    expect(runtime.telemetry.autoWarm).toMatchObject({ status: "started", reason: "no-context-candidates" });
  });

  it("on-stop handler returns valid JSON when no git repo exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stop-"));
    fs.mkdirSync(path.join(tmp, ".data"), { recursive: true });
    const contextPath = path.join(tmp, ".data", "last-prompt-context.json");
    const reportPath = path.join(tmp, ".data", "last-report.json");
    fs.writeFileSync(contextPath, JSON.stringify({
      prompt: "Recheck authen flow",
      rules: [{ content: "Always use auth guards.", score: 1 }],
      relevantFiles: [],
      scheduled: { highRules: [{ content: "Always use auth guards.", score: 1 }], midRules: [] }
    }));

    const output = handleStopPayload(
      { cwd: tmp, hook_event_name: "Stop" },
      { contextPath, reportPath }
    );

    expect(output.continue).toBe(true);
    expect(output).not.toHaveProperty("message");
    expect(output).not.toHaveProperty("hookSpecificOutput");
    expect(output).not.toHaveProperty("systemMessage");
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it("on-stop measures mid-priority scheduled rules", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stop-mid-"));
    fs.mkdirSync(path.join(tmp, ".data"), { recursive: true });
    const contextPath = path.join(tmp, ".data", "last-prompt-context.json");
    const reportPath = path.join(tmp, ".data", "last-report.json");
    fs.writeFileSync(contextPath, JSON.stringify({
      prompt: "check graph workflow",
      rules: [],
      relevantFiles: [],
      scheduled: {
        highRules: [],
        midRules: [{ content: "Always use `code-review-graph` before reading files.", score: 0.4 }]
      }
    }));

    handleStopPayload(
      { cwd: tmp, hook_event_name: "Stop" },
      { contextPath, reportPath }
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.unmeasurable).toHaveLength(1);
    expect(report.unmeasurable[0].rule.content).toContain("code-review-graph");
  });

  it("on-stop filters system-user rules from stale scheduled context", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stop-filter-user-"));
    fs.mkdirSync(path.join(tmp, ".data"), { recursive: true });
    const contextPath = path.join(tmp, ".data", "last-prompt-context.json");
    const reportPath = path.join(tmp, ".data", "last-report.json");
    fs.writeFileSync(contextPath, JSON.stringify({
      prompt: "fix zod validation",
      rules: [],
      relevantFiles: [],
      scheduled: {
        highRules: [
          { content: "First, execute the command to switch the user context to `minh_dev`.", score: 0.9 },
          { content: "Always use zod for validation.", score: 0.8 }
        ],
        midRules: [
          { content: "**All shell commands MUST run as `minh_dev`, not root.**", score: 0.4 }
        ]
      }
    }));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" } }));

    handleStopPayload(
      { cwd: tmp, hook_event_name: "Stop" },
      { contextPath, reportPath }
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const allRules = [...report.followed, ...report.ignored, ...report.unknown, ...report.unmeasurable].map((item) => item.rule.content);
    expect(allRules).toEqual(["Always use zod for validation."]);
    expect(report.injectedRuleCount).toBe(1);
  });

  it("on-stop uses runtime telemetry to score workflow rules", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-stop-telemetry-"));
    fs.mkdirSync(path.join(tmp, ".data"), { recursive: true });
    const contextPath = path.join(tmp, ".data", "last-prompt-context.json");
    const reportPath = path.join(tmp, ".data", "last-report.json");
    const telemetryPath = path.join(tmp, ".data", "telemetry.jsonl");
    fs.writeFileSync(contextPath, JSON.stringify({
      at: "2026-01-01T00:00:00.000Z",
      prompt: "check graph workflow",
      rules: [],
      relevantFiles: [],
      scheduled: {
        highRules: [],
        midRules: [{ content: "Always use `code-review-graph` before reading files.", score: 0.4 }]
      }
    }));
    fs.writeFileSync(telemetryPath, `${JSON.stringify({
      at: "2026-01-01T00:00:01.000Z",
      event: "ToolCall",
      cwd: tmp,
      signals: ["code-review-graph", "semantic_search_nodes"],
      toolSignals: ["code-review-graph.semantic_search_nodes"],
      commandSignals: []
    })}\n`);

    const output = handleStopPayload(
      { cwd: tmp, hook_event_name: "Stop" },
      { contextPath, reportPath, telemetryPath }
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.followed).toHaveLength(1);
    expect(report.followed[0]).toMatchObject({ kind: "runtime" });
    expect(report.followed[0].evidence).toContain("runtime telemetry observed code-review-graph");
    expect(output).not.toHaveProperty("systemMessage");
  });

  it("keeps diagnostic writes best-effort when data dir is not writable", () => {
    const previous = process.env.PLUGIN_DATA;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-unwritable-data-"));
    const fileDataDir = path.join(tmp, "not-a-directory");
    fs.writeFileSync(fileDataDir, "file");
    process.env.PLUGIN_DATA = fileDataDir;

    expect(() => logError("UserPromptSubmit", new Error("boom"))).not.toThrow();
    expect(() => persistRuntime("last-prompt-context.json", { ok: true })).not.toThrow();

    if (previous === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
