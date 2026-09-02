#!/usr/bin/env node
import { armHookDeadline, exitAfterStdout, readStdinJson, writeJson, failOpen, logDebug, pluginRuntimeFile, pluginDataRoot, resolveHookCwd } from "../lib/hook-io.js";
import { handlePromptPayload } from "../lib/prompt-hook.js";
import { appendTelemetry } from "../lib/telemetry.js";

const started = Date.now();
const fallback = {
  continue: true,
  suppressOutput: true
};
let deadline;

try {
  const payload = await readStdinJson();
  deadline = armHookDeadline("UserPromptSubmit", fallback);
  const cwd = resolveHookCwd(payload);
  const normalized = { ...payload, cwd };

  logDebug("UserPromptSubmit", normalized);
  appendTelemetry({ telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd), event: "UserPromptSubmit", payload: normalized });
  writeJson(await handlePromptPayload(normalized, {
    dataPath: pluginRuntimeFile("last-prompt-context.json", cwd),
    historyPath: pluginRuntimeFile("prompt-history.jsonl", cwd),
    mcpDataDir: pluginDataRoot(),
    started
  }));
  deadline.clear();
  exitAfterStdout(0);
} catch (error) {
  deadline?.clear();
  failOpen("UserPromptSubmit", error, fallback);
  exitAfterStdout(0);
}
