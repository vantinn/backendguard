import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function createScoreService({
  scoreContext,
  dataDir,
  concurrency = Number(process.env.BACKENDGUARD_SCORE_CONCURRENCY || 1),
  cacheTtlMs = Number(process.env.BACKENDGUARD_SCORE_CACHE_TTL_MS || 60_000),
  requestTimeoutMs = Number(process.env.BACKENDGUARD_SCORE_REQUEST_TIMEOUT_MS || 2_500),
  gitHeadReader = readGitHead
} = {}) {
  if (typeof scoreContext !== "function") throw new Error("createScoreService requires scoreContext");
  const queue = [];
  const cache = new Map();
  const inFlight = new Map();
  let active = 0;

  async function score(payload = {}) {
    const key = scoreCacheKey(payload, { gitHeadReader });
    const cached = readCache(cache, key, cacheTtlMs);
    if (cached) {
      return cloneResult(cached, {
        cache_hit: true,
        coalesced: false,
        queue_wait_ms: 0,
        score_ms: 0,
        score_queue_depth: queue.length,
        score_active: active
      });
    }
    if (inFlight.has(key)) {
      const started = Date.now();
      const result = await inFlight.get(key);
      return cloneResult(result, {
        cache_hit: false,
        coalesced: true,
        queue_wait_ms: 0,
        score_ms: Date.now() - started,
        score_queue_depth: queue.length,
        score_active: active
      });
    }

    const promise = enqueue(async ({ queueWaitMs }) => {
      const started = Date.now();
      const result = await withTimeout(scoreContext({
        ...payload,
        dataDir: payload.dataDir || dataDir
      }), requestTimeoutMs, `ctx-mcp score timed out after ${requestTimeoutMs}ms`);
      return cloneResult(result, {
        cache_hit: false,
        coalesced: false,
        queue_wait_ms: queueWaitMs,
        score_ms: Date.now() - started,
        score_queue_depth: queue.length,
        score_active: active
      });
    });
    inFlight.set(key, promise);
    try {
      const result = await promise;
      cache.set(key, { createdAt: Date.now(), result });
      return result;
    } finally {
      inFlight.delete(key);
      pruneCache(cache, cacheTtlMs);
    }
  }

  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject, enqueuedAt: Date.now() });
      drain();
    });
  }

  function drain() {
    while (active < Math.max(1, concurrency) && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => item.task({ queueWaitMs: Date.now() - item.enqueuedAt }))
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function stats() {
    return {
      score_queue_depth: queue.length,
      score_active: active,
      score_cache_entries: cache.size,
      score_inflight: inFlight.size,
      score_concurrency: Math.max(1, concurrency),
      score_cache_ttl_ms: cacheTtlMs,
      score_request_timeout_ms: requestTimeoutMs
    };
  }

  return { score, stats };
}

export function scoreCacheKey(payload = {}, { gitHeadReader = readGitHead } = {}) {
  const cwd = path.resolve(payload.cwd || process.cwd());
  const stablePayload = {
    cwd,
    gitHead: gitHeadReader(cwd),
    prompt: payload.prompt || "",
    openFiles: payload.openFiles || [],
    maxFiles: payload.maxFiles || 5,
    maxSkills: payload.maxSkills || 3,
    maxWorkflows: payload.maxWorkflows || 2,
    skills: skillNames(payload.skills),
    workflows: workflowNames(payload.workflows)
  };
  return crypto.createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
}

function readCache(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (ttlMs <= 0 || Date.now() - entry.createdAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function pruneCache(cache, ttlMs) {
  if (ttlMs <= 0) {
    cache.clear();
    return;
  }
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt > ttlMs) cache.delete(key);
  }
}

function cloneResult(result = {}, telemetry = {}) {
  return {
    ...result,
    telemetry: {
      ...(result.telemetry || {}),
      ...telemetry
    }
  };
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

function skillNames(skills = []) {
  return Array.isArray(skills) ? skills.map((skill) => skill?.name || "").filter(Boolean).sort() : [];
}

function workflowNames(workflows = []) {
  return Array.isArray(workflows) ? workflows.map((workflow) => workflow?.name || workflow?.title || "").filter(Boolean).sort() : [];
}

function readGitHead(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return "no-git";
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s+(.+)$/)?.[1];
    if (!ref) return head;
    return fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
  } catch {
    return "unknown";
  }
}

function findGitDir(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".git");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
