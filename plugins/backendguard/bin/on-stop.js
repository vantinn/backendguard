#!/usr/bin/env node
import { readStdinJson, writeJson, failOpen, logDebug, pluginRuntimeFile, resolveHookCwd } from "../../../agent-context/hook-io.js";
import { handleStopPayload } from "../../../agent-context/stop-hook.js";
import { appendTelemetry } from "../../../runtime/telemetry.js";

try {
  const payload = await readStdinJson();
  const cwd = resolveHookCwd(payload);
  const normalized = { ...payload, cwd };
  logDebug("Stop", normalized);
  appendTelemetry({ telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd), event: "Stop", payload: normalized });
  writeJson(handleStopPayload(normalized, {
    contextPath: pluginRuntimeFile("last-prompt-context.json", cwd),
    reportPath: pluginRuntimeFile("last-report.json", cwd),
    historyPath: pluginRuntimeFile("report-history.jsonl", cwd),
    telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd)
  }));
} catch (error) {
  failOpen("Stop", error, {
    continue: true
  });
}
