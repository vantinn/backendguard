import fs from "node:fs";
import path from "node:path";
import { findGraphRelevantFiles, mergeRelevantFiles } from "./graph-retriever.js";
import { expandImportGraph } from "./import-graph.js";
import { findEmbeddingRelevantFiles, findIndexedFileTextMatches } from "./file-embedding-retriever.js";
import { workspacePackagePaths } from "./project-profiler.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "cho", "co", "cua", "do", "fix", "for",
  "from", "in", "is", "it", "la", "of", "on", "or", "sua", "task", "the", "to", "trong",
  "tra", "va", "with"
]);

const IMPORTANT_WORDS = [
  "always", "never", "must", "required", "important", "strictly", "mandatory",
  "luon", "khong bao gio", "bat buoc", "quan trong"
];

const SEMANTIC_ALIASES = {
  duyet: ["moderation", "moderate", "review", "approve", "approval", "approved", "reject", "rejected"],
  kiem: ["check", "verify", "validation", "validate"],
  "kiem-duyet": ["moderation", "moderate", "review", "approve", "approval", "reject"],
  kiemduyet: ["moderation", "moderate", "review", "approve", "approval", "reject"],
  moderation: ["duyet", "kiemduyet", "review", "approval", "reject"],
  moderate: ["duyet", "kiemduyet", "review", "approval", "reject"],
  review: ["duyet", "moderation", "moderate"],
  approve: ["duyet", "approval", "approved"],
  approval: ["duyet", "approve", "approved"],
  reject: ["duyet", "rejected", "rejection"],
  flow: ["workflow", "pipeline", "process"],
  workflow: ["flow", "pipeline", "process"],
  tai: ["upload", "uploaded", "resource"],
  "tai-len": ["upload", "uploaded", "resource"],
  tailen: ["upload", "uploaded", "resource"],
  upload: ["tai", "tailen", "resource", "uploaded"],
  xac: ["confirm", "verify", "verification"],
  nhan: ["confirm", "confirmation"],
  "xac-nhan": ["confirm", "confirmation", "verify", "verification"],
  xacnhan: ["confirm", "confirmation", "verify", "verification"],
  thong: ["notification", "notify", "message"],
  bao: ["notification", "notify", "message"],
  "thong-bao": ["notification", "notify", "message"],
  thongbao: ["notification", "notify", "message"],
  authen: ["auth", "authentication", "login"],
  authentication: ["auth", "authen", "login"],
  recheck: ["check", "verify", "review"]
};

const SYSTEM_USER_RULE_PATTERNS = [
  /\ball\s+shell\s+commands?\s+must\s+run\s+as\b/i,
  /\bcommands?\s+must\s+run\s+as\b/i,
  /\bstrictly\s+follow\s+this\s+sequence\b/i,
  /\bswitch\s+the\s+user\s+context\b/i,
  /\bdo\s+not\s+prefix\b.*\bsudo\s+-u\b/i,
  /\bsudo\s+su\s+-\s*[a-z_][a-z0-9_-]*\b/i,
  /\bsudo\s+-i\s+-u\s+[a-z_][a-z0-9_-]*\b/i,
  /\bsudo\s+-u\s+[a-z_][a-z0-9_-]*\b/i,
  /\bsu\s+-\s+[a-z_][a-z0-9_-]*\b/i,
  /[/\\]\.codex[/\\]RTK\.md\b/i,
  /\bminh_dev\b/i
];

const DOCUMENTATION_HEADING_PATTERNS = [
  /^mcp\s+tools?\s*:/i,
  /^key\s+tools?$/i,
  /^workflow$/i,
  /^tools?$/i
];

const TOOL_REFERENCE_TOKENS = new Set([
  "detect_changes",
  "get_review_context",
  "get_impact_radius",
  "get_affected_flows",
  "query_graph",
  "semantic_search_nodes",
  "get_architecture_overview",
  "refactor_tool",
  "list_communities"
]);

const ACTION_TOKENS = new Set([
  "add", "avoid", "call", "check", "derive", "ensure", "filter", "follow", "prefer", "run",
  "use", "validate", "verify", "write", "never", "always", "must", "should", "do"
]);

