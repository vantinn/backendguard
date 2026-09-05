import ts from "typescript";

/**
 * The single finding shape every analyzer produces.
 *
 * Fields are fixed so that reporting, scoring, and the detection-quality
 * evaluation can all treat findings uniformly regardless of which analyzer
 * produced them.
 *
 * @typedef {object} Finding
 * @property {string}  id           Stable check id, e.g. "SEC-003", "PG-002".
 * @property {string}  category     One of CATEGORIES.
 * @property {string}  severity     One of SEVERITIES.
 * @property {string}  confidence   One of CONFIDENCE_LEVELS.
 * @property {string}  analyzer     Id of the analyzer that produced it.
 * @property {string}  title        One-line statement of the problem.
 * @property {string}  detail       Why this specific code triggers it.
 * @property {string}  evidence     The source construct the finding is anchored to.
 * @property {string}  remediation  Concrete fix.
 * @property {string}  file         Project-relative path.
 * @property {number}  line         1-indexed line.
 * @property {number}  column       1-indexed column.
 */

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/**
 * Confidence describes how much of the finding was *proven* from syntax:
 * - `certain`  the construct itself is the defect; no inference involved.
 * - `high`     inferred across one resolution step (declared type, decorator).
 * - `medium`   inferred across several steps, or from a naming convention.
 * - `low`      a real signal that is legitimate in some designs; needs review.
 */
export const CONFIDENCE_LEVELS = ["certain", "high", "medium", "low"];

export const CATEGORIES = [
  "Security",
  "Database",
  "Performance",
  "Scalability",
  "Architecture",
  "Testing"
];

const SEVERITY_WEIGHT = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
const CONFIDENCE_WEIGHT = { certain: 4, high: 3, medium: 2, low: 1 };

export function severityWeight(severity) {
  return SEVERITY_WEIGHT[severity] || 0;
}

export function confidenceWeight(confidence) {
  return CONFIDENCE_WEIGHT[confidence] || 0;
}

/**
 * Builds a finding anchored to a concrete AST node, so `file:line:column` always
 * points at the construct that caused it rather than at the top of the file.
 */
export function createFinding({
  id,
  category,
  severity,
  confidence,
  analyzer,
  title,
  detail,
  evidence,
  remediation,
  sourceFile,
  node,
  file
}) {
  const relativePath = file || sourceFile?.fileName || "unknown";
  let line = 0;
  let column = 0;
  let evidenceText = evidence;
  if (sourceFile && node) {
    const position = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
    line = position.line + 1;
    column = position.character + 1;
    if (!evidenceText) evidenceText = firstLine(node.getText(sourceFile));
  }
  return {
    id,
    category,
    severity,
    confidence,
    analyzer,
    title,
    detail,
    evidence: evidenceText || "",
    remediation,
    file: relativePath,
    line,
    column,
    location: `${relativePath}:${line}`
  };
}

/** Finding for a non-TypeScript source (a `.prisma` schema, a `.sql` migration). */
export function createTextFinding({
  id,
  category,
  severity,
  confidence,
  analyzer,
  title,
  detail,
  evidence,
  remediation,
  file,
  line = 0
}) {
  return {
    id,
    category,
    severity,
    confidence,
    analyzer,
    title,
    detail,
    evidence: evidence ? firstLine(evidence) : "",
    remediation,
    file,
    line,
    column: 0,
    location: `${file}:${line}`
  };
}

/**
 * A broad, low-confidence finding is dropped when a specific, higher-confidence
 * finding already explains the same code.
 *
 * The concrete case this exists for: "awaited work is serialised across loop
 * iterations" (PERF-003) fires on exactly the same loop as "repository query
 * inside a loop" (TORM-002/PRISMA-011) and "outbound network call inside a
 * loop" (PERF-001). Reporting both says the same thing twice and buries the
 * one with the actionable fix. Findings opt in by carrying `supersededWithin`
 * with the line range they cover.
 */
export function suppressSupersededFindings(findings) {
  const specific = findings.filter((finding) => !finding.supersededWithin && confidenceWeight(finding.confidence) >= 3);
  return findings
    .filter((finding) => {
      if (!finding.supersededWithin) return true;
      const { startLine, endLine } = finding.supersededWithin;
      return !specific.some((other) =>
        other.file === finding.file && other.line >= startLine && other.line <= endLine);
    })
    .map(({ supersededWithin, ...finding }) => finding);
}

function firstLine(text) {
  const line = String(text || "").split("\n")[0].trim();
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

/** Deterministic ordering: severity, then confidence, then location. */
export function sortFindings(findings) {
  return [...findings].sort((a, b) =>
    severityWeight(b.severity) - severityWeight(a.severity)
    || confidenceWeight(b.confidence) - confidenceWeight(a.confidence)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.id.localeCompare(b.id)
  );
}

/**
 * Two analyzers can legitimately observe the same defect (an unbounded Prisma
 * read is both a database and a performance risk). Reporting it twice at the
 * same location is noise, so the higher-severity finding wins.
 */
export function dedupeFindings(findings) {
  const byKey = new Map();
  for (const finding of suppressSupersededFindings(findings)) {
    const key = `${finding.file}:${finding.line}:${finding.id}`;
    const existing = byKey.get(key);
    if (!existing || severityWeight(finding.severity) > severityWeight(existing.severity)) {
      byKey.set(key, finding);
    }
  }
  return sortFindings([...byKey.values()]);
}
