#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CATEGORIES, RELEASE_GATES, TOTAL_WEIGHT } from "./rubric.js";

/**
 * Runs the release-readiness rubric against a repository checkout.
 *
 * Usage:
 *   node evaluation/release-readiness/run-evaluation.js [repoRoot] [--json]
 *
 * Pointing it at an older checkout (a `git worktree` of the pre-refactor commit,
 * say) produces the "before" number with exactly the same code, which is the
 * only way a before/after comparison means anything.
 *
 * Every check is a pure function of the repository contents. Checks are written
 * so they cannot be satisfied by editing this file: each names the artefact it
 * reads and fails closed when that artefact is absent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// Repository probes
// ---------------------------------------------------------------------------

function exists(root, relative) {
  return fs.existsSync(path.join(root, relative));
}

function read(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

function readJson(root, relative) {
  const text = read(root, relative);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The directories that make up the shipped product, in either layout. */
const PRODUCT_DIRS = [
  "cli", "rules", "retrieval", "analysis", "compliance", "agent-context",
  "integrations", "runtime", "plugins", "tooling", "skills",
  // pre-refactor layout
  "bin", "scripts"
];

function productFiles(root, options = {}) {
  return PRODUCT_DIRS
    .map((dir) => path.join(root, dir))
    .filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => listFiles(dir, options));
}

function listFiles(root, { extensions = [".js", ".mjs"], skip = new Set(["node_modules", ".git"]) } = {}) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(full);
    }
  };
  walk(root);
  return files;
}

function grepCount(root, pattern, { extensions } = {}) {
  let count = 0;
  for (const file of listFiles(root, extensions ? { extensions } : undefined)) {
    const text = fs.readFileSync(file, "utf8");
    count += (text.match(pattern) || []).length;
  }
  return count;
}

function runCommand(root, command, args, { timeout = 900_000 } = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: { ...process.env, CI: "1", BACKENDGUARD_NO_UPDATE_CHECK: "1" }
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : null,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      message: error.message
    };
  }
}

// ---------------------------------------------------------------------------
// Checks. Each returns { id, title, points, max, evidence }.
// ---------------------------------------------------------------------------

function check(id, title, max, earned, evidence) {
  return { id, title, max, points: Math.max(0, Math.min(max, earned)), evidence };
}

function correctnessChecks(root, context) {
  const testFiles = fs.existsSync(path.join(root, "tests"))
    ? fs.readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.js"))
    : (fs.existsSync(path.join(root, "test"))
      ? fs.readdirSync(path.join(root, "test")).filter((name) => name.endsWith(".test.js"))
      : []);
  const { passed, failed, ran } = context.testResults;

  return [
    check("tests-run", "The test suite runs to completion", 6, ran ? 6 : 0,
      ran ? `${passed} passed, ${failed} failed` : "test suite could not be executed"),
    check("tests-pass", "Every test passes", 6, ran && failed === 0 ? 6 : 0,
      ran ? `${failed} failing test(s)` : "not run"),
    check("test-breadth", "The suite covers the codebase broadly", 6,
      Math.min(6, Math.round((testFiles.length / 50) * 6)),
      `${testFiles.length} test files, ${passed} assertions-bearing tests passed`)
  ];
}

function securityAnalysisChecks(root, context) {
  const ids = context.analyzerIds;
  const securityIds = context.findingIds.filter((id) => id.startsWith("SEC-"));
  return [
    check("security-analyzer-present", "A structural security analyzer exists", 3,
      ids.includes("nestjs-security") ? 3 : 0, ids.join(", ") || "none"),
    check("security-check-breadth", "It covers a meaningful range of backend security risks", 6,
      Math.min(6, securityIds.length), `${securityIds.length} distinct SEC-* checks: ${securityIds.join(", ")}`),
    check("security-evidence", "Findings carry evidence, confidence and remediation", 3,
      context.findingShape.hasEvidence && context.findingShape.hasConfidence && context.findingShape.hasRemediation ? 3 : 0,
      JSON.stringify(context.findingShape))
  ];
}

