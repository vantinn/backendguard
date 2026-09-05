#!/usr/bin/env node
import { readStdinJson, writeJson, failOpen, logDebug, pluginRuntimeFile, pluginDataRoot } from "../../../agent-context/hook-io.js";
import { handlePromptPayload } from "../../../agent-context/prompt-hook.js";
import { appendTelemetry } from "../../../runtime/telemetry.js";
import { antigravityCwd, extractPromptFromAntigravityPayload } from "../../../integrations/antigravity/antigravity-adapter.js";

const started = Date.now();

try {
  const payload = await readStdinJson();
  const cwd = antigravityCwd(payload);
  const prompt = extractPromptFromAntigravityPayload(payload);
  const normalized = {
    ...payload,
    cwd,
    prompt,
    hook_event_name: "PreInvocation"
  };

  logDebug("Antigravity PreInvocation", normalized);
  appendTelemetry({ telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd), event: "PreInvocation", payload: normalized });
  const output = await handlePromptPayload(normalized, {
    dataPath: pluginRuntimeFile("last-prompt-context.json", cwd),
    historyPath: pluginRuntimeFile("prompt-history.jsonl", cwd),
    mcpDataDir: pluginDataRoot(),
    started
  });
  const additionalContext = output?.hookSpecificOutput?.additionalContext || "";
  writeJson({
    injectSteps: additionalContext ? [{ ephemeralMessage: additionalContext }] : []
  });
} catch (error) {
  failOpen("PreInvocation", error, {
    injectSteps: []
  });
}
