import fs from "node:fs";
import path from "node:path";

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IMPORT_RE = /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

export function expandImportGraph({ cwd = process.cwd(), seedFiles = [], dataDir, limit = 6 } = {}) {
  const seeds = new Set(seedFiles.map((file) => normalizeRel(file.path)).filter(Boolean));
  if (!seeds.size) return [];

  const index = readImportGraphIndex({ cwd, dataDir });
  if (!index) return [];
  const outgoing = objectToMap(index.outgoing);
  const incoming = objectToMap(index.incoming);

  const candidates = new Map();
  for (const seed of seeds) {
    for (const target of outgoing.get(seed) || []) {
      addImportCandidate(candidates, target, `imports:${seed}`, 4);
    }
    for (const importer of incoming.get(seed) || []) {
      addImportCandidate(candidates, importer, `imported-by:${seed}`, 5);
    }
  }

  return [...candidates.values()]
    .filter((file) => !seeds.has(file.path))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function rebuildImportGraphIndex({ cwd = process.cwd(), files = [], dataDir } = {}) {
  if (!dataDir) return { count: 0, path: null };
  const normalizedFiles = [...new Set(files.map(normalizeRel).filter(Boolean))];
  const fileSet = new Set(normalizedFiles);
  const outgoing = {};
  const incoming = {};

  for (const rel of normalizedFiles) {
    const imports = resolveImports({ cwd, rel, fileSet });
    outgoing[rel] = imports;
    for (const target of imports) {
      incoming[target] = [...new Set([...(incoming[target] || []), rel])];
    }
  }

  const indexPath = importGraphIndexPath(dataDir);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ cwd: path.resolve(cwd), outgoing, incoming })}\n`, "utf8");
  fs.renameSync(tmpPath, indexPath);
  return { count: normalizedFiles.length, path: indexPath };
}

function addImportCandidate(candidates, filePath, reason, score) {
  const existing = candidates.get(filePath) || {
    path: filePath,
    score: 0,
    source: "import-graph",
    reasons: []
  };
  existing.score += score;
  existing.reasons.push(reason);
  candidates.set(filePath, {
    ...existing,
    reasons: [...new Set(existing.reasons)]
  });
}

function resolveImports({ cwd, rel, fileSet }) {
  const fullPath = path.join(cwd, rel);
  let content = "";
  try {
    content = fs.readFileSync(fullPath, "utf8");
  } catch {
    return [];
  }

  const resolved = new Set();
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2];
    if (!specifier?.startsWith(".")) continue;
    const target = resolveRelativeImport(path.dirname(rel), specifier, fileSet);
    if (target) resolved.add(target);
  }
  return [...resolved];
}

function resolveRelativeImport(fromDir, specifier, fileSet) {
  const base = normalizeRel(path.join(fromDir, specifier));
  const candidates = [
    base,
    ...JS_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...JS_EXTENSIONS.map((ext) => path.join(base, `index${ext}`))
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function normalizeRel(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  return normalized;
}

function readImportGraphIndex({ cwd, dataDir }) {
  if (!dataDir) return null;
  try {
    const index = JSON.parse(fs.readFileSync(importGraphIndexPath(dataDir), "utf8"));
    return index.cwd === path.resolve(cwd) ? index : null;
  } catch {
    return null;
  }
}

function importGraphIndexPath(dataDir) {
  return path.join(dataDir, "import-graph.json");
}

function objectToMap(value = {}) {
  return new Map(Object.entries(value));
}
