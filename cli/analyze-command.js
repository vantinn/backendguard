import { analyzeProject, defaultAnalyzers } from "../analysis/index.js";
import { EXIT, UsageError } from "./exit-codes.js";
import {
  meetsConfidence,
  meetsSeverity,
  parseConfidence,
  parseList,
  parseSeverity,
  resolveTargetDirectory
} from "./options.js";

/**
 * `backendguard analyze` — whole-project static analysis.
 *
 * `check` answers "what did this change introduce"; this answers "what is in
 * this repository right now", which is what you want in CI and on first
 * contact with an unfamiliar service.
 */

const CATEGORY_VALUES = ["security", "database", "performance", "scalability", "architecture", "testing"];

const VALUE_FLAGS = ["--severity", "--confidence", "--fail-on", "--category", "--analyzer"];

export function parseAnalyzeArgs(args, { cwd = process.cwd() } = {}) {
  const analyzerIds = defaultAnalyzers.map((analyzer) => analyzer.id);
  return {
    cwd: resolveTargetDirectory(args, { cwd, valueFlags: VALUE_FLAGS }),
    json: args.includes("--json"),
    listAnalyzers: args.includes("--list-analyzers"),
    severity: parseSeverity(args, "--severity"),
    confidence: parseConfidence(args, "--confidence"),
    failOn: parseSeverity(args, "--fail-on"),
    categories: parseList(args, "--category", { allowed: CATEGORY_VALUES, label: "category" }),
    analyzers: parseList(args, "--analyzer", { allowed: analyzerIds, label: "analyzer" })
  };
}

export function runAnalyzeCommand(args, { cwd = process.cwd(), log = console.log } = {}) {
  const options = parseAnalyzeArgs(args, { cwd });

  if (options.listAnalyzers) {
    log(formatAnalyzerList(defaultAnalyzers));
    return EXIT.OK;
  }

  const selected = options.analyzers
    ? defaultAnalyzers.filter((analyzer) => options.analyzers.includes(analyzer.id))
    : defaultAnalyzers;
  if (options.analyzers && !selected.length) {
    throw new UsageError("No analyzers matched --analyzer.", { hint: "Run `backendguard analyze --list-analyzers`." });
  }

  const result = analyzeProject({
    cwd: options.cwd,
    // An explicit --analyzer list is an override: run those analyzers even if
    // the detected stack would not have selected them, because that is what
    // the user asked for.
    analyzers: options.analyzers
      ? selected.map((analyzer) => ({ ...analyzer, appliesTo: undefined }))
      : selected
  });

  const categories = options.categories?.map((category) => category.toLowerCase());
  const findings = result.findings.filter((finding) =>
    meetsSeverity(finding, options.severity)
    && meetsConfidence(finding, options.confidence)
    && (!categories || categories.includes(String(finding.category).toLowerCase())));

  const payload = { ...result, findings, filtered: result.findings.length - findings.length };
  log(options.json ? JSON.stringify(payload, null, 2) : formatAnalysis(payload, options));

  const failing = options.failOn ? findings.filter((finding) => meetsSeverity(finding, options.failOn)) : [];
  return failing.length ? EXIT.FINDINGS : EXIT.OK;
}

export function formatAnalyzerList(analyzers) {
  const width = Math.max(...analyzers.map((analyzer) => analyzer.id.length)) + 2;
  const lines = ["Registered analyzers", ""];
  for (const analyzer of analyzers) {
    lines.push(`${analyzer.id.padEnd(width)}${analyzer.title} — ${analyzer.categories.join(", ")}`);
  }
  lines.push("", "An analyzer with a stack requirement only runs when that technology is detected.");
  return lines.join("\n");
}

export function formatAnalysis(result, options = {}) {
  const lines = ["BackendGuard analysis", ""];
  const stack = [result.stack.framework, result.stack.language, result.stack.database, result.stack.orm]
    .filter(Boolean).join(" · ") || "no backend stack detected";
  lines.push(`Project : ${result.stack.root}`);
  lines.push(`Stack   : ${stack}`);
  lines.push(`Files   : ${result.filesAnalyzed}${result.truncated ? " (scan limit reached — results are partial)" : ""}`);
  lines.push(`Analyzers: ${result.ran.join(", ") || "none"}`);
  if (result.skipped.length) lines.push(`Skipped : ${result.skipped.join(", ")} (technology not detected)`);
  lines.push("");

  if (!result.findings.length) {
    lines.push(result.filtered
      ? `No findings matched the filters (${result.filtered} filtered out).`
      : "No findings.");
    return lines.join("\n");
  }

  const bySeverity = groupBy(result.findings, (finding) => finding.severity);
  lines.push(`${result.findings.length} finding(s): ${Object.entries(bySeverity).map(([severity, items]) => `${items.length} ${severity}`).join(", ")}`);
  if (result.filtered) lines.push(`(${result.filtered} additional finding(s) hidden by the current filters)`);
  lines.push("");

  const byFile = groupBy(result.findings, (finding) => finding.file);
  for (const [file, findings] of Object.entries(byFile)) {
    lines.push(file);
    for (const finding of findings) {
      lines.push(`  ${finding.line}:${finding.column}  [${finding.severity}/${finding.confidence}] ${finding.id} ${finding.title}`);
      lines.push(`    ${finding.detail}`);
      if (finding.evidence) lines.push(`    evidence: ${finding.evidence}`);
      lines.push(`    fix: ${finding.remediation}`);
    }
    lines.push("");
  }

  if (result.errors?.length) {
    lines.push("Analyzer errors (other analyzers still ran):");
    for (const error of result.errors) lines.push(`  ${error.analyzer}: ${error.message}`);
    lines.push("");
  }

  lines.push("Performance and scalability findings are static observations about code shape.");
  lines.push("They are not measurements; no throughput or latency claim is made.");
  if (options.failOn) lines.push(`Exit code 1 is returned when any finding is ${options.failOn} or above.`);
  return lines.join("\n");
}

function groupBy(items, keyOf) {
  const grouped = {};
  for (const item of items) {
    const key = keyOf(item);
    (grouped[key] ||= []).push(item);
  }
  return grouped;
}
