import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { appendTelemetry } from "./telemetry.js";
import { workspaceDataDir } from "./workspace-data.js";

const DEFAULT_TIMEOUT_MS = 80;
const MAX_GRAPH_QUERIES = 10;
const DEFAULT_CRG_PYTHON = path.join(
  os.homedir(),
  ".local/share/pipx/venvs/code-review-graph/bin/python"
);

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "before", "cho", "for", "from", "into", "khi", "must",
  "not", "the", "then", "this", "that", "trong", "use", "using", "with"
]);

export function hasGraphIndex(cwd = process.cwd()) {
  return fs.existsSync(path.join(cwd, ".code-review-graph", "graph.db"));
}

export function findGraphRelevantFiles({
  cwd = process.cwd(),
  task = "",
  rules = [],
  seedFiles = [],
  limit = 6,
  timeoutMs = Number(process.env.BACKENDGUARD_GRAPH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  python = process.env.BACKENDGUARD_CRG_PYTHON || DEFAULT_CRG_PYTHON,
  telemetryPath,
  graphSearch = runCodeReviewGraphSearch,
  appendTelemetryEvent = appendTelemetry
} = {}) {
  if (process.env.BACKENDGUARD_GRAPH_RETRIEVAL === "0") return [];
  if (!hasGraphIndex(cwd)) return [];

  if (!fs.existsSync(python)) return [];

  const queries = buildGraphQueries({ task, rules, seedFiles });
  if (!queries.length) return [];

  try {
    const raw = graphSearch({ cwd, python, queries, limit, timeoutMs });
    const files = mergeGraphResults({ cwd, results: raw, limit });
    recordGraphRetrievalTelemetry({
      cwd,
      telemetryPath,
      appendTelemetryEvent,
      queryCount: queries.length,
      resultCount: files.length,
      status: "ok"
    });
    return files;
  } catch (error) {
    recordGraphRetrievalTelemetry({
      cwd,
      telemetryPath,
      appendTelemetryEvent,
      queryCount: queries.length,
      resultCount: 0,
      status: "error",
      error
    });
    return [];
  }
}

export function runCodeReviewGraphSearch({ cwd, python, queries, limit, timeoutMs }) {
  const script = `
import json
import sys

from code_review_graph.tools.query import semantic_search_nodes

payload = json.loads(sys.stdin.read() or "{}")
repo_root = payload.get("repoRoot")
queries = payload.get("queries") or []
limit = int(payload.get("limit") or 8)
seen = set()
results = []

for query in queries:
    try:
        response = semantic_search_nodes(
            query=query,
            repo_root=repo_root,
            detail_level="minimal",
            limit=limit,
        )
    except Exception:
        continue

    for item in response.get("results", []) or []:
        file_path = item.get("file_path") or item.get("path")
        if not file_path:
            continue
        key = (file_path, query)
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "path": file_path,
            "query": query,
            "name": item.get("name"),
            "kind": item.get("kind"),
            "score": item.get("score"),
        })

print(json.dumps(results))
`;

  const output = execFileSync(python, ["-c", script], {
    cwd,
    input: JSON.stringify({ repoRoot: cwd, queries, limit }),
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(os.tmpdir(), "backendguard-mpl")
    },
    stdio: ["pipe", "pipe", "ignore"]
  });
  return JSON.parse(output || "[]");
}

export function recordGraphRetrievalTelemetry({
  cwd,
  telemetryPath,
  appendTelemetryEvent = appendTelemetry,
  queryCount = 0,
  resultCount = 0,
  status,
  error
}) {
  try {
    appendTelemetryEvent({
      telemetryPath: telemetryPath || path.join(workspaceDataDir({ cwd }), "telemetry.jsonl"),
      event: "InternalGraphRetrieval",
      payload: {
        cwd,
        source: "graph-retriever",
        method: "internal",
        ...(status === "ok"
          ? {
            mcp: "code-review-graph",
            toolName: "code-review-graph.semantic_search_nodes"
          }
          : {})
      },
      extra: {
        source: "graph-retriever",
        backend: "code-review-graph",
        method: "internal",
        status,
        queryCount,
        resultCount,
        ...(error ? { error: String(error.message || error).slice(0, 200) } : {})
      }
    });
  } catch {
    // Graph retrieval must remain fail-open when telemetry storage is unavailable.
  }
}

export function buildGraphQueries({ task = "", rules = [], seedFiles = [], maxQueries = MAX_GRAPH_QUERIES } = {}) {
  const queries = [];
  addQuery(queries, task);

  for (const file of seedFiles.slice(0, 5)) {
    const filePath = file.path || "";
    const basename = path.basename(filePath).replace(/\.[^.]+$/, "");
    addQuery(queries, basename);
  }

  const topRules = seedFiles.length ? [] : [...rules]
    .filter((rule) => Number(rule.score || 0) >= 0.1)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 4);

  for (const rule of topRules) {
    const content = rule.content || "";
    for (const identifier of extractIdentifiers(content)) addQuery(queries, identifier);

    const terms = extractTerms(content);
    for (const phrase of importantPhrases(terms)) addQuery(queries, phrase);
  }

  return queries.slice(0, maxQueries);
}

export function mergeRelevantFiles({ graphFiles = [], heuristicFiles = [], limit = 3 } = {}) {
  const byPath = new Map();
  for (const file of heuristicFiles) {
    if (!file?.path) continue;
    byPath.set(file.path, {
      ...file,
      source: file.source || "heuristic",
      reasons: [...new Set(file.reasons || [])]
    });
  }

  for (const file of graphFiles) {
    if (!file?.path) continue;
    const existing = byPath.get(file.path);
    const reasons = [...new Set([...(file.reasons || []), ...(existing?.reasons || [])])];
    byPath.set(file.path, {
      ...existing,
      ...file,
      source: "graph",
      score: 100 + Number(file.score || 0) * 10 + Number(existing?.score || 0),
      reasons
    });
  }

  return [...byPath.values()]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function mergeGraphResults({ cwd, results, limit }) {
  const byPath = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const normalized = normalizeRepoPath(cwd, result.path);
    if (!normalized) continue;

    const existing = byPath.get(normalized) || {
      path: normalized,
      score: 0,
      source: "graph",
      reasons: []
    };
    existing.score += 1 + Number(result.score || 0);
    existing.reasons.push(`graph:${result.query}`);
    byPath.set(normalized, existing);
  }

  return [...byPath.values()]
    .map((file) => ({ ...file, reasons: [...new Set(file.reasons)] }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function normalizeRepoPath(cwd, filePath) {
  const normalized = path.normalize(String(filePath || ""));
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) {
    const relative = path.relative(cwd, normalized);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative;
  }
  return normalized.startsWith("..") ? null : normalized;
}

function addQuery(queries, value) {
  const query = String(value || "").trim();
  if (query.length < 3) return;
  if (queries.some((existing) => existing.toLowerCase() === query.toLowerCase())) return;
  queries.push(query);
}

function extractIdentifiers(value) {
  const identifiers = [];
  const text = String(value || "");
  const patterns = [
    /`([^`]+)`/g,
    /\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g,
    /\b[a-z0-9]+(?:[-_.][a-z0-9]+)+\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) identifiers.push(match[1] || match[0]);
  }
  return identifiers;
}

function extractTerms(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 2 && !QUERY_STOP_WORDS.has(term));
}

function importantPhrases(terms) {
  const phrases = [];
  for (let index = 0; index < terms.length - 1; index += 1) {
    phrases.push(`${terms[index]} ${terms[index + 1]}`);
  }
  return phrases.slice(0, 4);
}
