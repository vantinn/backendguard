import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTelemetryEvent, loadRuntimeEvidence } from "../plugins/ctx/lib/telemetry.js";

describe("telemetry", () => {
  it("extracts tool and command signals from hook payloads", () => {
    const event = buildTelemetryEvent({
      event: "ToolCall",
      at: new Date("2026-01-01T00:00:00.000Z"),
      payload: {
        cwd: "/repo",
        toolName: "code-review-graph.semantic_search_nodes",
        command: "code-review-graph query_graph"
      }
    });

    expect(event.cwd).toBe("/repo");
    expect(event.signals).toContain("code-review-graph");
    expect(event.toolSignals).toContain("code-review-graph.semantic_search_nodes");
    expect(event.commandSignals).toContain("code-review-graph query_graph");
  });

  it("loads only matching runtime evidence for cwd and time window", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-telemetry-"));
    const telemetryPath = path.join(tmp, "telemetry.jsonl");
    fs.writeFileSync(telemetryPath, [
      JSON.stringify({
        at: "2025-12-31T23:59:59.000Z",
        event: "ToolCall",
        cwd: tmp,
        signals: ["agentmemory"],
        toolSignals: ["agentmemory.search"],
        commandSignals: []
      }),
      JSON.stringify({
        at: "2026-01-01T00:00:01.000Z",
        event: "ToolCall",
        cwd: tmp,
        signals: ["code-review-graph"],
        toolSignals: ["code-review-graph.query_graph"],
        commandSignals: []
      }),
      JSON.stringify({
        at: "2026-01-01T00:00:02.000Z",
        event: "ToolCall",
        cwd: "/other",
        signals: ["detect_changes"],
        toolSignals: ["detect_changes"],
        commandSignals: []
      })
    ].join("\n"));

    const evidence = loadRuntimeEvidence({
      telemetryPath,
      since: "2026-01-01T00:00:00.000Z",
      cwd: tmp
    });

    expect(evidence.signals).toEqual(["code-review-graph"]);
    expect(evidence.toolSignals).toEqual(["code-review-graph.query_graph"]);
    expect(evidence.sources).toHaveLength(1);
  });
});
