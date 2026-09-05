import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { hasDecorator, propertyName } from "../ast-utils.js";
import { createFinding, createTextFinding } from "../finding.js";

/**
 * Scalability analysis: what breaks when this service runs as more than one
 * process.
 *
 * This analyzer makes **no throughput claims**. It cannot tell you a service
 * supports N users — that needs a load test, not a parser. What it can tell you
 * is which specific constructs stop working correctly once a second replica
 * exists: in-process state that other replicas can't see, an in-memory rate
 * limiter, a session store that lives in one process's heap, work scheduled on
 * every replica instead of one, uploads written to a local disk, and a missing
 * shutdown/health contract.
 */

const ANALYZER_ID = "scalability";

const MUTABLE_STATE_TYPES = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const STATEFUL_NAME_PATTERN = /cache|session|store|registry|counter|bucket|queue|pending|inflight|connections|clients|subscribers|rooms|locks?/i;

export const scalabilityAnalyzer = {
  id: ANALYZER_ID,
  title: "Scalability",
  categories: ["Scalability"],
  analyze({ index, cwd }) {
    const findings = [];
    for (const file of index.files) {
      findings.push(...checkSharedInMemoryState(file));
      findings.push(...checkInMemoryRateLimiting(file));
      findings.push(...checkLocalFilesystemWrites(file));
      findings.push(...checkScheduledWorkOnEveryReplica(file));
      findings.push(...checkInMemorySessionStore(file));
    }
    findings.push(...checkOperationalContract(cwd, index));
    return findings;
  }
};

// ---------------------------------------------------------------------------
// SCALE-001 — mutable module/instance state shared across requests
// ---------------------------------------------------------------------------

