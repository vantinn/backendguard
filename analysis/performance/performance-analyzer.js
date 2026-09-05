import ts from "typescript";

import { findDecorator, hasDecorator, isLoopLike, propertyName } from "../ast-utils.js";
import { createFinding } from "../finding.js";

/**
 * Static performance analysis.
 *
 * Every finding here is a *static* observation about code shape — a network
 * call in a loop, a synchronous filesystem call on a request path. None of it
 * measures anything: no timing, no profiling, no throughput claim. The report
 * says so explicitly, because "this pattern costs one round trip per item" is
 * defensible from source while "this endpoint takes 300ms" is not.
 *
 * ORM-specific N+1 detection lives in the ORM analyzers, which know what a
 * query call looks like for that ORM; this analyzer covers everything else.
 */

const ANALYZER_ID = "performance";

const HTTP_METHOD_DECORATORS = ["Get", "Post", "Put", "Patch", "Delete", "All"];
const SYNC_FS_CALLS = new Set([
  "readFileSync", "writeFileSync", "appendFileSync", "readdirSync", "statSync",
  "existsSync", "mkdirSync", "rmSync", "unlinkSync", "copyFileSync"
]);
const NETWORK_CALLS = new Set(["fetch", "request", "get", "post", "put", "patch", "delete", "axios"]);
const CRYPTO_SYNC_CALLS = new Set(["pbkdf2Sync", "scryptSync", "randomBytesSync", "hashSync", "compareSync"]);

