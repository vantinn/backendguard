import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CRG_PYTHON = path.join(
  os.homedir(),
  ".local/share/pipx/venvs/code-review-graph/bin/python"
);

export function detectGraphStrategy({
  cwd = process.cwd(),
  pathEnv = process.env.PATH || "",
  mcpServerNames = []
} = {}) {
  const serverNames = new Set(mcpServerNames);
  const codeReviewGraph = fs.existsSync(path.join(cwd, ".code-review-graph", "graph.db"))
    || hasExecutable("code-review-graph", pathEnv)
    || serverNames.has("code-review-graph");
  const codegraph = hasExecutable("codegraph", pathEnv)
    || serverNames.has("codegraph");

  const strategy = codeReviewGraph && codegraph
    ? "hybrid-adapter-pending"
    : codegraph
      ? "codegraph-detected-adapter-pending"
      : codeReviewGraph
        ? "code-review-graph"
        : "none";

  return { strategy, codeReviewGraph, codegraph };
}

export function formatGraphStrategy(result) {
  const detected = [
    result.codeReviewGraph ? "code-review-graph" : null,
    result.codegraph ? "codegraph" : null
  ].filter(Boolean);
  return `${result.strategy}${detected.length ? ` (${detected.join(", ")})` : ""}`;
}

export function embedCodeReviewGraph({
  cwd = process.cwd(),
  python = process.env.BACKENDGUARD_CRG_PYTHON || DEFAULT_CRG_PYTHON,
  run = execFileSync
} = {}) {
  if (!fs.existsSync(path.join(cwd, ".code-review-graph", "graph.db"))) {
    return { status: "skipped", reason: "missing-graph-index" };
  }
  if (!fs.existsSync(python)) {
    return { status: "skipped", reason: "missing-code-review-graph-python" };
  }

  const script = `
import json

from code_review_graph.tools.docs import embed_graph

print(json.dumps(embed_graph(repo_root=${JSON.stringify(cwd)}, provider="local")))
`;

  try {
    const output = run(python, ["-c", script], {
      cwd,
      encoding: "utf8",
      timeout: Number(process.env.BACKENDGUARD_CRG_EMBED_TIMEOUT_MS || 120_000),
      env: {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(os.tmpdir(), "backendguard-mpl")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const response = JSON.parse(output || "{}");
    return {
      status: "embedded",
      newlyEmbedded: Number(response.newly_embedded || 0),
      totalEmbeddings: Number(response.total_embeddings || response.embeddings_count || 0)
    };
  } catch (error) {
    return {
      status: "skipped",
      reason: "embed-failed",
      error: String(error.stderr || error.message || error).trim().slice(0, 200)
    };
  }
}

export function formatCodeReviewGraphEmbedding(result) {
  if (result.status === "embedded") {
    return `${result.totalEmbeddings} nodes (${result.newlyEmbedded} new)`;
  }
  if (result.reason === "missing-graph-index") return "skipped (no .code-review-graph/graph.db)";
  if (result.reason === "missing-code-review-graph-python") return "skipped (code-review-graph Python unavailable)";
  if (result.reason === "remote-embedding-disabled") return "skipped (remote embedding disabled)";
  return `skipped (${result.error || result.reason || "unavailable"})`;
}

function hasExecutable(command, pathEnv) {
  return String(pathEnv || "").split(path.delimiter).some((directory) => {
    if (!directory) return false;
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
