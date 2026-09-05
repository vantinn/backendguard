import fs from "node:fs";
import path from "node:path";

import { findGraphRelevantFiles, mergeRelevantFiles } from "./graph-retriever.js";
import { expandImportGraph } from "./import-graph.js";
import { findEmbeddingRelevantFiles, findIndexedFileTextMatches } from "./file-embedding-retriever.js";
import { tokenize } from "../rules/rule-engine.js";
import { workspacePackagePaths } from "../analysis/project-profiler.js";

/**
 * Task-aware file retrieval.
 *
 * Given a task, this decides which files in the repository the agent should be
 * looking at. It used to live inside the rule engine, which conflated two
 * separate jobs: scoring written rules against a task, and finding source files
 * relevant to it. They share only the tokenizer.
 *
 * Candidates come from several independent signals — paths named in the prompt,
 * filenames named in the prompt, module neighbours, project manifests, an
 * embedding index, the import graph, and an optional code-graph MCP server —
 * and are merged by score. Each signal contributes a `reasons` entry so a
 * retrieval result can always be explained.
 */

export async function findRelevantFiles({
  cwd = process.cwd(),
  task = "",
  rules = [],
  dataDir,
  limit = 3,
  embeddingFileFinder = findEmbeddingRelevantFiles,
  fileEmbeddingTimeoutMs,
  fileEmbeddingOptions = {},
  indexedFileTextFinder = findIndexedFileTextMatches
} = {}) {
  if (!String(task || "").trim()) return [];

  const retrievalTask = expandFileRetrievalTask(task);
  const explicitFiles = findExplicitPromptFiles({ cwd, task, limit: Math.max(limit * 2, 6) });
  const promptContextFiles = findPromptContextFiles({ cwd, task, explicitFiles, limit: Math.max(limit * 3, 9) });
  const manifestFiles = findProjectManifestFiles({ cwd, task, limit: Math.max(limit * 2, 6) });
  const embeddingFiles = await embeddingFileFinder({
    cwd,
    task: retrievalTask,
    dataDir,
    timeoutMs: fileEmbeddingTimeoutMs,
    embeddingOptions: fileEmbeddingOptions,
    limit: Math.max(limit * 2, 6)
  });
  const indexedTextFiles = fileEmbeddingOptions?.enabled === false
    ? await indexedFileTextFinder({
      cwd,
      task: retrievalTask,
      dataDir,
      limit: Math.max(limit * 2, 6)
    })
    : [];
  const importGraphFiles = expandImportGraph({
    cwd,
    seedFiles: [...explicitFiles, ...promptContextFiles, ...manifestFiles, ...embeddingFiles, ...indexedTextFiles].slice(0, limit),
    dataDir,
    limit: Math.max(limit * 2, 6)
  });
  const seedFiles = mergeLocalFileCandidates([...explicitFiles, ...promptContextFiles, ...manifestFiles, ...embeddingFiles, ...indexedTextFiles, ...importGraphFiles])
    .slice(0, Math.max(limit * 3, 9));

  const graphFiles = findGraphRelevantFiles({
    cwd,
    task: retrievalTask,
    rules,
    seedFiles,
    limit: Math.max(limit * 2, 6)
  });

  return mergeRelevantFiles({ graphFiles, heuristicFiles: seedFiles, limit });
}

export function findProjectManifestFiles({ cwd = process.cwd(), task = "", limit = 6 } = {}) {
  const tokens = new Set(tokenize(task));
  if (!isManifestRelevantTask(tokens)) return [];
  const manifests = workspacePackageManifests(cwd, tokens);
  return manifests.slice(0, limit).map((filePath, index) => ({
    path: filePath,
    score: manifestScore(filePath, tokens, index),
    source: "manifest",
    reasons: ["project-manifest"]
  }));
}

function manifestScore(manifest, taskTokens, index) {
  if (manifest === "package.json") return 50;
  const parts = manifest.split(/[\\/]+/).filter(Boolean);
  const workspaceName = parts.at(-2);
  return (taskTokens.has(workspaceName) ? 35 : 20) - index * 0.01;
}

function isManifestRelevantTask(tokens) {
  const runIntent = ["run", "start", "connect", "qr", "install", "build", "script", "scripts"].some((token) => tokens.has(token));
  const projectIntent = ["webapp", "frontend", "expo", "native", "app", "package", "workspace"].some((token) => tokens.has(token));
  return runIntent && projectIntent;
}