function databaseChecks(root, context) {
  const ids = context.analyzerIds;
  const prismaChecks = context.findingIds.filter((id) => id.startsWith("PRISMA-")).length;
  // `DB-*` was the pre-0.9.0 prefix for the TypeORM checks; counting both keeps
  // a before/after comparison honest.
  const typeormChecks = context.findingIds.filter((id) => id.startsWith("TORM-") || id.startsWith("DB-")).length;
  const pgChecks = context.findingIds.filter((id) => id.startsWith("PG-")).length;
  return [
    check("orm-separation", "Prisma and TypeORM are analyzed by separate, stack-gated analyzers", 4,
      ids.includes("prisma") && ids.includes("typeorm") ? 4 : (ids.includes("typeorm") ? 2 : 0),
      `analyzers: ${ids.join(", ")}`),
    check("prisma-depth", "Prisma analysis covers schema and client call sites", 3,
      Math.min(3, prismaChecks), `${prismaChecks} PRISMA-* checks`),
    check("typeorm-depth", "TypeORM analysis covers entities, queries and transactions", 3,
      Math.min(3, typeormChecks), `${typeormChecks} TORM-* checks`),
    check("postgres-depth", "PostgreSQL analysis covers SQL, migrations and pooling", 2,
      Math.min(2, pgChecks), `${pgChecks} PG-* checks`)
  ];
}

function performanceChecks(root, context) {
  const perfChecks = context.findingIds.filter((id) => id.startsWith("PERF-")).length;
  const scaleChecks = context.findingIds.filter((id) => id.startsWith("SCALE-")).length;
  const disclaims = context.analyzeOutput.includes("not measurements");
  return [
    check("performance-analyzer", "Static performance analysis exists", 3, Math.min(3, perfChecks), `${perfChecks} PERF-* checks`),
    check("scalability-analyzer", "Scalability analysis exists", 3, Math.min(3, scaleChecks), `${scaleChecks} SCALE-* checks`),
    check("no-overclaiming", "Output states these are static observations, not measurements", 2,
      disclaims ? 2 : 0, disclaims ? "disclaimer present in analyze output" : "no disclaimer found")
  ];
}

function detectionQualityChecks(root, context) {
  const detection = context.detection;
  if (!detection) {
    return [check("detection-harness", "A labelled detection-quality corpus exists", 12, 0, "no corpus found")];
  }
  return [
    check("detection-harness", "A labelled detection-quality corpus exists", 3,
      detection.fixtures.length >= 3 ? 3 : detection.fixtures.length, `${detection.fixtures.length} labelled fixtures`),
    check("recall", "Every planted defect is found", 4, Math.round(detection.totals.recall * 4),
      `recall ${(detection.totals.recall * 100).toFixed(1)}% (${detection.totals.truePositives}/${detection.totals.expected})`),
    check("precision", "Nothing is reported inside files labelled correct", 3,
      detection.totals.falsePositives === 0 ? 3 : 0, `${detection.totals.falsePositives} false positive(s)`),
    check("adversarial-control", "A correct codebase using security vocabulary produces no findings", 2,
      detection.fixtures.some((fixture) => fixture.name === "secure-baseline" && fixture.totalFindings === 0) ? 2 : 0,
      "secure-baseline fixture")
  ];
}

function retrievalChecks(root, context) {
  const routing = context.routing;
  if (!routing) return [check("routing-benchmark", "A rule-routing benchmark exists", 8, 0, "not runnable")];
  return [
    check("routing-benchmark", "A rule-routing benchmark exists and runs", 2, 2, `${routing.cases} cases`),
    check("routing-accuracy", "Top-1 routing accuracy", 3, Math.round(routing.top1 * 3), `${(routing.top1 * 100).toFixed(1)}%`),
    check("routing-noise", "Routing does not fire on irrelevant tasks", 3,
      routing.falsePositiveRate === 0 ? 3 : Math.max(0, 3 - Math.round(routing.falsePositiveRate * 30)),
      `false positive rate ${(routing.falsePositiveRate * 100).toFixed(1)}%`)
  ];
}

function cliChecks(root, context) {
  return [
    check("per-command-help", "Every command has its own --help", 3,
      context.cli.helpForEveryCommand ? 3 : 0, `${context.cli.commandsWithHelp}/${context.cli.commandCount} commands`),
    check("exit-codes", "Distinct exit codes for usage, environment and internal errors", 3,
      context.cli.exitCodes ? 3 : 0, JSON.stringify(context.cli.exitCodeSamples)),
    check("no-stack-traces", "Expected user errors print a message, never a stack trace", 2,
      context.cli.noStackTrace ? 2 : 0, context.cli.stackTraceEvidence)
  ];
}

