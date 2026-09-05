import { createRegistry } from "./analyzer-registry.js";
import { buildSourceIndex } from "./source-index.js";
import { detectStack } from "./stack-detector.js";
import { nestjsSecurityAnalyzer } from "./security/nestjs-security-analyzer.js";
import { typeormAnalyzer } from "./database/typeorm-analyzer.js";
import { prismaAnalyzer } from "./database/prisma-analyzer.js";
import { postgresqlAnalyzer } from "./database/postgresql-analyzer.js";
import { performanceAnalyzer } from "./performance/performance-analyzer.js";
import { scalabilityAnalyzer } from "./scalability/scalability-analyzer.js";

/**
 * The analysis pipeline: detect the stack once, parse the project once, then
 * run every analyzer that applies to that stack.
 *
 * Registering a new analyzer here is the only change needed to add support for
 * another framework, ORM, database, or analysis category.
 */

export const defaultAnalyzers = [
  nestjsSecurityAnalyzer,
  typeormAnalyzer,
  prismaAnalyzer,
  postgresqlAnalyzer,
  performanceAnalyzer,
  scalabilityAnalyzer
];

export function createAnalyzerRegistry(analyzers = defaultAnalyzers) {
  return createRegistry(analyzers);
}

/**
 * @param {{cwd: string, files?: string[], stack?: object, analyzers?: Array}} options
 * @returns {{findings, stack, ran, errors, skipped, filesAnalyzed, truncated}}
 */
export function analyzeProject({ cwd, files, stack, analyzers = defaultAnalyzers, limits } = {}) {
  const resolvedStack = stack || detectStack({ cwd });
  const index = buildSourceIndex({ cwd, files, limits });
  const registry = createRegistry(analyzers);
  const context = { cwd, index, stack: resolvedStack, files };
  const { findings, ran, errors } = registry.run(context);
  const skipped = registry.list().map((analyzer) => analyzer.id).filter((id) => !ran.includes(id));

  return {
    findings,
    stack: resolvedStack,
    ran,
    skipped,
    errors,
    filesAnalyzed: index.files.length,
    truncated: index.truncated
  };
}

/**
 * Runs the full pipeline but returns only findings located in the files the
 * current change touched.
 *
 * The whole project is still analyzed, because cross-file resolution (entity →
 * service → controller) needs files the diff didn't touch. Scoping the *output*
 * keeps `backendguard check` answering "what does this change introduce or
 * leave behind" instead of dumping every pre-existing finding on every run.
 *
 * Fails open: an analysis error must never take down the rest of the report.
 */
export function analyzeChangedFiles({ cwd, changedFiles = [], stack } = {}) {
  if (!changedFiles.length) return { findings: [], stack: stack || null, ran: [], errors: [] };
  try {
    const result = analyzeProject({ cwd, stack });
    const changed = new Set(changedFiles);
    return { ...result, findings: result.findings.filter((finding) => changed.has(finding.file)) };
  } catch (error) {
    return { findings: [], stack: stack || null, ran: [], errors: [{ analyzer: "pipeline", message: error.message }] };
  }
}

/**
 * Adapts findings into the `{ rule, status, kind, evidence, matchedLines }`
 * shape the compliance reporter renders, so structural findings and
 * rule-derived findings share one rendering path.
 *
 * Structural findings always land in the "ignored" bucket: they are concrete
 * detections with evidence, not guesses about whether a written rule was
 * respected.
 */
export function toComplianceItems(findings) {
  return findings.map((finding) => ({
    rule: {
      id: finding.id,
      sourcePath: `analysis:${finding.analyzer}`,
      content: `${finding.title}. ${finding.detail}`,
      structural: true,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      remediation: finding.remediation
    },
    status: "ignored",
    kind: "structural",
    keywords: [],
    evidence: `${finding.file}:${finding.line}`,
    matchedLines: [{ file: finding.file, line: finding.line, content: finding.evidence || finding.detail }]
  }));
}

/** Convenience wrapper kept for the CLI/stop-hook call sites. */
export function structuralComplianceForChangedFiles({ cwd, changedFiles = [] } = {}) {
  return toComplianceItems(analyzeChangedFiles({ cwd, changedFiles }).findings);
}

export { detectStack };