function workspacePackageManifests(cwd, taskTokens = new Set()) {
  const rootManifest = path.join(cwd, "package.json");
  const manifests = [];
  if (fs.existsSync(rootManifest)) manifests.push("package.json");
  const rootPackage = readJson(rootManifest);
  for (const pattern of workspacePatterns(rootPackage?.workspaces)) {
    for (const manifest of expandWorkspacePattern({ cwd, pattern })) {
      manifests.push(path.relative(cwd, manifest));
    }
  }
  return [...new Set(manifests)].sort((a, b) => manifestPriority(b, taskTokens) - manifestPriority(a, taskTokens) || a.localeCompare(b));
}

function manifestPriority(manifest, taskTokens) {
  if (manifest === "package.json") return 100;
  const parts = manifest.split(/[\\/]+/).filter(Boolean);
  const workspaceName = parts.at(-2);
  return taskTokens.has(workspaceName) ? 80 : 0;
}

function workspacePatterns(workspaces) {
  if (Array.isArray(workspaces)) return workspaces.filter((item) => typeof item === "string");
  if (Array.isArray(workspaces?.packages)) return workspaces.packages.filter((item) => typeof item === "string");
  return [];
}

function expandWorkspacePattern({ cwd, pattern }) {
  const normalized = String(pattern || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return [];
  if (!normalized.includes("*")) {
    const manifest = path.join(cwd, normalized, "package.json");
    return fs.existsSync(manifest) ? [manifest] : [];
  }
  const parts = normalized.split("/");
  const starIndex = parts.indexOf("*");
  if (starIndex < 0 || parts.includes("**")) return [];
  const baseDir = path.join(cwd, ...parts.slice(0, starIndex));
  const suffix = parts.slice(starIndex + 1);
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(baseDir, entry.name, ...suffix, "package.json"))
    .filter((manifest) => fs.existsSync(manifest));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Backend domain vocabulary used to widen a task before it reaches the
 * embedding index.
 *
 * A developer writes "purchase flow" while the code says `payment`, `checkout`
 * or `invoice`; a lexical index finds neither from the other. These groups are
 * *generic backend concepts*, not one project's module names — an earlier
 * version of this table hardcoded a specific customer's services
 * (`content-access-service`, `tutorials`, `collections`), which biased
 * retrieval in every other repository toward vocabulary it did not contain.
 *
 * Each group is symmetric: matching any term adds the whole group.
 */
export const DOMAIN_VOCABULARY = [
  ["purchase", "buy", "buyer", "seller", "payment", "pay", "checkout", "billing", "invoice", "order", "transaction", "refund"],
  ["wallet", "balance", "credit", "topup", "ledger", "payout"],
  ["auth", "authentication", "login", "signin", "signup", "register", "session", "token", "credential"],
  ["authorization", "permission", "role", "rbac", "policy", "guard", "access control"],
  ["notification", "notify", "email", "sms", "push", "webhook"],
  ["cache", "caching", "redis", "ttl", "invalidation", "eviction"],
  ["queue", "job", "worker", "background", "scheduler", "cron", "consumer"],
  ["upload", "file", "attachment", "storage", "media", "asset"],
  ["migration", "schema", "index", "constraint", "column", "table"],
  ["pagination", "paginate", "cursor", "offset", "limit", "page size"]
];

const VOCABULARY_INDEX = buildVocabularyIndex(DOMAIN_VOCABULARY);

function buildVocabularyIndex(groups) {
  const index = new Map();
  for (const group of groups) {
    for (const term of group) {
      // A term may sit in several groups (e.g. "token"); collect them all.
      const existing = index.get(term) || [];
      index.set(term, [...existing, group]);
    }
  }
  return index;
}

/**
 * @returns {string} the task, with a short related-terms line appended when the
 *   task matched a known backend concept. The line is marked so a reader of the
 *   retrieval log can tell which terms came from the user and which were added.
 */
export function expandFileRetrievalTask(task) {
  const tokens = new Set(tokenize(task));
  // "notifications" and "notification" are the same concept to a developer;
  // the tokenizer keeps them distinct, so fold simple plurals here rather than
  // listing both forms of every term in the table.
  const lookupKeys = new Set();
  for (const token of tokens) {
    lookupKeys.add(token);
    if (token.endsWith("s") && token.length > 3) lookupKeys.add(token.slice(0, -1));
  }
  const additions = new Set();
  for (const key of lookupKeys) {
    for (const group of VOCABULARY_INDEX.get(key) || []) {
      for (const term of group) if (!tokens.has(term) && !lookupKeys.has(term)) additions.add(term);
    }
  }
  if (!additions.size) return task;
  return `${task}\n\nRelated backend terms: ${[...additions].join(", ")}`;
}

/**
 * The longest token still worth testing as a path. PATH_MAX is 4096 on Linux
 * and 1024 on macOS; anything longer is not a filename, and letting it reach
 * the matcher is what made a pasted blob expensive.
 */
const MAX_PATH_TOKEN_LENGTH = 4096;

const PATH_SEGMENT = /[A-Za-z0-9_.()[\]@~:,-]+(?:\/[A-Za-z0-9_.()[\]@~:,-]+)+/g;

/**
 * Path-like tokens mentioned in the prompt.
 *
 * The matcher is applied per whitespace-delimited token rather than to the
 * whole prompt. `PATH_SEGMENT` is `X+(?:/X+)+`, and on a long run of `X` that
 * contains no `/` — a base64 blob, a minified line, a pasted stack trace — the
 * engine backtracks over every split point. That is quadratic: a 200KB prompt
 * took ~32s, and this runs on *every* message the user sends to their agent.
 *
 * Splitting first is exact, not an approximation: the character class excludes
 * whitespace, so no match could ever have spanned a space. Tokens without a
 * `/` cannot match at all, and tokens longer than a path are not paths.
 */
function promptPathTokens(normalizedTask) {
  const matches = [];
  for (const token of normalizedTask.split(/\s+/)) {
    if (!token || token.length > MAX_PATH_TOKEN_LENGTH || !token.includes("/")) continue;
    PATH_SEGMENT.lastIndex = 0;
    const found = token.match(PATH_SEGMENT);
    if (found) matches.push(...found);
  }
  return matches;
}

export function findExplicitPromptFiles({ cwd = process.cwd(), task = "", limit = 6 } = {}) {
  const candidates = new Set();
  const normalizedTask = String(task || "").replace(/\/\s+/g, "/");
  const matches = promptPathTokens(normalizedTask);
  for (const match of matches) {
    const cleaned = cleanPromptFilePath(match);
    for (const filePath of resolvePromptPathCandidates({ cwd, promptPath: cleaned })) {
      candidates.add(filePath);
      if (candidates.size >= limit) break;
    }
    if (candidates.size >= limit) break;
  }
  return [...candidates].map((filePath, index) => ({
    path: filePath,
    score: 1000 - index * 0.01,
    source: "prompt-path",
    reasons: ["explicit-path-mentioned"]
  }));
}

export function findPromptContextFiles({ cwd = process.cwd(), task = "", explicitFiles = [], limit = 9 } = {}) {
  const files = [];
  files.push(...findPromptBasenameFiles({ cwd, task, limit }));
  files.push(...findModuleNeighborFiles({ cwd, task, seeds: [...explicitFiles, ...files], limit }));
  files.push(...findSchemaHintFiles({ cwd, task }));
  return mergeLocalFileCandidates(files).slice(0, limit);
}

function findPromptBasenameFiles({ cwd, task, limit }) {
  const basenames = extractPromptBasenames(task);
  if (!basenames.length) return [];
  const files = [];
  for (const basename of basenames) {
    for (const filePath of findFilesByBasename({ cwd, basename, limit: Math.max(limit, 12) })) {
      files.push({
        path: filePath,
        score: routeControllerScore(filePath, task) + 900,
        source: "prompt-filename",
        reasons: ["explicit-filename-mentioned"]
      });
      if (files.length >= limit) return files;
    }
  }
  return files;
}

function findModuleNeighborFiles({ cwd, task, seeds = [], limit }) {
  const moduleRoots = [...new Set(seeds.map((file) => moduleRootFromPath(file.path)).filter(Boolean))];
  const files = [];
  for (const moduleRoot of moduleRoots) {
    const absoluteRoot = path.join(cwd, moduleRoot);
    for (const filePath of findModuleFiles({ cwd, root: absoluteRoot, task, limit: Math.max(limit, 12) })) {
      files.push({
        path: filePath,
        score: moduleNeighborScore(filePath, task),
        source: "module-neighbor",
        reasons: ["same-module"]
      });
      if (files.length >= limit) return files;
    }
  }
  return files;
}

function findSchemaHintFiles({ cwd, task }) {
  if (!/\b(status|startTime|endTime|proposedStartTime|proposedEndTime|schema|prisma|enum)\b/i.test(task)) return [];
  const files = [];
  for (const schemaPath of ["prisma/schema.prisma", "schema.prisma"]) {
    const absolute = path.join(cwd, schemaPath);
    if (isSourceFile(absolute)) {
      files.push({
        path: schemaPath,
        score: 820,
        source: "schema-hint",
        reasons: ["status-time-fields-mentioned"]
      });
    }
  }
  for (const packagePath of workspacePackagePaths(cwd).slice(1)) {
    const packageDir = path.dirname(packagePath);
    const absolute = path.join(packageDir, "prisma", "schema.prisma");
    if (isSourceFile(absolute)) {
      files.push({
        path: path.relative(cwd, absolute),
        score: 820,
        source: "schema-hint",
        reasons: ["status-time-fields-mentioned"]
      });
    }
  }
  for (const filePath of findFilesByBasename({ cwd, basename: "schema.prisma", limit: 6 })) {
    files.push({
      path: filePath,
      score: 820,
      source: "schema-hint",
      reasons: ["status-time-fields-mentioned"]
    });
  }
  return files;
}

function cleanPromptFilePath(value) {
  return String(value || "")
    .replace(/\.(tsx?|jsx?|mjs|cjs|json|md|sql|py)\(\d+(?:,\d+)?\)[),.;:]*$/i, ".$1")
    .replace(/\.(tsx?|jsx?|mjs|cjs|json|md|sql|py):\d+(?::\d+)?[),.;:]*$/i, ".$1")
    .replace(/[),.;:]+$/g, "");
}

