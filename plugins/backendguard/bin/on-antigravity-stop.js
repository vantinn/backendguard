#!/usr/bin/env node
import { readStdinJson, writeJson, failOpen, logDebug, pluginRuntimeFile } from "../../../agent-context/hook-io.js";
import { handleStopPayload } from "../../../agent-context/stop-hook.js";
import { appendTelemetry } from "../../../runtime/telemetry.js";
import { antigravityCwd } from "../../../integrations/antigravity/antigravity-adapter.js";

try {
  const payload = await readStdinJson();
  const cwd = antigravityCwd(payload);
  const normalized = {
    ...payload,
    cwd,
    hook_event_name: "Stop"
  };
  logDebug("Antigravity Stop", normalized);
  appendTelemetry({ telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd), event: "Stop", payload: normalized });
  handleStopPayload(normalized, {
    contextPath: pluginRuntimeFile("last-prompt-context.json", cwd),
    reportPath: pluginRuntimeFile("last-report.json", cwd),
    historyPath: pluginRuntimeFile("report-history.jsonl", cwd),
    telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd)
  });
  writeJson({ decision: "" });
} catch (error) {
  failOpen("Stop", error, {
    decision: ""
  });
}
