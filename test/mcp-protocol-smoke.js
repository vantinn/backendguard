#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { modelCacheDir, warmRuleEmbeddings } from "../plugins/ctx/lib/embedding-scorer.js";
import { warmFileEmbeddings } from "../plugins/ctx/lib/file-embedding-retriever.js";
import { defaultDataRoot } from "../plugins/ctx/lib/workspace-data.js";
import { createBackendGuardMcpServer } from "../plugins/ctx/mcp/backendguard-server.js";

const preferredModelDir = modelCacheDir(defaultDataRoot());
const legacyModelDir = modelCacheDir(path.join(os.homedir(), ".codex", "backendguard"));
const installedModelDir = fs.existsSync(preferredModelDir) ? preferredModelDir : legacyModelDir;
const hasInstalledModel = process.env.BACKENDGUARD_MCP_SMOKE_FORCE_COLD === "1" ? false : fs.existsSync(installedModelDir);

const cleanupPaths = [];
let client;
let server;

try {
  const cwd = makeFixtureProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-data-"));
  cleanupPaths.push(dataDir);
  if (!hasInstalledModel) {
    await runColdCacheSmoke({ cwd, dataDir });
    console.log("ctx-mcp protocol smoke passed");
    console.log(`model cache: missing (${installedModelDir}); cold-cache fallback verified`);
  } else {
    await runSemanticSmoke({ cwd, dataDir });
  }
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  while (cleanupPaths.length) {
    fs.rmSync(cleanupPaths.pop(), { recursive: true, force: true });
  }
}

async function runSemanticSmoke({ cwd, dataDir }) {
  fs.symlinkSync(installedModelDir, path.join(dataDir, "models"), "dir");
  const fixtureRules = [
    { content: "Always inspect upload moderation flows before editing." },
    { content: "Use content moderation service for user generated uploads." },
    { content: "Never bypass resource approval checks." }
  ];
  const semanticPrompts = [
    "kiểm tra flow kiểm duyệt upload",
    "tải lên cần kiểm duyệt",
    "review uploaded content",
    "moderate user generated upload",
    "duyệt resource approval",
    "approval checks cho tài nguyên",
    "content review workflow",
    "kiểm tra nội dung người dùng tải lên",
    "reject unsafe upload",
    "bypass approval checks"
  ];
  for (const task of semanticPrompts) {
    await warmRuleEmbeddings({
      rules: fixtureRules,
      task,
      dataDir,
      sources: [path.join(cwd, "AGENTS.md")],
      allowRemote: false
    });
  }
  await warmFileEmbeddings({ cwd, dataDir, allowRemote: false });

  ({ client, server } = await startInMemoryMcp({ dataDir }));

  const health = await callHealth(client);
  assert.equal(health.structuredContent.model_cache_ready, hasInstalledModel);
  assert.equal(health.structuredContent.bridge_ready, false);
  await assertCliTools(client);

  const first = await callScore(client, cwd, "kiểm tra flow kiểm duyệt upload");
  assert.equal(first.structuredContent.telemetry.modelStatus, "enabled");
  assert.ok(first.structuredContent.scoredRules.length > 0);
  assert.ok(first.structuredContent.suggestedFiles.length > 0);
  assert.ok(first.structuredContent.scoredRules[0].score >= 0.5);
  // First content block is human-readable context; last block is telemetry JSON
  assert.ok(first.content.length >= 2, "expected at least 2 content blocks (context + telemetry)");
  assert.ok(/Critical BackendGuard rules|Suggested files|upload|moderation/i.test(first.content[0].text), "first content block should be human-readable context");
  const telemetryBlock = first.content[first.content.length - 1];
  assert.ok(JSON.parse(telemetryBlock.text).rulesParsed > 0);

  const semanticResults = await Promise.all(semanticPrompts.map((prompt) => callScore(client, cwd, prompt)));
  for (const result of semanticResults) {
    assert.equal(result.structuredContent.telemetry.modelStatus, "enabled");
    assert.ok(
      result.structuredContent.scoredRules.some((rule) => /upload|moderation|approval/i.test(rule.content) && rule.score >= 0.5),
      "expected semantic upload/moderation/approval rule with score >= 0.5"
    );
  }

  const concurrent = await Promise.all([
    callScore(client, cwd, "kiểm tra moderation upload"),
    callScore(client, cwd, "fix content review flow"),
    callScore(client, cwd, "tải lên cần kiểm duyệt")
  ]);
  for (const result of concurrent) {
    assert.equal(result.structuredContent.telemetry.modelStatus, "enabled");
    assert.ok(result.structuredContent.suggestedFiles.length > 0);
    assert.ok(
      result.structuredContent.scoredRules.some((rule) => /upload|moderation/i.test(rule.content) && rule.score >= 0.5),
      "expected semantic upload/moderation rule with score >= 0.5"
    );
  }

  await callScore(client, cwd, "kiểm tra flow kiểm duyệt upload");
  const durations = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    await callScore(client, cwd, "kiểm tra flow kiểm duyệt upload");
    durations.push(performance.now() - started);
  }
  const p95 = percentile(durations, 95);
  assert.ok(p95 < 100, `expected warm p95 < 100ms, got ${Math.round(p95)}ms`);

  console.log("ctx-mcp protocol smoke passed");
  console.log(`warm p95: ${Math.round(p95)}ms`);
}

