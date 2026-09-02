import { scheduleContext } from "./scheduler.js";
import { appendJsonLine, writeJsonFile } from "./fs-utils.js";
import { maybeAutoWarmWorkspace } from "./auto-warm.js";
import { callCtxHealth, callCtxScoreContext, ensureCtxMcpDaemon } from "./ctx-mcp-client.js";
import { resolveHookCwd } from "./hook-io.js";
import { loadOutputConfig, outputConfigLimits } from "./output-config.js";
import { scoreContext as scoreContextDirect } from "./score-context.js";
import fs from "node:fs";
import path from "node:path";

export async function handlePromptPayload(
  payload,
  {
    dataPath,
    historyPath,
    now = new Date(),
    started = Date.now(),
    injectContext = process.env.BACKENDGUARD_INJECT !== "0",
    scoreContextClient = callCtxScoreContext,
    healthContextClient = callCtxHealth,
    ensureMcpDaemonClient = ensureCtxMcpDaemon,
    scoreContextDirectClient = scoreContextDirect,
    autoWarmWorkspace = maybeAutoWarmWorkspace,
    mcpDataDir,
    outputConfig,
    directFallbackTimeoutMs = Number(process.env.BACKENDGUARD_DIRECT_FALLBACK_TIMEOUT_MS || 2500),
    requireHotMcp = scoreContextClient === callCtxScoreContext
  } = {}
) {
  const prompt = payload.prompt || payload.message || payload.user_prompt || "";
  const hookCwd = resolveHookCwd(payload);
  const cwd = resolvePromptTargetCwd({ cwd: hookCwd, prompt });
  const openFiles = payload.openFiles || payload.open_files || payload.files || [];
  const dataDir = dataPath ? path.dirname(dataPath) : undefined;
  const effectiveOutputConfig = outputConfig || loadOutputConfig();
  const promptLimits = outputConfigLimits(effectiveOutputConfig);

  let scored;
  let mcpDaemon = null;
  try {
    if (requireHotMcp) {
      mcpDaemon = await ensureMcpDaemonClient({
        dataDir: mcpDataDir || dataDir,
        waitMs: Number(process.env.BACKENDGUARD_MCP_AUTOSTART_WAIT_MS || 1500)
      });
      const health = await healthContextClient({
        dataDir: mcpDataDir || dataDir,
        timeoutMs: Number(process.env.BACKENDGUARD_MCP_HEALTH_TIMEOUT_MS || 250)
      });
      if (!health.embedding_pipeline_loaded) {
        throw new Error(`ctx-mcp scorer not hot: ${health.preload_status || "unknown"}`);
      }
    }
    scored = await scoreContextClient({
      cwd,
      prompt,
      openFiles,
      maxFiles: promptLimits.files,
      maxSkills: promptLimits.skills,
      maxWorkflows: promptLimits.workflows
    }, {
      dataDir: mcpDataDir || dataDir,
      timeoutMs: Number(process.env.BACKENDGUARD_MCP_BRIDGE_TIMEOUT_MS || 5000)
    });
  } catch (error) {
    try {
      scored = await withTimeout(scoreContextDirectClient({
        cwd,
        prompt,
        openFiles,
        maxFiles: promptLimits.files,
        maxSkills: promptLimits.skills,
        maxWorkflows: promptLimits.workflows,
        dataDir: mcpDataDir || dataDir,
        allowEmbeddings: false,
        embeddingTimeoutMs: Number(process.env.BACKENDGUARD_HOOK_EMBEDDING_TIMEOUT_MS || 500),
        fileEmbeddingTimeoutMs: Number(process.env.BACKENDGUARD_HOOK_FILE_EMBEDDING_TIMEOUT_MS || 1000),
        skillEmbeddingTimeoutMs: Number(process.env.BACKENDGUARD_HOOK_SKILL_EMBEDDING_TIMEOUT_MS || 2000)
      }), directFallbackTimeoutMs, "direct fallback scoring");
      scored.telemetry = {
        ...(scored.telemetry || {}),
        bridgeStatus: "fallback",
        bridgeError: error?.message || String(error),
        mcpDaemon
      };
    } catch (directError) {
      scored = emptyScore({
        bridgeStatus: "fallback-failed",
        bridgeError: error?.message || String(error),
        directFallbackError: directError?.message || String(directError),
        mcpDaemon
      });
    }
  }

  if (scored.error) throw new Error(scored.error);
  const scoredRules = scored.scoredRules || [];
  const scheduled = scheduleContext({
    rules: scoredRules,
    relevantFiles: scored.suggestedFiles || [],
    suggestedSkills: scored.suggestedSkills || [],
    suggestedWorkflows: scored.suggestedWorkflows || [],
    prompt,
    outputConfig: effectiveOutputConfig
  });
  const relevantFiles = scheduled.relevantFiles || [];
  const suggestedSkills = scheduled.suggestedSkills || [];
  const suggestedWorkflows = scheduled.suggestedWorkflows || [];
  const contextEmptyReason = emptyContextReason({ scheduled, outputConfig: effectiveOutputConfig, injectContext });
  const autoWarm = autoWarmWorkspace({
    cwd,
    prompt,
    dataDir,
    reason: contextEmptyReason,
    now: now.getTime()
  });

  const runtime = {
    at: now.toISOString(),
    cwd,
    prompt,
    rules: scoredRules,
    scoring: {
      keyword: true,
      mcp: scored.telemetry || {}
    },
    relevantFiles,
    suggestedSkills,
    suggestedWorkflows,
    telemetry: {
      ...(scored.telemetry || {}),
      retrievalMode: retrievalMode(scored.telemetry || {}),
      rulesInjected: (scheduled.highRules?.length || 0) + (scheduled.midRules?.length || 0),
      filesSuggested: relevantFiles.length,
      skillsSuggested: suggestedSkills.length,
      workflowsSuggested: suggestedWorkflows.length,
      emptyContextReason: contextEmptyReason,
      autoWarm
    },
    scheduled,
    injected: injectContext,
    elapsedMs: Date.now() - started
  };

  try {
    if (dataPath) writeJsonFile(dataPath, runtime);
    if (historyPath) appendJsonLine(historyPath, runtime);
  } catch {
    // Context injection is the critical path; diagnostics are best-effort.
  }

  const additionalContext = injectContext ? scheduled.additionalContext : "";
  const output = {
    continue: true,
    suppressOutput: true
  };
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext
    };
  }
  return output;
}