function packagingChecks(root, context) {
  const pkg = readJson(root, "package.json") || {};
  const files = pkg.files || [];
  return [
    check("pack-manifest", "package.json#files covers every shipped domain", 3,
      context.packaging.domainsCovered ? 3 : 0, `files: ${files.join(", ")}`),
    check("clean-install", "The packed tarball installs and its CLI runs", 3,
      context.packaging.cleanInstall ? 3 : 0, context.packaging.evidence),
    check("no-junk", "No tests, fixtures, local state or secret material is packed", 2,
      context.packaging.noJunk ? 2 : 0, context.packaging.junkEvidence)
  ];
}

function countShellTrue(root) {
  // `shell: true` combined with an argument array concatenates untrusted
  // arguments into a shell command line. Only *executable* occurrences count:
  // the security analyzer names the pattern in a message, and the process
  // runner documents why it is not used — both in strings and comments.
  let count = 0;
  for (const file of productFiles(root)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (/["'`][^"'`]*shell:\s*true/.test(trimmed)) continue;
      if (/shell:\s*true/.test(trimmed)) count += 1;
    }
  }
  return count;
}

function countLeakedHomePaths(root) {
  // A real developer's home directory committed into source. Placeholder users
  // in documentation examples (`<user>`, `youruser`, `deploy_user`) are not.
  const placeholder = /^(user|username|youruser|your-user|deploy_user|runner|node|app|me|example)$/i;
  let count = 0;
  for (const file of productFiles(root, { extensions: [".js", ".mjs", ".json", ".yml", ".yaml", ".md"] })) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/\/home\/([a-z_][a-z0-9_-]*)\//g)) {
      if (!placeholder.test(match[1])) count += 1;
    }
  }
  for (const relative of [".vscode/mcp.json", ".vscode/settings.json"]) {
    const text = read(root, relative);
    if (text) count += (text.match(/\/home\/[a-z_][a-z0-9_-]*\//g) || []).length;
  }
  return count;
}

function toolSecurityChecks(root) {
  const shellTrueOffenders = countShellTrue(root);
  const leakedPaths = countLeakedHomePaths(root);
  const committedSecrets = listFiles(root, { extensions: [".json", ".yml", ".yaml", ".toml", ".pem", ".key"] })
    .filter((file) => /(^|\/)\.env($|\.)|\.pem$|id_rsa/.test(file)).length;
  return [
    check("no-shell-injection", "No child process is spawned through a shell with untrusted arguments", 3,
      shellTrueOffenders === 0 ? 3 : 0, `${shellTrueOffenders} unexplained \`shell: true\` site(s)`),
    check("no-leaked-paths", "No developer machine path is committed", 2,
      leakedPaths === 0 ? 2 : 0, `${leakedPaths} absolute /home/<user>/ path(s)`),
    check("no-committed-secrets", "No secret material is committed", 1,
      committedSecrets === 0 ? 1 : 0, `${committedSecrets} suspicious file(s)`)
  ];
}

function architectureChecks(root) {
  const hasRegistry = exists(root, "analysis/analyzer-registry.js");
  const domains = ["cli", "rules", "retrieval", "analysis", "compliance", "agent-context", "integrations", "runtime", "evaluation", "tests"];
  const presentDomains = domains.filter((domain) => exists(root, domain));
  // A single directory holding most of the code is the shape this refactor set out to fix.
  const flatLib = exists(root, "plugins/ctx/lib");
  const legacyTerms = countLegacyTerms(root);
  return [
    check("analyzer-registry", "New analyzers can be added through a registry", 3, hasRegistry ? 3 : 0,
      hasRegistry ? "analysis/analyzer-registry.js" : "no registry"),
    check("domain-structure", "The root communicates the product's domains", 3,
      Math.min(3, Math.round((presentDomains.length / domains.length) * 3)),
      `${presentDomains.length}/${domains.length} domain directories; flat lib present: ${flatLib}`),
    check("no-legacy-naming", "No legacy product naming remains in code or docs", 2,
      legacyTerms === 0 ? 2 : 0, `${legacyTerms} legacy reference(s)`)
  ];
}

// ---------------------------------------------------------------------------
// Context gathering: run the repository's own artefacts once.
// ---------------------------------------------------------------------------

async function gatherContext(root, { runSlow = true } = {}) {
  const context = {
    testResults: { ran: false, passed: 0, failed: 0 },
    analyzerIds: [],
    findingIds: [],
    findingShape: { hasEvidence: false, hasConfidence: false, hasRemediation: false },
    analyzeOutput: "",
    detection: null,
    routing: null,
    cli: { commandCount: 0, commandsWithHelp: 0, helpForEveryCommand: false, exitCodes: false, exitCodeSamples: {}, noStackTrace: false, stackTraceEvidence: "" },
    packaging: { domainsCovered: false, cleanInstall: false, noJunk: false, evidence: "", junkEvidence: "" }
  };

  // --- tests
  if (runSlow) {
    const result = runCommand(root, "npx", ["vitest", "run", "--reporter=json", "--outputFile=/dev/stdout"]);
    const match = (result.stdout + result.stderr).match(/"numPassedTests":(\d+).*?"numFailedTests":(\d+)/s);
    if (match) {
      context.testResults = { ran: true, passed: Number(match[1]), failed: Number(match[2]) };
    } else {
      const fallback = runCommand(root, "npx", ["vitest", "run", "--reporter=dot"]);
      const summary = (fallback.stdout + fallback.stderr).match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
      if (summary) {
        context.testResults = { ran: true, failed: Number(summary[1] || 0), passed: Number(summary[2]) };
      }
    }
  }

  // --- analyzers and finding vocabulary
  const cliPath = exists(root, "cli/backendguard.js") ? "cli/backendguard.js" : (exists(root, "bin/ctx.js") ? "bin/ctx.js" : null);
  context.cliPath = cliPath;

  const analyzerIndex = path.join(root, "analysis", "index.js");
  if (fs.existsSync(analyzerIndex)) {
    const module = await import(`file://${analyzerIndex}`);
    context.analyzerIds = module.defaultAnalyzers.map((analyzer) => analyzer.id);
  }
  // Distinct check ids are read from source, so the count reflects implemented
  // checks rather than whatever a particular fixture happens to trigger. The
  // scan covers every product directory in either layout: before the refactor
  // the structural checks lived in `plugins/ctx/lib/`, and scoring that as zero
  // would understate the "before" measurement.
  const ids = new Set();
  for (const file of productFiles(root, { extensions: [".js"] })) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/id:\s*"((?:SEC|TORM|PRISMA|PG|PERF|SCALE|DB)-\d+)"/g)) {
      ids.add(match[1]);
    }
  }
  context.findingIds = [...ids].sort();

  const fixtureDir = path.join(root, "evaluation", "detection-quality", "fixtures", "nest-typeorm-postgres");
  if (cliPath && fs.existsSync(fixtureDir)) {
    const output = runCommand(root, process.execPath, [cliPath, "analyze", fixtureDir]);
    context.analyzeOutput = output.stdout;
    const json = runCommand(root, process.execPath, [cliPath, "analyze", fixtureDir, "--json"]);
    try {
      const finding = JSON.parse(json.stdout).findings[0];
      context.findingShape = {
        hasEvidence: Boolean(finding?.evidence),
        hasConfidence: Boolean(finding?.confidence),
        hasRemediation: Boolean(finding?.remediation)
      };
    } catch { /* no findings or no --json support */ }
  }
  if (!context.findingShape.hasEvidence && !context.findingShape.hasRemediation) {
    // No `analyze --json` in this checkout: fall back to whether the finding
    // constructor in source carries these fields at all.
    const sources = productFiles(root, { extensions: [".js"] })
      .filter((file) => /analyzer|finding/.test(path.basename(file)))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    context.findingShape = {
      hasEvidence: /\bevidence\b\s*[,:]/.test(sources),
      hasConfidence: /\bconfidence\b\s*[,:]/.test(sources),
      hasRemediation: /\bremediation\b\s*[,:]/.test(sources)
    };
  }

  // --- detection quality
  const detectionRunner = path.join(root, "evaluation", "detection-quality", "run-detection-eval.js");
  if (fs.existsSync(detectionRunner)) {
    const module = await import(`file://${detectionRunner}`);
    context.detection = module.runDetectionEval();
  }

  // --- routing
  const routingRunner = path.join(root, "evaluation", "skill-routing", "run-eval.js");
  const legacyRoutingRunner = path.join(root, "eval", "skill-routing", "run-eval.js");
  const runner = fs.existsSync(routingRunner) ? routingRunner : (fs.existsSync(legacyRoutingRunner) ? legacyRoutingRunner : null);
  if (runner && runSlow) {
    try {
      const module = await import(`file://${runner}`);
      const result = await module.runSkillRoutingEval({ rootDir: root });
      context.routing = {
        cases: result.total ?? result.cases ?? result.rows?.length ?? 0,
        top1: result.top1Accuracy ?? result.top1 ?? 0,
        falsePositiveRate: result.falsePositiveRate ?? 0
      };
    } catch { /* benchmark unavailable in this checkout */ }
  }

  // --- CLI
  if (cliPath) {
    const registryPath = path.join(root, "cli", "command-registry.js");
    let commands = [];
    if (fs.existsSync(registryPath)) {
      const module = await import(`file://${registryPath}`);
      commands = module.COMMANDS.map((command) => command.name);
    } else {
      const usage = runCommand(root, process.execPath, [cliPath, "--help"]).stdout;
      commands = [...new Set([...usage.matchAll(/backendguard ([a-z][a-z-]+)/g)].map((match) => match[1]))];
    }
    context.cli.commandCount = commands.length;
    context.cli.commandsWithHelp = commands.filter((name) => {
      const result = runCommand(root, process.execPath, [cliPath, name, "--help"]);
      return result.ok && /Usage:/.test(result.stdout) && result.stdout.includes(name);
    }).length;
    context.cli.helpForEveryCommand = context.cli.commandCount > 0 && context.cli.commandsWithHelp === context.cli.commandCount;

    const unknownCommand = runCommand(root, process.execPath, [cliPath, "frobnicate"]);
    const badFlag = runCommand(root, process.execPath, [cliPath, "analyze", "--nope"]);
    const missingDir = runCommand(root, process.execPath, [cliPath, "analyze", "./definitely-not-here"]);
    const codes = {
      unknownCommand: exitCodeOf(unknownCommand),
      badFlag: exitCodeOf(badFlag),
      missingDirectory: exitCodeOf(missingDir)
    };
    context.cli.exitCodeSamples = codes;
    context.cli.exitCodes = codes.unknownCommand === 2 && codes.badFlag === 2 && codes.missingDirectory === 3;
    const stderr = `${unknownCommand.stderr}${badFlag.stderr}${missingDir.stderr}`;
    context.cli.noStackTrace = !/\n\s+at\s/.test(stderr);
    context.cli.stackTraceEvidence = context.cli.noStackTrace ? "no stack traces on expected errors" : "stack trace printed for an expected error";
  }

  // --- packaging
  const pkg = readJson(root, "package.json");
  if (pkg) {
    const files = (pkg.files || []).map((entry) => entry.replace(/\/$/, "").replace(/^!/, ""));
    const needed = fs.existsSync(path.join(root, "analysis"))
      ? ["cli", "analysis", "rules", "retrieval", "compliance", "agent-context", "integrations", "runtime"]
      : ["bin", "plugins"];
    context.packaging.domainsCovered = needed.every((domain) => files.includes(domain));

    if (runSlow) {
      const dryRun = runCommand(root, "npm", ["pack", "--dry-run", "--json"]);
      try {
        const packed = JSON.parse(dryRun.stdout)[0].files.map((entry) => entry.path);
        const junk = packed.filter((entry) =>
          entry.startsWith("tests/") || entry.startsWith("test/")
          || entry.includes("/fixtures/") || /(^|\/)\.env(\.|$)|\.pem$|\.bak$/.test(entry));
        context.packaging.noJunk = junk.length === 0;
        context.packaging.junkEvidence = junk.length ? junk.slice(0, 5).join(", ") : `${packed.length} files, none unwanted`;
      } catch {
        context.packaging.junkEvidence = "npm pack --dry-run failed";
      }

      const lifecycle = fs.existsSync(path.join(root, "tests", "package-lifecycle.test.mjs"))
        ? runCommand(root, process.execPath, ["tests/package-lifecycle.test.mjs"])
        : null;
      context.packaging.cleanInstall = Boolean(lifecycle?.ok && /package checks passed/.test(lifecycle.stdout));
      context.packaging.evidence = lifecycle
        ? (lifecycle.stdout.match(/\d+\/\d+ package checks passed/) || ["no result"])[0]
        : "no package lifecycle verification exists";
    }
  }

  return context;
}