async function runColdCacheSmoke({ cwd, dataDir }) {
  ({ client, server } = await startInMemoryMcp({ dataDir }));
  const health = await callHealth(client);
  assert.equal(health.structuredContent.model_cache_ready, false);
  assert.equal(health.structuredContent.embedding_pipeline_loaded, false);
  await assertCliTools(client);
  const result = await callScore(client, cwd, "kiểm tra flow kiểm duyệt upload");
  assert.equal(result.structuredContent.telemetry.modelStatus, "cold-cache");
  assert.ok(result.structuredContent.telemetry.rulesParsed > 0);
  assert.ok(Array.isArray(result.structuredContent.scoredRules));
  assert.ok(Array.isArray(result.structuredContent.suggestedFiles));
  assert.ok(result.content.length >= 1, "expected telemetry content block");
  const telemetryBlock = result.content[result.content.length - 1];
  assert.ok(JSON.parse(telemetryBlock.text).rulesParsed > 0);
}

async function startInMemoryMcp({ dataDir }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const nextServer = createBackendGuardMcpServer({
    dataDir,
    getHealth: () => ({
      model_cache_ready: hasInstalledModel,
      embedding_pipeline_loaded: false,
      bridge_ready: false,
      preload_status: hasInstalledModel ? "not-started" : "missing-model"
    }),
    runCommand: async (args, options) => ({
      code: 0,
      stdout: `ran ctx ${args.join(" ")} in ${options.cwd}`,
      stderr: ""
    })
  });
  const nextClient = new Client({ name: "ctx-mcp-smoke", version: "0.1.0" });
  await Promise.all([
    nextServer.connect(serverTransport),
    nextClient.connect(clientTransport)
  ]);
  return { client: nextClient, server: nextServer };
}

async function assertCliTools(activeClient) {
  const cwd = process.cwd();
  for (const [name, args, expected] of [
    ["ctx_debug_context", { cwd, prompt: "fix deployed" }, "ran ctx debug -- fix deployed"],
    ["ctx_detect_stack", { cwd }, "ran ctx stack"],
    ["ctx_doctor_repo", { cwd }, "ran ctx doctor"],
    ["ctx_skills_doctor", { cwd, prompt: "fix deployed" }, "ran ctx skills doctor -- fix deployed"],
    ["ctx_analyze_changes", { cwd }, "ran ctx check"],
    ["ctx_report_last_task", { cwd }, "ran ctx report"],
    ["ctx_evidence_last_task", { cwd }, "ran ctx evidence"],
    ["ctx_stats_workspace", { cwd }, "ran ctx stats"]
  ]) {
    const result = await activeClient.callTool({ name, arguments: args });
    assert.equal(result.structuredContent.code, 0);
    assert.ok(result.content[0].text.includes(expected), `${name} should return CLI-backed output`);
  }
}

async function callHealth(activeClient) {
  return activeClient.callTool({
    name: "ctx_health",
    arguments: {}
  });
}

function makeFixtureProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-project-"));
  cleanupPaths.push(cwd);
  fs.mkdirSync(path.join(cwd, "services", "upload-service", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "services", "content-service", "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), [
    "- Always inspect upload moderation flows before editing.",
    "- Use content moderation service for user generated uploads.",
    "- Never bypass resource approval checks."
  ].join("\n"));
  fs.writeFileSync(
    path.join(cwd, "services", "upload-service", "src", "upload.events.ts"),
    "export const UploadCompleted = 'upload.completed';\n"
  );
  fs.writeFileSync(
    path.join(cwd, "services", "content-service", "src", "content-moderation.service.ts"),
    "export function moderateUploadedContent() { return true; }\n"
  );
  return cwd;
}

async function callScore(activeClient, cwd, prompt) {
  return activeClient.callTool({
    name: "ctx_score_context",
    arguments: { cwd, prompt, maxFiles: 3 }
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