function checkSharedInMemoryState({ sourceFile, relativePath }) {
  const findings = [];

  const report = (node, name, kind) => {
    findings.push(createFinding({
      id: "SCALE-001",
      category: "Scalability",
      severity: "MEDIUM",
      confidence: "medium",
      analyzer: ANALYZER_ID,
      title: "Request-spanning state held in process memory",
      detail: `"${name}" is ${kind} holding mutable state in this process. Each replica gets its own copy, so behaviour depends on which instance served the request, and a restart or redeploy loses it.`,
      remediation: "Move the state to a shared store (Redis for ephemeral state, PostgreSQL for durable state). If it is a pure cache that tolerates divergence, document that decision.",
      sourceFile,
      node,
      file: relativePath
    }));
  };

  // Module-level `const cache = new Map()`.
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (!STATEFUL_NAME_PATTERN.test(name)) continue;
      if (isMutableContainer(declaration.initializer)) report(declaration, name, "a module-level container");
    }
  }

  // Injectable service field `private cache = new Map()`.
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && hasDecorator(node, ["Injectable"])) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !member.initializer) continue;
        const name = propertyName(member);
        if (!name || !STATEFUL_NAME_PATTERN.test(name)) continue;
        if (isMutableContainer(member.initializer)) {
          report(member, `${node.name?.text}.${name}`, "a singleton service field");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function isMutableContainer(expression) {
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
    return MUTABLE_STATE_TYPES.has(expression.expression.text);
  }
  if (ts.isArrayLiteralExpression(expression)) return true;
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// SCALE-002 — rate limiting that only counts one replica's traffic
// ---------------------------------------------------------------------------

function checkInMemoryRateLimiting({ sourceFile, relativePath }) {
  const findings = [];
  const text = sourceFile.getText();
  if (!/throttl|rate ?limit/i.test(text)) return findings;
  // A storage adapter (Redis, Memcached) means the counters are shared.
  if (/redis|memcach|storage\s*:|ThrottlerStorage/i.test(text)) return findings;

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "forRoot"
      && /Throttler/i.test(node.expression.expression.getText(sourceFile))) {
      findings.push(createFinding({
        id: "SCALE-002",
        category: "Scalability",
        severity: "MEDIUM",
        confidence: "high",
        analyzer: ANALYZER_ID,
        title: "Rate limiting counts requests per replica",
        detail: "ThrottlerModule is configured with no shared storage, so each replica keeps its own counters. With N replicas behind a load balancer the effective limit is N times the configured one.",
        remediation: "Configure a shared ThrottlerStorage backed by Redis, or enforce the limit at the ingress/gateway instead.",
        sourceFile,
        node,
        file: relativePath
      }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SCALE-003 — writes to the local filesystem
// ---------------------------------------------------------------------------

const LOCAL_WRITE_CALLS = new Set(["writeFile", "writeFileSync", "createWriteStream", "appendFile", "appendFileSync", "rename", "renameSync"]);

function checkLocalFilesystemWrites({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && LOCAL_WRITE_CALLS.has(node.expression.name.text)) {
      const target = node.arguments[0]?.getText(sourceFile) || "";
      // Temp-directory writes are process-local by design and fine.
      if (/tmpdir|os\.tmp|\/tmp|logs?\b/i.test(target)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (/upload|avatar|attachment|export|report|storage|media|invoice/i.test(target)) {
        findings.push(createFinding({
          id: "SCALE-003",
          category: "Scalability",
          severity: "MEDIUM",
          confidence: "medium",
          analyzer: ANALYZER_ID,
          title: "User content written to the local filesystem",
          detail: `${node.expression.name.text}(...) writes to a local path that looks like user-facing content. Only the replica that handled the write can serve the file back, and container filesystems do not survive a restart.`,
          remediation: "Write to object storage (S3/GCS/R2) and store the resulting key, or mount a shared volume that every replica can read.",
          sourceFile,
          node,
          file: relativePath
        }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SCALE-004 — scheduled job that runs on every replica
// ---------------------------------------------------------------------------

function checkScheduledWorkOnEveryReplica({ sourceFile, relativePath }) {
  const findings = [];
  const text = sourceFile.getText();
  const coordinated = /lock|leader|advisory|SKIP LOCKED|bullmq|Queue\b|redlock/i.test(text);
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && hasDecorator(node, ["Cron", "Interval", "Timeout"]) && !coordinated) {
      findings.push(createFinding({
        id: "SCALE-004",
        category: "Scalability",
        severity: "MEDIUM",
        confidence: "medium",
        analyzer: ANALYZER_ID,
        title: "Scheduled job runs on every replica",
        detail: `${propertyName(node)}() is scheduled in-process with no visible locking or queue. Every replica runs it on the same schedule, so the work happens N times — duplicate emails, duplicate charges, duplicate writes.`,
        remediation: "Move the job onto a queue with a single consumer (BullMQ), take a PostgreSQL advisory lock at the start of the job, or run scheduled work in a dedicated single-replica worker.",
        sourceFile,
        node: node.name || node,
        file: relativePath
      }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SCALE-005 — session state in process memory
// ---------------------------------------------------------------------------

function checkInMemorySessionStore({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "session") {
      const [options] = node.arguments;
      const hasStore = options && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) => propertyName(property) === "store");
      if (!hasStore) {
        findings.push(createFinding({
          id: "SCALE-005",
          category: "Scalability",
          severity: "HIGH",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Sessions stored in process memory",
          detail: "express-session is configured without a `store`, so it falls back to MemoryStore. Sessions are lost on restart and are invisible to other replicas, which logs users out at random behind a load balancer.",
          remediation: "Configure a shared session store (connect-redis or similar), or move to stateless tokens.",
          sourceFile,
          node,
          file: relativePath
        }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SCALE-006/007 — operational contract for a replicated deployment
// ---------------------------------------------------------------------------

function checkOperationalContract(cwd, index) {
  const findings = [];
  // Only meaningful for a service that is actually containerised: a library or
  // a single-box app has no orchestrator asking these questions.
  const containerised = ["Dockerfile", "docker-compose.yml", "compose.yml"].some((file) => fs.existsSync(path.join(cwd, file)));
  if (!containerised || !index.files.length) return findings;

  const allText = index.files.map((file) => file.text).join("\n");
  // These are project-scope findings. Anchor them to the service entrypoint
  // when there is one; otherwise say so explicitly rather than pinning a
  // whole-project observation to an arbitrary controller, which reads as a
  // claim about that file.
  const entrypoint = index.files.find((file) => /(^|\/)(main|server|index|app)\.ts$/.test(file.relativePath));
  const entry = entrypoint || { relativePath: "(project)" };
  const scope = entrypoint ? "" : " (project-wide observation; no service entrypoint was found to anchor it to)";

  if (!/enableShutdownHooks|SIGTERM|onApplicationShutdown|OnModuleDestroy|closeGracefully/i.test(allText)) {
    findings.push(createTextFinding({
      id: "SCALE-006",
      category: "Scalability",
      severity: "MEDIUM",
      confidence: "medium",
      analyzer: ANALYZER_ID,
      title: "No graceful shutdown handling",
      detail: "The service is containerised but nothing handles SIGTERM (no enableShutdownHooks/OnModuleDestroy/SIGTERM listener). On every deploy and every autoscale event the orchestrator sends SIGTERM and in-flight requests are cut off mid-response.",
      remediation: "Call app.enableShutdownHooks() (NestJS) or handle SIGTERM: stop accepting connections, drain in-flight requests, close the database pool, then exit.",
      evidence: `no SIGTERM/shutdown handler found in ${index.files.length} scanned file(s)${scope}`,
      file: entry.relativePath,
      line: entrypoint ? 1 : 0
    }));
  }

  if (!/health|healthz|readiness|liveness|@nestjs\/terminus/i.test(allText)) {
    findings.push(createTextFinding({
      id: "SCALE-007",
      category: "Scalability",
      severity: "LOW",
      confidence: "medium",
      analyzer: ANALYZER_ID,
      title: "No health/readiness endpoint",
      detail: "The service is containerised but exposes no health or readiness route, so the orchestrator cannot tell a starting instance from a healthy one and will route traffic to a replica whose dependencies are not up yet.",
      remediation: "Expose a liveness route and a readiness route that checks the database/cache connections (@nestjs/terminus provides both).",
      evidence: `no health/readiness route found in ${index.files.length} scanned file(s)${scope}`,
      file: entry.relativePath,
      line: entrypoint ? 1 : 0
    }));
  }

  return findings;
}