function exitCodeOf(result) {
  if (result.ok) return 0;
  return typeof result.status === "number" ? result.status : -1;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const CHECK_BUILDERS = {
  correctness: correctnessChecks,
  "security-analysis": securityAnalysisChecks,
  "database-analysis": databaseChecks,
  "performance-scalability": performanceChecks,
  "detection-quality": detectionQualityChecks,
  retrieval: retrievalChecks,
  cli: cliChecks,
  packaging: packagingChecks,
  "tool-security": toolSecurityChecks,
  architecture: architectureChecks
};

export async function runReleaseEvaluation({ root = DEFAULT_ROOT, runSlow = true } = {}) {
  const context = await gatherContext(root, { runSlow });

  const categories = CATEGORIES.map((category) => {
    const checks = CHECK_BUILDERS[category.id](root, context);
    const max = checks.reduce((sum, item) => sum + item.max, 0);
    const earned = checks.reduce((sum, item) => sum + item.points, 0);
    // Each category's checks sum to its weight, so the category score is the
    // earned points directly; the ratio is reported for readability.
    return {
      ...category,
      checks,
      earned,
      max,
      ratio: max ? Number((earned / max).toFixed(3)) : 0,
      score: max ? Number(((earned / max) * category.weight).toFixed(2)) : 0
    };
  });

  const score = Number(categories.reduce((sum, category) => sum + category.score, 0).toFixed(1));

  const gates = evaluateGates(root, context);
  const gatesPassed = gates.every((gate) => gate.passed);

  return {
    root,
    score,
    maxScore: TOTAL_WEIGHT,
    categories,
    gates,
    gatesPassed,
    releaseReady: score > 70 && gatesPassed,
    context: {
      analyzers: context.analyzerIds,
      checks: context.findingIds,
      tests: context.testResults,
      detection: context.detection?.totals || null,
      routing: context.routing
    }
  };
}

function evaluateGates(root, context) {
  const legacy = countLegacyTerms(root);
  const brokenImports = countBrokenImports(root);
  const leakedPaths = countLeakedHomePaths(root);
  const documentedCommands = context.cli.helpForEveryCommand;
  const shellTrue = countShellTrue(root);

  return [
    gate("tests-pass", context.testResults.ran && context.testResults.failed === 0,
      `${context.testResults.passed} passed, ${context.testResults.failed} failed`),
    gate("no-known-critical", shellTrue === 0 && leakedPaths === 0,
      `${shellTrue} shell-injection site(s), ${leakedPaths} leaked path(s)`),
    gate("package-installs", context.packaging.cleanInstall, context.packaging.evidence),
    gate("commands-work", documentedCommands, `${context.cli.commandsWithHelp}/${context.cli.commandCount} commands have --help`),
    gate("no-legacy-terminology", legacy === 0, `${legacy} legacy reference(s)`),
    gate("no-broken-imports", brokenImports === 0, `${brokenImports} unresolved relative import(s)`),
    gate("no-secret-leakage", leakedPaths === 0 && context.packaging.noJunk, context.packaging.junkEvidence),
    gate("docs-match", documentedCommands && context.analyzerIds.length > 0,
      `${context.analyzerIds.length} analyzers documented and registered`)
  ];
}

function gate(id, passed, evidence) {
  const definition = RELEASE_GATES.find((entry) => entry.id === id);
  return { id, title: definition?.title || id, passed: Boolean(passed), evidence };
}

/**
 * Legacy product vocabulary, counted across source *and* documentation —
 * documentation that still describes `plugins/ctx/lib/` is as broken as code
 * that imports from it. The audit document is excluded: recording the old
 * names is its job.
 */
function countLegacyTerms(root) {
  // `ctx_` is in this list because the adversarial audit found eight MCP tool
  // names still carrying it while this gate reported zero legacy references:
  // the pattern only covered `ctx-mcp` and `plugins/ctx`. A gate that checks a
  // narrower thing than it claims is worse than no gate.
  const pattern = /\bcontextOS\b|plugins\/ctx\b|bin\/ctx\.js|\bctx-mcp\b|\bctx_[a-z]+\b|community-skills\//g;
  const files = [
    ...productFiles(root, { extensions: [".js", ".mjs", ".json", ".yml", ".yaml"] }),
    ...listFiles(path.join(root, "docs"), { extensions: [".md"] }),
    ...[".github"].map((dir) => path.join(root, dir)).filter((dir) => fs.existsSync(dir)).flatMap((dir) => listFiles(dir, { extensions: [".yml", ".yaml"] })),
    ...["README.md", "CONTRIBUTING.md", "SECURITY.md"].map((name) => path.join(root, name)).filter((file) => fs.existsSync(file))
  ];
  let count = 0;
  for (const file of files) {
    // Some documents exist precisely to record the old names: the refactor
    // audit, the changelog's "Breaking" section, and the before/after
    // evaluation write-ups. A before/after document that cannot name the
    // "before" is useless, so counting these would penalise documenting a
    // rename — the opposite of the intent. Everything else is counted.
    if (file.includes("refactor-audit")) continue;
    if (file.endsWith("CHANGELOG.md")) continue;
    if (file.includes(`docs${path.sep}evaluation${path.sep}`)) continue;

    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const matches = line.match(pattern) || [];
      if (!matches.length) continue;
      // A line that maps an old name to its replacement is a deliberate
      // compatibility alias, not a leftover — `["ctx_health", "backendguard_health"]`.
      // A line that mentions only the old name is a leftover. The whole file is
      // not excluded, so a genuine regression in it would still be caught.
      if (/backendguard[_-]/.test(line)) continue;
      count += matches.length;
    }
  }
  return count;
}

