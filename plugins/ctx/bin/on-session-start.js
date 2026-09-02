#!/usr/bin/env node
import { readStdinJson, writeJson, failOpen, logDebug, pluginRuntimeFile, resolveHookCwd } from "../lib/hook-io.js";
import { appendTelemetry } from "../lib/telemetry.js";

try {
  const payload = await readStdinJson();
  const cwd = resolveHookCwd(payload);
  const normalized = { ...payload, cwd };
  logDebug("SessionStart", normalized);
  appendTelemetry({ telemetryPath: pluginRuntimeFile("telemetry.jsonl", cwd), event: "SessionStart", payload: normalized });
  writeJson({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart"
    }
  });
} catch (error) {
  failOpen("SessionStart", error, {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart"
    }
  });
}
