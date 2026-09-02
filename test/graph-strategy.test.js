import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectGraphStrategy, embedCodeReviewGraph, formatCodeReviewGraphEmbedding, formatGraphStrategy } from "../plugins/ctx/lib/graph-strategy.js";

describe("graph strategy", () => {
  it("detects code-review-graph databases", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-graph-strategy-"));
    fs.mkdirSync(path.join(cwd, ".code-review-graph"));
    fs.writeFileSync(path.join(cwd, ".code-review-graph", "graph.db"), "");

    const result = detectGraphStrategy({ cwd, pathEnv: "" });

    expect(result).toEqual({
      strategy: "code-review-graph",
      codeReviewGraph: true,
      codegraph: false
    });
    expect(formatGraphStrategy(result)).toBe("code-review-graph (code-review-graph)");
  });

  it("reports pending hybrid strategy when codegraph is configured", () => {
    const result = detectGraphStrategy({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-hybrid-strategy-")),
      pathEnv: "",
      mcpServerNames: ["code-review-graph", "codegraph"]
    });

    expect(result.strategy).toBe("hybrid-adapter-pending");
  });

  it("skips graph embeddings when no graph index exists", () => {
    const result = embedCodeReviewGraph({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-graph-embed-missing-"))
    });

    expect(result).toEqual({ status: "skipped", reason: "missing-graph-index" });
    expect(formatCodeReviewGraphEmbedding(result)).toContain("no .code-review-graph/graph.db");
  });

  it("embeds an existing code-review-graph index during install warmup", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-graph-embed-"));
    fs.mkdirSync(path.join(cwd, ".code-review-graph"));
    fs.writeFileSync(path.join(cwd, ".code-review-graph", "graph.db"), "");

    const result = embedCodeReviewGraph({
      cwd,
      python: process.execPath,
      run: () => JSON.stringify({ newly_embedded: 12, total_embeddings: 34 })
    });

    expect(result).toEqual({
      status: "embedded",
      newlyEmbedded: 12,
      totalEmbeddings: 34
    });
    expect(formatCodeReviewGraphEmbedding(result)).toBe("34 nodes (12 new)");
  });
});