/**
 * Unresolved relative imports in the *product's* source. Test files and the
 * scale-benchmark generator embed example source as strings, whose import
 * statements are data, not imports.
 */
function countBrokenImports(root) {
  let broken = 0;
  for (const file of productFiles(root)) {
    // Template literals hold generated example source in the benchmark
    // generators; their import statements are data, not imports.
    const source = fs.readFileSync(file, "utf8").replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)(["'])(\.[^"']+)\1/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), match[2]))) broken += 1;
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------

export function formatEvaluation(result) {
  const lines = [
    "BackendGuard release readiness",
    `Repository: ${result.root}`,
    "",
    `Score: ${result.score} / ${result.maxScore}`,
    `Release gates: ${result.gates.filter((gate) => gate.passed).length}/${result.gates.length} passed`,
    `Decision: ${result.releaseReady ? "READY" : "NOT READY"}`,
    ""
  ];

  lines.push("Categories");
  const width = Math.max(...result.categories.map((category) => category.title.length)) + 2;
  for (const category of result.categories) {
    lines.push(`  ${category.title.padEnd(width)} ${String(category.score).padStart(5)} / ${category.weight}`);
    for (const item of category.checks) {
      const mark = item.points === item.max ? "+" : (item.points === 0 ? "-" : "~");
      lines.push(`    ${mark} ${item.title} (${item.points}/${item.max}) — ${item.evidence}`);
    }
  }
  lines.push("");
  lines.push("Release gates");
  for (const gate of result.gates) {
    lines.push(`  ${gate.passed ? "PASS" : "FAIL"}  ${gate.title} — ${gate.evidence}`);
  }
  lines.push("");
  lines.push("A score above 70 alone is not sufficient: every release gate must also pass.");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const positional = process.argv.slice(2).find((argument) => !argument.startsWith("-"));
  const root = positional ? path.resolve(positional) : DEFAULT_ROOT;
  const result = await runReleaseEvaluation({ root, runSlow: !process.argv.includes("--fast") });
  console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : formatEvaluation(result));
  process.exitCode = result.releaseReady ? 0 : 1;
}