export function resolvePromptTargetCwd({ cwd = process.cwd(), prompt = "" } = {}) {
  const current = path.resolve(cwd);
  const candidates = targetPathCandidates(prompt);
  for (const candidate of candidates) {
    const resolved = path.resolve(current, candidate);
    if (!isAllowedTargetCwd({ current, resolved })) continue;
    if (isWorkspaceRoot(resolved)) return resolved;
  }
  return current;
}

function targetPathCandidates(prompt) {
  const text = String(prompt || "");
  const patterns = [
    /\b(?:tr[eê]n|in|inside|under|repo|workspace|cwd)\s+([.~A-Za-z0-9_/@.-]+(?:\/[A-Za-z0-9_@().-]+)*)/gi,
    /\b(?:debug|test|check|run)\s+(?:on|tr[eê]n)\s+([.~A-Za-z0-9_/@.-]+(?:\/[A-Za-z0-9_@().-]+)*)/gi
  ];
  const results = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const value = cleanPromptPath(match[1]);
      if (value) results.push(value);
    }
  }
  return results;
}

function cleanPromptPath(value) {
  const cleaned = String(value || "").trim().replace(/[),.;:]+$/g, "");
  if (!cleaned || cleaned.includes("://")) return null;
  return cleaned;
}

function isAllowedTargetCwd({ current, resolved }) {
  const parent = path.dirname(current);
  const relative = path.relative(parent, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isWorkspaceRoot(directory) {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(directory, "package.json"))
    || fs.existsSync(path.join(directory, "AGENTS.md"))
    || fs.existsSync(path.join(directory, ".git"));
}

function emptyContextReason({ scheduled, outputConfig, injectContext }) {
  if (!injectContext) return "injection-disabled";
  if (scheduled.additionalContext) return null;
  const sections = outputConfig?.sections || {};
  const available = [];
  if ((scheduled.highRules?.length || 0) || (scheduled.midRules?.length || 0)) available.push("rules");
  if (scheduled.relevantFiles?.length) available.push("files");
  if (scheduled.suggestedSkills?.length) available.push("skills");
  if (scheduled.suggestedWorkflows?.length) available.push("workflows");
  if (!available.length) return "no-context-candidates";
  const enabledMissing = ["rules", "files", "skills", "workflows"]
    .filter((section) => sections[section] !== false && !available.includes(section));
  if (enabledMissing.length) return `enabled-sections-missing-candidates:${enabledMissing.join(",")}`;
  const enabled = available.filter((section) => sections[section] !== false);
  return enabled.length ? "enabled-sections-empty-after-formatting" : `available-sections-disabled:${available.join(",")}`;
}

function emptyScore(telemetry = {}) {
  return {
    scoredRules: [],
    suggestedFiles: [],
    suggestedSkills: [],
    suggestedWorkflows: [],
    telemetry: {
      elapsedMs: 0,
      modelStatus: "skipped",
      rulesParsed: 0,
      rulesInjected: 0,
      filesSuggested: 0,
      skillsSuggested: 0,
      workflowsSuggested: 0,
      ...telemetry
    }
  };
}

export function retrievalMode(telemetry = {}) {
  const bridge = telemetry.bridgeStatus || "mcp";
  const embedding = telemetry.modelStatus === "disabled" ? "disabled" : "enabled";
  const fallback = bridge === "fallback" || bridge === "fallback-failed" || embedding === "disabled";
  return {
    bridge,
    bridgeError: telemetry.bridgeError || null,
    embedding,
    fileFallback: fallback ? "indexed-text-match" : null,
    skillFallback: fallback ? "lightweight-evidence-score" : null
  };
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}
