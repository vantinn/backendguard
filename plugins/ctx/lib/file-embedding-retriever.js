import fs from "node:fs";
import path from "node:path";
import { isModelCacheReady, listIndexedEmbeddingItems, searchIndexedEmbeddings, warmIndexedEmbeddings } from "./embedding-scorer.js";
import { rebuildImportGraphIndex } from "./import-graph.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql", ".md", ".json"
]);
const IGNORE_DIRS = new Set([
  ".git", ".next", ".turbo", "coverage", "dist", "build", "node_modules", "vendor"
]);
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_MAX_FILES = 1200;

export async function findEmbeddingRelevantFiles({
  cwd = process.cwd(),
  task = "",
  dataDir,
  limit = 10,
  timeoutMs = Number(process.env.BACKENDGUARD_FILE_EMBEDDING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  maxFiles = Number(process.env.BACKENDGUARD_FILE_EMBEDDING_MAX_FILES || DEFAULT_MAX_FILES),
  embeddingOptions = {},
  indexedSearcher = searchIndexedEmbeddings
} = {}) {
  if (process.env.BACKENDGUARD_FILE_EMBEDDINGS === "0") return [];
  if (!dataDir) return [];
  if (!String(task || "").trim()) return [];

  const result = await indexedSearcher({
    kind: fileIndexKind(cwd),
    task,
    dataDir,
    timeoutMs,
    allowRemote: false,
    ...embeddingOptions
  });

  if (result.status !== "enabled") return [];

  return result.items
    .filter((rule) => Number(rule.embeddingScore || 0) >= 0.45)
    .sort((a, b) => Number(b.embeddingScore || 0) - Number(a.embeddingScore || 0) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((rule) => ({
      path: rule.id,
      score: Math.round(Number(rule.embeddingScore || 0) * 10),
      source: "embedding",
      reasons: [`file-embedding:${Number(rule.embeddingScore || 0).toFixed(2)}`]
    }));
}

export async function findIndexedFileTextMatches({
  cwd = process.cwd(),
  task = "",
  dataDir,
  limit = 10,
  indexedLister = listIndexedEmbeddingItems
} = {}) {
  if (!dataDir || !String(task || "").trim()) return [];
  const result = await indexedLister({ kind: fileIndexKind(cwd), dataDir });
  if (result.status !== "enabled" || !result.items.length) return [];
  const queryTokens = meaningfulTokens(task);
  if (!queryTokens.length) return [];
  return result.items
    .map((item) => {
      const haystack = `${item.id || ""} ${item.text || ""}`.toLowerCase();
      const matches = queryTokens.filter((token) => haystack.includes(token));
      const basename = path.basename(String(item.id || "")).toLowerCase();
      const basenameMatches = queryTokens.filter((token) => basename.includes(token));
      const score = matches.length * 4 + basenameMatches.length * 3;
      return {
        path: item.id,
        score,
        source: "indexed-file-text",
        reasons: matches.length ? [`indexed-file-text:${matches.slice(0, 5).join(",")}`] : []
      };
    })
    .filter((item) => item.path && item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export async function warmFileEmbeddings({
  cwd = process.cwd(),
  dataDir,
  allowRemote = true,
  maxFiles = Number(process.env.BACKENDGUARD_FILE_EMBEDDING_MAX_FILES || DEFAULT_MAX_FILES)
} = {}) {
  if (!dataDir) return { count: 0, cachePath: null };
  if (!allowRemote && !isModelCacheReady(dataDir)) return { count: 0, cachePath: null, status: "missing-model" };
  const files = listSourceFiles(cwd, { maxFiles });
  rebuildImportGraphIndex({ cwd, files, dataDir });
  const items = files.map((filePath) => ({ id: filePath, text: fileSearchText(filePath) }));
  return warmIndexedEmbeddings({
    kind: fileIndexKind(cwd),
    items,
    task: "project file semantic retrieval",
    dataDir,
    sources: [path.join(cwd, "AGENTS.md")],
    allowRemote
  });
}

function fileIndexKind(cwd) {
  return `file:${path.resolve(cwd)}`;
}

function meaningfulTokens(value) {
  const stop = new Set(["the", "and", "for", "with", "this", "that", "task", "implement", "create", "update", "fix", "can", "not", "see", "any", "why", "allways", "always", "app", "src", "page"]);
  return [...new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, " ")
    .split(/\s+/)
    .flatMap((token) => token.split(/[\\/._-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token)))];
}

function listSourceFiles(cwd, { maxFiles }) {
  const files = [];
  walkFiles(cwd, (filePath) => {
    if (files.length >= maxFiles) return;
    files.push(path.relative(cwd, filePath));
  });
  return files;
}

function walkFiles(directory, onFile, depth = 0) {
  if (depth > 7) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, onFile, depth + 1);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      onFile(fullPath);
    }
  }
}

function fileSearchText(filePath) {
  const normalized = String(filePath || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[._/-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${filePath} ${normalized}`;
}