export function tokenize(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/kiem\s+duyet/g, "kiem-duyet")
    .replace(/tai\s+len/g, "tai-len")
    .replace(/xac\s+nhan/g, "xac-nhan")
    .replace(/thong\s+bao/g, "thong-bao");

  return normalized
    .split(/[^a-z0-9_.-]+/g)
    .flatMap(splitCompoundToken)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function splitCompoundToken(token) {
  const parts = String(token || "").split(/[_.-]+/g).filter(Boolean);
  return parts.length > 1 ? [token, ...parts] : [token];
}

function expandSemanticTokens(tokens) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const alias of SEMANTIC_ALIASES[token] || []) expanded.add(alias);
  }
  return expanded;
}

function sourceFromLine(line) {
  const match = line.match(/^## Source:\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function cleanRuleLine(line) {
  return line
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/^#+\s+/, "")
    .trim();
}

export function parseRules(markdown) {
  const rules = [];
  let sourcePath = "unknown";
  let paragraph = [];

  const flushParagraph = () => {
    const content = cleanRuleLine(paragraph.join(" ").replace(/\s+/g, " "));
    paragraph = [];
    if (content.length < 20) return;
    rules.push({
      id: `r${rules.length + 1}`,
      sourcePath,
      content,
      originalOrder: rules.length
    });
  };

  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const nextSource = sourceFromLine(line);
    if (nextSource) {
      flushParagraph();
      sourcePath = nextSource;
      continue;
    }
    if (!line || /^-{3,}$/.test(line)) {
      flushParagraph();
      continue;
    }
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(rawLine) || /^#{1,6}\s+/.test(rawLine)) {
      flushParagraph();
      const content = cleanRuleLine(rawLine);
      if (content.length >= 4) {
        rules.push({
          id: `r${rules.length + 1}`,
          sourcePath,
          content,
          originalOrder: rules.length
        });
      }
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return dedupeRules(rules);
}

export function filterActionableRules(rules = []) {
  return rules
    .filter((rule) => !isSystemUserRule(rule))
    .filter((rule) => !isDocumentationOnlyRule(rule))
    .map((rule, index) => ({ ...rule, id: `r${index + 1}`, originalOrder: index }));
}

export function isSystemUserRule(rule) {
  const content = typeof rule === "string" ? rule : rule?.content;
  return SYSTEM_USER_RULE_PATTERNS.some((pattern) => pattern.test(String(content || "")));
}

export function isDocumentationOnlyRule(rule) {
  const content = String(typeof rule === "string" ? rule : rule?.content || "").trim();
  const normalized = stripMarkdownEmphasis(content);
  if (!normalized) return true;
  if (/^<!--.*-->$/.test(normalized)) return true;
  if (DOCUMENTATION_HEADING_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (isMarkdownTableRule(normalized)) return true;
  if (isGenericHeading(normalized)) return true;
  return false;
}

function stripMarkdownEmphasis(content) {
  return String(content || "")
    .replace(/^#+\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .trim();
}

function isMarkdownTableRule(content) {
  if (!content.includes("|")) return false;
  const pipeCount = (content.match(/\|/g) || []).length;
  if (pipeCount < 4) return false;
  const lower = content.toLowerCase();
  const toolReferenceCount = [...TOOL_REFERENCE_TOKENS].filter((token) => lower.includes(token)).length;
  return /\btool\b/.test(lower) && /\buse\s+when\b/.test(lower) && toolReferenceCount >= 2;
}

function isGenericHeading(content) {
  if (content.length > 80 || /[`.:;]/.test(content)) return false;
  const tokens = tokenize(content);
  if (tokens.length > 4) return false;
  return !tokens.some((token) => ACTION_TOKENS.has(token));
}

function dedupeRules(rules) {
  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.sourcePath}:${rule.content.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((rule, index) => ({ ...rule, id: `r${index + 1}`, originalOrder: index }));
}

export function scoreRules(rules, task, openFiles = []) {
  const rawTaskTokens = new Set(tokenize(task));
  const openFileText = Array.isArray(openFiles) ? openFiles.join(" ") : String(openFiles || "");
  const openFileTokens = new Set(tokenize(openFileText));

  return rules.map((rule) => {
    const ruleTokens = new Set(tokenize(rule.content));
    const exactOverlap = [...rawTaskTokens].filter((token) => ruleTokens.has(token));
    const semanticOverlap = [];
    for (const token of rawTaskTokens) {
      for (const alias of SEMANTIC_ALIASES[token] || []) {
        if (!rawTaskTokens.has(alias) && ruleTokens.has(alias)) semanticOverlap.push(`${token}->${alias}`);
      }
    }
    const reasons = [];
    let score = rawTaskTokens.size
      ? (exactOverlap.length + semanticOverlap.length * 0.5) / Math.max(rawTaskTokens.size, 1)
      : 0;

    if (exactOverlap.length) reasons.push(`task:${exactOverlap.join("/")}`);
    if (semanticOverlap.length) reasons.push(`semantic:${semanticOverlap.join("/")}`);

    // The imperative-language bonus ("always"/"never"/"must"...) is meant to nudge
    // an ALREADY task-relevant rule higher, not to single-handedly make an
    // unrelated rule "relevant" — nearly every well-written AGENTS.md rule uses
    // this language, so applying the bonus unconditionally made every rule clear
    // the selection threshold regardless of the task (see
    // docs/implementation-gap-analysis.md, Gap 10). Skip the bonus only when a
    // real task was given and it has zero overlap (exact or semantic) with this
    // rule; an empty/no-task query keeps the old "show important rules" behavior.
    const hasTaskOverlap = exactOverlap.length > 0 || semanticOverlap.length > 0 || rawTaskTokens.size === 0;
    const lowerRule = rule.content.toLowerCase();
    if (hasTaskOverlap && IMPORTANT_WORDS.some((word) => lowerRule.includes(word))) {
      score += 0.5;
      reasons.push("imperative");
    }

    const fileMentions = [...ruleTokens].filter((token) => /[./]/.test(token) || /\.[a-z0-9]+$/.test(token));
    if (fileMentions.some((token) => openFileTokens.has(token) || openFileText.includes(token))) {
      score += 0.2;
      reasons.push("open-file");
    }

    return {
      ...rule,
      score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
      reasons
    };
  }).sort((a, b) => b.score - a.score || a.originalOrder - b.originalOrder);
}

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

function expandFileRetrievalTask(task) {
  const tokens = new Set(tokenize(task));
  const additions = new Set();
  if (hasAny(tokens, ["purchase", "purchased", "buy", "buyer", "seller", "payment", "pay", "checkout"])) {
    addAll(additions, [
      "purchase", "payment", "checkout", "billing", "wallet", "balance", "top up",
      "transaction", "order", "invoice"
    ]);
  }
  if (hasAny(tokens, ["wallet", "balance", "topup", "top", "funded"])) {
    addAll(additions, ["wallet", "balance", "top up", "billing"]);
  }
  if (hasAny(tokens, ["library", "access", "permissions", "permission", "resources", "tutorials", "collections"])) {
    addAll(additions, [
      "content access", "content-access-service", "access permissions", "library",
      "resource", "resources", "tutorial", "tutorials", "collections"
    ]);
  }
  if (hasAny(tokens, ["notification", "notifications", "notify", "buyer", "seller"])) {
    addAll(additions, ["notification", "notifications", "notify", "buyer", "seller"]);
  }
  if (!additions.size) return task;
  return `${task}\n\nBackendGuard retrieval hints: ${[...additions].join(", ")}`;
}

function hasAny(tokens, values) {
  return values.some((value) => tokens.has(value));
}

function addAll(target, values) {
  for (const value of values) target.add(value);
}

export function findExplicitPromptFiles({ cwd = process.cwd(), task = "", limit = 6 } = {}) {
  const candidates = new Set();
  const normalizedTask = String(task || "").replace(/\/\s+/g, "/");
  const matches = normalizedTask.match(/[A-Za-z0-9_.()[\]@~:,-]+(?:\/[A-Za-z0-9_.()[\]@~:,-]+)+/g) || [];
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
