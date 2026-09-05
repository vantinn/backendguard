import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defaultDataRoot } from "../runtime/workspace-data.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_TIMEOUT_MS = 800;
const SEMANTIC_HIGH_THRESHOLD = 0.5;

const extractorPromises = new Map();
let sqlPromise = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const require = createRequire(import.meta.url);

export async function enhanceRuleScoresWithEmbeddings(
  rules,
  task,
  {
    dataDir = defaultDataRoot(),
    sources = [],
    timeoutMs = Number(process.env.BACKENDGUARD_EMBEDDING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    allowRemote = process.env.BACKENDGUARD_EMBEDDING_ALLOW_REMOTE === "1",
    enabled = process.env.BACKENDGUARD_EMBEDDINGS !== "0"
  } = {}
) {
  if (!enabled || !String(task || "").trim() || !rules?.length) {
    return { rules, status: "disabled" };
  }
  const cachePath = path.join(dataDir, "embeddings.db");
  if (!allowRemote && !fs.existsSync(cachePath)) {
    return { rules, status: "cold-cache", cachePath };
  }

  try {
    return await withTimeout(
      enhanceRuleScores(rules, task, { dataDir, sources, allowRemote }),
      timeoutMs
    );
  } catch (error) {
    return {
      rules,
      status: "fallback",
      error: error?.message || String(error)
    };
  }
}

export async function warmRuleEmbeddings({
  rules = [],
  task = "",
  dataDir = defaultDataRoot(),
  sources = [],
  allowRemote = true
} = {}) {
  if (!allowRemote && !isModelCacheReady(dataDir)) {
    return { count: 0, cachePath: path.join(dataDir, "embeddings.db"), status: "missing-model" };
  }
  const texts = [...new Set([
    task,
    ...rules.map((rule) => rule.content || "")
  ].filter((text) => String(text).trim()))];

  let cache;
  try {
    cache = await openEmbeddingCache(dataDir);
    const embedder = await getExtractor({ allowRemote, dataDir });
    for (const text of texts) {
      await getCachedEmbedding({ cache, embedder, text, sources, flush: false });
    }
    cache.close();
    return { count: texts.length, cachePath: cache.path, status: "enabled" };
  } catch (error) {
    try {
      cache?.close();
    } catch {
      // Ignore close failures while reporting a best-effort warm result.
    }
    return {
      count: 0,
      cachePath: path.join(dataDir, "embeddings.db"),
      status: "warm-failed",
      error: error?.message || String(error)
    };
  }
}

export async function searchIndexedEmbeddings({
  kind,
  task = "",
  dataDir = defaultDataRoot(),
  timeoutMs = Number(process.env.BACKENDGUARD_EMBEDDING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  allowRemote = process.env.BACKENDGUARD_EMBEDDING_ALLOW_REMOTE === "1",
  enabled = process.env.BACKENDGUARD_EMBEDDINGS !== "0"
} = {}) {
  if (!enabled || !kind || !String(task || "").trim()) return { items: [], status: "disabled" };
  const cachePath = path.join(dataDir, "embeddings.db");
  if (!allowRemote && !fs.existsSync(cachePath)) return { items: [], status: "cold-cache", cachePath };

  try {
    return await withTimeout(searchIndexed({ kind, task, dataDir, allowRemote }), timeoutMs);
  } catch (error) {
    return { items: [], status: "fallback", error: error?.message || String(error) };
  }
}

export async function listIndexedEmbeddingItems({
  kind,
  dataDir = defaultDataRoot()
} = {}) {
  if (!kind) return { items: [], status: "disabled" };
  const cachePath = path.join(dataDir, "embeddings.db");
  if (!fs.existsSync(cachePath)) return { items: [], status: "cold-cache", cachePath };
  let cache;
  try {
    cache = await openEmbeddingCache(dataDir);
    const items = cache.listIndexed(kind).map(({ id, text }) => ({ id, text }));
    cache.close();
    return { items, status: "enabled", cachePath };
  } catch (error) {
    try {
      cache?.close();
    } catch {
      // best-effort close while reporting fallback status
    }
    return { items: [], status: "fallback", error: error?.message || String(error), cachePath };
  }
}

export async function warmIndexedEmbeddings({
  kind,
  items = [],
  task = "",
  dataDir = defaultDataRoot(),
  sources = [],
  allowRemote = true
} = {}) {
  if (!kind || !items.length) return { count: 0, cachePath: path.join(dataDir, "embeddings.db") };
  if (!allowRemote && !isModelCacheReady(dataDir)) {
    return { count: 0, cachePath: path.join(dataDir, "embeddings.db"), status: "missing-model" };
  }

  let cache;
  try {
    cache = await openEmbeddingCache(dataDir);
    const embedder = await getExtractor({ allowRemote, dataDir });
    if (String(task || "").trim()) await getCachedEmbedding({ cache, embedder, text: task, sources });

    const indexed = [];
    for (const item of items) {
      const text = String(item.text || "");
      if (!item.id || !text.trim()) continue;
      const vector = await getCachedEmbedding({ cache, embedder, text, sources, flush: false });
      indexed.push({ id: item.id, text, vector });
    }
    cache.replaceIndex(kind, indexed);
    cache.close();
    return { count: indexed.length, cachePath: cache.path, status: "enabled" };
  } catch (error) {
    try {
      cache?.close();
    } catch {
      // Ignore close failures while reporting a best-effort warm result.
    }
    return {
      count: 0,
      cachePath: path.join(dataDir, "embeddings.db"),
      status: "warm-failed",
      error: error?.message || String(error)
    };
  }
}

export async function preloadEmbeddingPipeline({
  dataDir = defaultDataRoot(),
  allowRemote = false,
  warmText = "backendguard warmup"
} = {}) {
  if (!allowRemote && !isModelCacheReady(dataDir)) {
    return { status: "missing-model", loaded: false, cachePath: path.join(dataDir, "embeddings.db") };
  }
  const started = Date.now();
  try {
    const embedder = await getExtractor({ allowRemote, dataDir });
    await embedder(String(warmText || "backendguard warmup"), {
      pooling: "mean",
      normalize: true
    });
    return {
      status: "loaded",
      loaded: true,
      model: DEFAULT_MODEL,
      cachePath: path.join(dataDir, "embeddings.db"),
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      status: "load-failed",
      loaded: false,
      model: DEFAULT_MODEL,
      cachePath: path.join(dataDir, "embeddings.db"),
      elapsedMs: Date.now() - started,
      error: error?.message || String(error)
    };
  }
}

async function enhanceRuleScores(rules, task, { dataDir, sources, allowRemote }) {
  const cache = await openEmbeddingCache(dataDir);
  const embedder = await getExtractor({ allowRemote, dataDir });
  const taskEmbedding = await getCachedEmbedding({ cache, embedder, text: task, sources });

  const enhanced = [];
  for (const rule of rules) {
    const ruleEmbedding = await getCachedEmbedding({
      cache,
      embedder,
      text: rule.content || "",
      sources
    });
    const similarity = cosine(taskEmbedding, ruleEmbedding);
    const semanticScore = similarityToScore(similarity);
    const baseScore = Number(rule.score || 0);
    const score = semanticScore >= SEMANTIC_HIGH_THRESHOLD
      ? Math.max(baseScore, semanticScore)
      : baseScore;

    enhanced.push({
      ...rule,
      score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
      embeddingScore: Number(semanticScore.toFixed(3)),
      reasons: semanticScore >= 0.45
        ? [...new Set([...(rule.reasons || []), `embedding:${semanticScore.toFixed(2)}`])]
        : rule.reasons
    });
  }

  cache.close();
  return {
    rules: enhanced.sort((a, b) => b.score - a.score || a.originalOrder - b.originalOrder),
    status: "enabled",
    model: DEFAULT_MODEL,
    cachePath: cache.path
  };
}

async function searchIndexed({ kind, task, dataDir, allowRemote }) {
  const cache = await openEmbeddingCache(dataDir);
  const embedder = await getExtractor({ allowRemote, dataDir });
  const taskEmbedding = await getCachedEmbedding({ cache, embedder, text: task, sources: [] });
  const items = cache.listIndexed(kind)
    .map((item) => ({
      ...item,
      embeddingScore: Number(similarityToScore(cosine(taskEmbedding, item.vector)).toFixed(3))
    }))
    .sort((a, b) => b.embeddingScore - a.embeddingScore || a.id.localeCompare(b.id));
  cache.close();
  return { items, status: "enabled", model: DEFAULT_MODEL, cachePath: cache.path };
}

async function getExtractor({ allowRemote, dataDir }) {
  const cacheDir = modelCacheDir(dataDir);
  const key = `${allowRemote ? "remote" : "local"}:${cacheDir}`;
  if (!extractorPromises.has(key)) {
    extractorPromises.set(key, (async () => {
      const transformers = await import("@xenova/transformers");
      transformers.env.allowRemoteModels = Boolean(allowRemote);
      transformers.env.allowLocalModels = true;
      transformers.env.cacheDir = cacheDir;
      return transformers.pipeline("feature-extraction", DEFAULT_MODEL, {
        quantized: true
      });
    })().catch((error) => {
      extractorPromises.delete(key);
      throw error;
    }));
  }
  return extractorPromises.get(key);
}

export function modelCacheDir(dataDir = defaultDataRoot()) {
  return path.join(dataDir, "models");
}

export function isModelCacheReady(dataDir = defaultDataRoot()) {
  const modelDir = path.join(modelCacheDir(dataDir), ...DEFAULT_MODEL.split("/"));
  return [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    path.join("onnx", "model_quantized.onnx")
  ].every((relativePath) => fs.existsSync(path.join(modelDir, relativePath)));
}

async function getCachedEmbedding({ cache, embedder, text, sources, flush = true }) {
  const key = cacheKey(text, sources);
  const existing = cache.get(key);
  if (existing) return existing;

  const output = await embedder(String(text || ""), {
    pooling: "mean",
    normalize: true
  });
  const embedding = Array.from(output.data || []);
  cache.set(key, embedding, { flush });
  return embedding;
}

export async function openEmbeddingCache(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cachePath = path.join(dataDir, "embeddings.db");
  const SQL = await getSql();
  const db = initializeEmbeddingDatabase(SQL, cachePath);
  let dirty = false;

  return {
    path: cachePath,
    get(key) {
      const stmt = db.prepare("SELECT vector FROM embeddings WHERE key = ? AND model = ?");
      try {
        stmt.bind([key, DEFAULT_MODEL]);
        if (!stmt.step()) return null;
        return JSON.parse(stmt.getAsObject().vector);
      } finally {
        stmt.free();
      }
    },
    set(key, vector, { flush = true } = {}) {
      db.run(
        "INSERT OR REPLACE INTO embeddings (key, model, vector, updated_at) VALUES (?, ?, ?, ?)",
        [key, DEFAULT_MODEL, JSON.stringify(vector), new Date().toISOString()]
      );
      dirty = true;
      if (flush) {
        writeDatabaseAtomically(cachePath, db);
        dirty = false;
      }
    },
    listIndexed(kind) {
      const stmt = db.prepare("SELECT id, text, vector FROM embedding_index WHERE kind = ? AND model = ?");
      const items = [];
      try {
        stmt.bind([kind, DEFAULT_MODEL]);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          items.push({ id: row.id, text: row.text, vector: JSON.parse(row.vector) });
        }
      } finally {
        stmt.free();
      }
      return items;
    },
    replaceIndex(kind, items) {
      db.run("DELETE FROM embedding_index WHERE kind = ? AND model = ?", [kind, DEFAULT_MODEL]);
      for (const item of items) {
        db.run(
          "INSERT INTO embedding_index (kind, id, text, model, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [kind, item.id, item.text, DEFAULT_MODEL, JSON.stringify(item.vector), new Date().toISOString()]
        );
      }
      writeDatabaseAtomically(cachePath, db);
      dirty = false;
    },
    close() {
      if (dirty) writeDatabaseAtomically(cachePath, db);
      db.close();
    }
  };
}

function initializeEmbeddingDatabase(SQL, cachePath) {
  let db = openSqlDatabase(SQL, cachePath);
  try {
    ensureEmbeddingSchema(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Ignore close failures while recovering a corrupt cache.
    }
    quarantineMalformedCache(cachePath, error);
    db = new SQL.Database();
    ensureEmbeddingSchema(db);
    writeDatabaseAtomically(cachePath, db);
    return db;
  }
}

function ensureEmbeddingSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS embeddings (
      key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS embedding_index (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      text TEXT NOT NULL,
      model TEXT NOT NULL,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, id, model)
    )
  `);
}

function openSqlDatabase(SQL, cachePath) {
  if (!fs.existsSync(cachePath)) return new SQL.Database();
  const buffer = fs.readFileSync(cachePath);
  if (!buffer.length) return new SQL.Database();
  try {
    return new SQL.Database(buffer);
  } catch (error) {
    quarantineMalformedCache(cachePath, error);
    return new SQL.Database();
  }
}

function quarantineMalformedCache(cachePath, error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corruptPath = `${cachePath}.corrupt-${stamp}-${process.pid}`;
  try {
    fs.renameSync(cachePath, corruptPath);
    console.warn(`[backendguard] Embedding cache was malformed and has been moved to ${corruptPath}: ${error?.message || error}`);
  } catch {
    try {
      fs.rmSync(cachePath, { force: true });
      console.warn(`[backendguard] Embedding cache was malformed and has been reset: ${error?.message || error}`);
    } catch {
      // The caller will recreate the cache if the old file could not be moved.
    }
  }
}

function writeDatabaseAtomically(cachePath, db) {
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmpPath, Buffer.from(db.export()));
  fs.renameSync(tmpPath, cachePath);
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const initSqlJs = (await import("sql.js")).default;
      return initSqlJs({
        locateFile: locateSqlJsFile
      });
    })();
  }
  return sqlPromise;
}

function locateSqlJsFile(file) {
  try {
    return require.resolve(`sql.js/dist/${file}`);
  } catch {
    return path.join(repoRoot, "node_modules", "sql.js", "dist", file);
  }
}

function cacheKey(text, sources) {
  return crypto
    .createHash("sha256")
    .update(DEFAULT_MODEL)
    .update("\0")
    .update(String(text || ""))
    .update("\0")
    .update(sourceFingerprint(sources))
    .digest("hex");
}

function sourceFingerprint(sources) {
  const parts = [];
  for (const source of sources || []) {
    try {
      const stat = fs.statSync(source);
      parts.push(`${source}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(String(source));
    }
  }
  return parts.join("|");
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a?.length || 0, b?.length || 0);
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function similarityToScore(similarity) {
  return Math.max(0, Math.min(1, (similarity + 1) / 2));
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`embedding scorer timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