function resolvePromptPathCandidates({ cwd, promptPath }) {
  if (!promptPath || promptPath.includes("://")) return [];
  const relative = promptPath.replace(/^\.?\//, "");
  if (relative.startsWith("..")) return [];
  const absolute = path.resolve(cwd, relative);
  if (!isInsidePath(absolute, cwd)) return [];
  const resolved = [];
  if (isSourceFile(absolute)) resolved.push(path.relative(cwd, absolute));
  if (isDirectory(absolute)) {
    for (const fileName of ["page.tsx", "page.ts", "page.jsx", "page.js", "layout.tsx", "index.tsx", "index.ts"]) {
      const candidate = path.join(absolute, fileName);
      if (isSourceFile(candidate)) resolved.push(path.relative(cwd, candidate));
    }
  }
  if (!path.extname(relative)) {
    for (const extension of [".tsx", ".ts", ".jsx", ".js", ".md", ".json"]) {
      const candidate = `${absolute}${extension}`;
      if (isSourceFile(candidate)) resolved.push(path.relative(cwd, candidate));
    }
  }
  if (!resolved.length && !relative.startsWith("..")) {
    for (const packagePath of workspacePackagePaths(cwd).slice(1)) {
      const packageDir = path.dirname(packagePath);
      const candidate = path.join(packageDir, relative);
      if (isSourceFile(candidate)) resolved.push(path.relative(cwd, candidate));
    }
  }
  return resolved;
}

function extractPromptBasenames(task = "") {
  const matches = String(task || "").match(/\b[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|sql|py|prisma)\b/g) || [];
  return [...new Set(matches.map((match) => path.basename(cleanPromptFilePath(match))))];
}

function findFilesByBasename({ cwd, basename, limit }) {
  const results = [];
  boundedWalk(cwd, {
    maxDepth: 9,
    maxEntries: 6000,
    onFile: (filePath) => {
      if (path.basename(filePath) !== basename) return;
      results.push(path.relative(cwd, filePath));
      return results.length >= limit;
    }
  });
  return results.sort((a, b) => filePathPriority(b) - filePathPriority(a) || a.localeCompare(b)).slice(0, limit);
}

function moduleRootFromPath(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const match = normalized.match(/^(.*?src\/modules\/[^/]+)/);
  if (match) return match[1];
  const nestMatch = normalized.match(/^(.*?modules\/[^/]+)/);
  return nestMatch?.[1] || null;
}

function findModuleFiles({ cwd, root, task, limit }) {
  const results = [];
  boundedWalk(root, {
    maxDepth: 8,
    maxEntries: 1000,
    onFile: (filePath) => {
      const relative = path.relative(cwd, filePath);
      if (!isRelevantModuleNeighbor(relative, task)) return;
      results.push(relative);
      return results.length >= limit;
    }
  });
  return results.sort((a, b) => moduleNeighborScore(b, task) - moduleNeighborScore(a, task) || a.localeCompare(b)).slice(0, limit);
}

function isRelevantModuleNeighbor(filePath, task) {
  const value = String(filePath || "").toLowerCase();
  if (/\.(spec|test)\./.test(value)) return true;
  if (/(controller|service|module|repository|resolver|handler|guard|dto|schema|mapper|presenter)\.(tsx?|jsx?)$/.test(value)) return true;
  if (/\/dto\/.*\.(tsx?|jsx?)$/.test(value)) return true;
  if (promptHasHttpRoute(task) && /\.(controller|module)\.(tsx?|jsx?)$/.test(value)) return true;
  return false;
}

function moduleNeighborScore(filePath, task) {
  const value = String(filePath || "").toLowerCase();
  let score = 580;
  if (/\.controller\.(tsx?|jsx?)$/.test(value)) score += 80;
  if (/\.service\.(tsx?|jsx?)$/.test(value)) score += 70;
  if (/\.module\.(tsx?|jsx?)$/.test(value)) score += 60;
  if (/\/dto\/|\.dto\./.test(value)) score += 45;
  if (/\.repository\./.test(value)) score += 35;
  if (/\.spec\.|\.test\./.test(value)) score += 20;
  score += routeControllerScore(filePath, task);
  return score;
}

function routeControllerScore(filePath, task) {
  const value = String(filePath || "").toLowerCase();
  let score = 0;
  if (promptHasHttpRoute(task) && /\.controller\.(tsx?|jsx?)$/.test(value)) score += 120;
  if (promptHasHttpRoute(task) && /\.module\.(tsx?|jsx?)$/.test(value)) score += 40;
  return score;
}

function promptHasHttpRoute(task = "") {
  return /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\/[^\s`'")]+/i.test(task);
}

function filePathPriority(filePath = "") {
  const value = String(filePath || "").toLowerCase();
  let priority = 0;
  if (/\/src\//.test(value)) priority += 20;
  if (/\/modules\//.test(value)) priority += 20;
  if (/\.controller\./.test(value)) priority += 15;
  if (/\.service\./.test(value)) priority += 10;
  if (/\.module\./.test(value)) priority += 8;
  if (/\/node_modules\/|\/dist\/|\/build\/|\/coverage\/|\/\.next\//.test(value)) priority -= 100;
  return priority;
}

function boundedWalk(directory, { maxDepth, maxEntries, onFile }, depth = 0, state = { entries: 0, done: false }) {
  if (state.done || depth > maxDepth || state.entries >= maxEntries) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.done || state.entries >= maxEntries) return;
    if (shouldSkipSearchEntry(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    state.entries += 1;
    if (entry.isDirectory()) {
      boundedWalk(fullPath, { maxDepth, maxEntries, onFile }, depth + 1, state);
    } else if (entry.isFile()) {
      state.done = Boolean(onFile(fullPath));
    }
  }
}

function shouldSkipSearchEntry(name) {
  return new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
    ".code-review-graph",
    ".backendguard"
  ]).has(name);
}

function isInsidePath(filePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(filePath));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isSourceFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function mergeLocalFileCandidates(files) {
  const byPath = new Map();
  for (const file of files) {
    const existing = byPath.get(file.path);
    byPath.set(file.path, {
      ...existing,
      ...file,
      score: Number(existing?.score || 0) + Number(file.score || 0),
      reasons: [...new Set([...(existing?.reasons || []), ...(file.reasons || [])])],
      source: existing?.source === "import-graph" || file.source === "import-graph" ? "import-graph" : file.source
    });
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