export const performanceAnalyzer = {
  id: ANALYZER_ID,
  title: "Performance (static)",
  categories: ["Performance"],
  analyze({ index }) {
    const findings = [];
    for (const file of index.files) {
      findings.push(...checkNetworkCallsInLoops(file));
      findings.push(...checkSyncIoOnRequestPath(file, index));
      findings.push(...checkAwaitInLoop(file));
      findings.push(...checkUnboundedPromiseAll(file));
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// PERF-001 — outbound HTTP call inside a loop
// ---------------------------------------------------------------------------

function checkNetworkCallsInLoops({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node, loopDepth) => {
    const nextDepth = loopDepth + (isLoopLike(node) ? 1 : 0);
    if (loopDepth > 0 && ts.isCallExpression(node) && isNetworkCall(node)) {
      findings.push(createFinding({
        id: "PERF-001",
        category: "Performance",
        severity: "HIGH",
        confidence: "high",
        analyzer: ANALYZER_ID,
        title: "Outbound network call inside a loop",
        detail: `${describeCall(node, sourceFile)} runs once per iteration. Latency is paid serially, so total time grows linearly with collection size and the request path is at the mercy of the slowest upstream call.`,
        remediation: "Batch the calls into a single request where the upstream API supports it, or run them concurrently with a bounded pool (e.g. p-limit) rather than sequentially.",
        sourceFile,
        node,
        file: relativePath
      }));
    }
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  };
  visit(sourceFile, 0);
  return findings;
}

function isNetworkCall(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text === "fetch";
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  const base = node.expression.expression.getText();
  if (!NETWORK_CALLS.has(method)) return false;
  return /axios|http|client|api|fetch|got|request/i.test(base);
}

// ---------------------------------------------------------------------------
// PERF-002 — synchronous I/O on a request path
// ---------------------------------------------------------------------------

function checkSyncIoOnRequestPath({ sourceFile, relativePath }, index) {
  const findings = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && hasDecorator(node, ["Controller"])) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        if (!findDecorator(member, HTTP_METHOD_DECORATORS)) continue;
        collectSyncCalls(member.body, sourceFile, relativePath, findings, propertyName(member) || "handler");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function collectSyncCalls(body, sourceFile, relativePath, findings, handlerName) {
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      // Both `fs.readFileSync(...)` and a named import called directly.
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : (ts.isIdentifier(node.expression) ? node.expression.text : null);
      if (method && (SYNC_FS_CALLS.has(method) || CRYPTO_SYNC_CALLS.has(method))) {
        const isCrypto = CRYPTO_SYNC_CALLS.has(method);
        findings.push(createFinding({
          id: "PERF-002",
          category: "Performance",
          severity: isCrypto ? "HIGH" : "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Synchronous blocking call on a request path",
          detail: `${handlerName}() calls ${method}(...), which blocks the Node.js event loop. While it runs, this process serves no other request${isCrypto ? " — and a key-derivation function is deliberately slow" : ""}.`,
          remediation: isCrypto
            ? `Use the asynchronous form (${method.replace(/Sync$/, "")}) so hashing runs on the thread pool instead of the event loop.`
            : `Use the promise API (fs/promises) instead of ${method}, or move the work out of the request path entirely.`,
          sourceFile,
          node,
          file: relativePath
        }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

// ---------------------------------------------------------------------------
// PERF-003 — await inside a loop over independent work
// ---------------------------------------------------------------------------

function checkAwaitInLoop({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isForOfStatement(node) || ts.isForStatement(node)) {
      const awaits = [];
      const collect = (inner) => {
        if (ts.isAwaitExpression(inner)) awaits.push(inner);
        // Don't descend into a nested function: its awaits are not serialised
        // by this loop.
        if (!ts.isFunctionLike(inner)) ts.forEachChild(inner, collect);
      };
      collect(node.statement);
      // A loop body that also *writes* is often intentionally sequential
      // (ordering matters), so only read-shaped bodies are reported.
      const bodyText = node.statement.getText(sourceFile);
      const looksSequentialByDesign = /\b(save|insert|update|delete|create|commit|push\s*\(\s*await)/i.test(bodyText);
      if (awaits.length && !looksSequentialByDesign) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        findings.push({ ...createFinding({
          id: "PERF-003",
          category: "Performance",
          severity: "MEDIUM",
          confidence: "low",
          analyzer: ANALYZER_ID,
          title: "Awaited work is serialised across loop iterations",
          detail: `This loop awaits ${awaits.length} operation(s) per iteration, so each iteration waits for the previous one. If the iterations are independent the total latency is the sum rather than the maximum.`,
          remediation: "If the iterations are independent, collect the promises and await them together with a bounded concurrency limit. If ordering is required, leave as is.",
          sourceFile,
          node,
          file: relativePath
        }), supersededWithin: { startLine: start, endLine: end } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// PERF-004 — Promise.all over an unbounded collection
// ---------------------------------------------------------------------------

function checkUnboundedPromiseAll({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "all"
      && node.expression.expression.getText(sourceFile) === "Promise") {
      const [argument] = node.arguments;
      if (argument && ts.isCallExpression(argument) && ts.isPropertyAccessExpression(argument.expression)
        && argument.expression.name.text === "map") {
        const mapped = argument.expression.expression.getText(sourceFile);
        const bounded = /\.slice\s*\(|\.take\s*\(|chunk|batch|limit/i.test(mapped);
        const bodyText = argument.getText(sourceFile);
        const doesIo = /\bawait\b|fetch\(|\.query\(|\.find|\.create|\.save/i.test(bodyText);
        if (!bounded && doesIo) {
          findings.push(createFinding({
            id: "PERF-004",
            category: "Performance",
            severity: "MEDIUM",
            confidence: "medium",
            analyzer: ANALYZER_ID,
            title: "Promise.all over an unbounded collection",
            detail: `Promise.all(${mapped}.map(...)) starts one I/O operation per element with no concurrency limit. A large input opens as many sockets/connections at once, which exhausts the connection pool rather than going faster.`,
            remediation: "Bound the fan-out: process in chunks, or use a concurrency-limited map (p-limit / a batch size) so the number of in-flight operations is fixed.",
            sourceFile,
            node,
            file: relativePath
          }));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function describeCall(node, sourceFile) {
  const text = node.expression.getText(sourceFile);
  return `${text}(...)`;
}
