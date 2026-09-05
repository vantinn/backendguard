import { isSystemUserRule } from "../rules/rule-engine.js";

// Lightweight keyword heuristics that map a rule's content to a backend
// engineering category + baseline severity. Order matters: first match wins,
// so security/database/performance/testing are checked before the
// architecture catch-all.
const SEVERITY_RULES = [
  { category: "Security", severity: "HIGH", pattern: /password|secret|token|jwt|auth|credential|encrypt|hash|rbac|role|permission|inject|sanitiz|cors|rate.?limit|csrf|xss/i },
  { category: "Database", severity: "MEDIUM", pattern: /\bindex(es|ing)?\b|migration|transaction|\bquery\b|n\+1|constraint|foreign key|\bschema\b|\borm\b|prisma|typeorm|postgres|sql/i },
  { category: "Performance", severity: "MEDIUM", pattern: /\bcache\b|redis|scal(e|ing|ability)|concurren|connection pool|throughput|latency|\bqueue\b|pagination|n\+1/i },
  { category: "Testing", severity: "LOW", pattern: /\btest(s|ing)?\b|coverage|\bassert|\bmock\b|e2e|integration test/i }
];

function classifyRule(content) {
  const text = String(content || "");
  for (const { category, severity, pattern } of SEVERITY_RULES) {
    if (pattern.test(text)) return { category, severity };
  }
  return { category: "Architecture", severity: "INFO" };
}

// Structural (AST-based) findings from ast-security-analyzer.js already carry an
// exact category/severity/confidence from the check that produced them — they
// don't need (and shouldn't get) keyword-guessed classification.
function classifyItem(rule) {
  if (rule?.structural) return { category: rule.category, severity: rule.severity, confidence: rule.confidence || "structural" };
  return { ...classifyRule(rule?.content), confidence: "heuristic" };
}

const REPORT_CATEGORIES = ["Security", "Architecture", "Database", "Performance", "Testing"];

// Builds a category-scoped PASS/WARNING/FAIL summary plus a flat, severity-ranked
// issue list from a compliance report's already-sanitized rule buckets. Only
// categories with at least one measured or observed rule are reported — an
// empty category is reported as "not evaluated" rather than a false PASS.
export function buildComplianceSummary(report) {
  report = sanitizeReport(report);
  const buckets = { Security: [], Architecture: [], Database: [], Performance: [], Testing: [] };
  const classify = (item, status) => {
    const { category, severity, confidence } = classifyItem(item.rule);
    buckets[category].push({ ...item, status, severity, confidence });
  };
  for (const item of report.ignored || []) classify(item, "ignored");
  for (const item of report.unknown || []) classify(item, "unknown");
  for (const item of report.followed || []) classify(item, "followed");

  const categories = REPORT_CATEGORIES.map((name) => {
    const items = buckets[name];
    if (!items.length) return { name, status: "NOT_EVALUATED" };
    const hasHighIgnored = items.some((item) => item.status === "ignored" && (item.severity === "HIGH" || item.severity === "CRITICAL"));
    const hasIgnored = items.some((item) => item.status === "ignored");
    const hasUnknown = items.some((item) => item.status === "unknown");
    const status = hasHighIgnored ? "FAIL" : (hasIgnored || hasUnknown) ? "WARNING" : "PASS";
    return { name, status };
  });

  const issues = Object.values(buckets)
    .flat()
    .filter((item) => item.status === "ignored" || item.status === "unknown")
    .map((item) => ({
      severity: item.status === "ignored" ? item.severity : (item.severity === "HIGH" ? "MEDIUM" : item.severity),
      category: classifyItem(item.rule).category,
      confidence: item.confidence || classifyItem(item.rule).confidence,
      ruleId: item.rule?.structural ? item.rule.id : undefined,
      remediation: item.rule?.structural ? item.rule.remediation : undefined,
      summary: truncate(item.rule?.content || "", 140),
      evidence: truncate(item.evidence || "", 140)
    }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  return { categories, issues };
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/**
 * Deterministic, explainable category scoring.
 *
 * Every category starts at 100 and loses points per finding. The deduction is
 * `severity points x confidence factor`, both fixed tables — so the same report
 * always produces the same score, and every point lost can be traced to a
 * specific finding. There is no hidden weighting, no normalisation against
 * other repositories, and no rounding that hides a finding.
 *
 * A category with nothing to measure scores `null`, not 100: "we found no
 * problems" and "we did not look" are different answers and are reported
 * differently.
 */
export const SEVERITY_POINTS = { CRITICAL: 40, HIGH: 25, MEDIUM: 10, LOW: 4, INFO: 1 };
export const CONFIDENCE_FACTOR = { certain: 1, high: 0.9, medium: 0.6, low: 0.3, structural: 0.9, heuristic: 0.4 };

export function scoreDeduction({ severity, confidence }) {
  const points = SEVERITY_POINTS[severity] ?? SEVERITY_POINTS.INFO;
  const factor = CONFIDENCE_FACTOR[confidence] ?? CONFIDENCE_FACTOR.heuristic;
  return Math.round(points * factor);
}

export function buildComplianceScorecard(report) {
  const { categories, issues } = buildComplianceSummary(report);
  const scored = categories.map((category) => {
    if (category.status === "NOT_EVALUATED") {
      return { ...category, score: null, deductions: [], reason: "no rule or finding in this category was evaluated" };
    }
    const deductions = issues
      .filter((issue) => issue.category === category.name)
      .map((issue) => ({
        id: issue.ruleId || null,
        severity: issue.severity,
        confidence: issue.confidence,
        points: scoreDeduction(issue),
        summary: issue.summary
      }));
    const total = deductions.reduce((sum, deduction) => sum + deduction.points, 0);
    return { ...category, score: Math.max(0, 100 - total), deductions };
  });

  const evaluated = scored.filter((category) => category.score !== null);
  const overall = evaluated.length
    ? Math.round(evaluated.reduce((sum, category) => sum + category.score, 0) / evaluated.length)
    : null;

  return {
    categories: scored,
    overall,
    evaluatedCategories: evaluated.map((category) => category.name),
    formula: "score = 100 - sum(severity points x confidence factor); severity CRITICAL 40 / HIGH 25 / MEDIUM 10 / LOW 4 / INFO 1; confidence certain 1.0 / high 0.9 / medium 0.6 / low 0.3 / heuristic 0.4"
  };
}

export function formatComplianceScorecard(report) {
  const scorecard = buildComplianceScorecard(report);
  if (!scorecard.evaluatedCategories.length) return "";
  const lines = ["## Category Scores", ""];
  const width = Math.max(...scorecard.categories.map((category) => category.name.length)) + 2;
  for (const category of scorecard.categories) {
    const value = category.score === null ? "not evaluated" : `${category.score}/100 (${category.status})`;
    lines.push(`- ${category.name.padEnd(width)} ${value}`);
    for (const deduction of category.deductions) {
      lines.push(`    -${deduction.points}  ${deduction.id ? `${deduction.id} ` : ""}${deduction.severity}/${deduction.confidence} — ${deduction.summary}`);
    }
  }
  lines.push("");
  lines.push(`Overall: ${scorecard.overall === null ? "not evaluated" : `${scorecard.overall}/100`} (mean of evaluated categories)`);
  lines.push(`Formula: ${scorecard.formula}`);
  return lines.join("\n");
}

export function formatComplianceSummary(report) {
  const { categories, issues } = buildComplianceSummary(report);
  if (categories.every((category) => category.status === "NOT_EVALUATED")) return "";

  const lines = ["## Backend Engineering Compliance", ""];
  for (const category of categories) {
    const label = category.status === "NOT_EVALUATED" ? "not evaluated" : category.status;
    lines.push(`- **${category.name}:** ${label}`);
  }
  lines.push("");

  if (issues.length) {
    lines.push("### Issues", "");
    for (const issue of issues) {
      const idLabel = issue.ruleId ? ` ${issue.ruleId}` : "";
      lines.push(`**[${issue.severity}]**${idLabel} ${issue.summary}`);
      lines.push(`- Category: ${issue.category}`);
      if (issue.confidence) lines.push(`- Confidence: ${issue.confidence}`);
      lines.push(`- Evidence: ${issue.evidence}`);
      if (issue.remediation) lines.push(`- Recommendation: ${issue.remediation}`);
      lines.push("");
    }
  } else {
    lines.push("No issues found in evaluated categories.", "");
  }

  const scorecard = formatComplianceScorecard(report);
  if (scorecard) lines.push(scorecard, "");

  return lines.join("\n");
}

export function buildReport({ cwd, prompt, relevantFiles, suggestedSkills, suggestedWorkflows, scheduled, gitSnapshot, compliance, runtimeEvidence }) {
  const actionableCompliance = compliance.filter((item) => !isSystemUserRule(item.rule));
  const followed = actionableCompliance.filter((item) => item.status === "followed");
  const ignored = actionableCompliance.filter((item) => item.status === "ignored");
  const unknown = actionableCompliance.filter((item) => item.status === "unknown");
  const unmeasurable = actionableCompliance.filter((item) => item.status === "unmeasurable");
  const measured = followed.length + ignored.length;
  const efficiencyScore = measured ? Math.round((followed.length / measured) * 100) : null;

  return {
    at: new Date().toISOString(),
    cwd,
    prompt,
    injectedRuleCount: (scheduled?.highRules?.length || 0) + (scheduled?.midRules?.length || 0),
    relevantFiles,
    suggestedSkills: suggestedSkills || [],
    suggestedWorkflows: suggestedWorkflows || [],
    changedFiles: gitSnapshot.changedFiles,
    warnings: gitSnapshot.warnings || [],
    runtimeEvidence: summarizeRuntimeEvidence(runtimeEvidence),
    followed,
    ignored,
    unknown,
    unmeasurable,
    measuredRuleCount: measured,
    unknownRuleCount: unknown.length,
    unmeasurableRuleCount: unmeasurable.length,
    efficiencyScore
  };
}

export function formatReport(report) {
  report = sanitizeReport(report);
  const lines = [];
  lines.push("# BackendGuard Report\n");

  // Summary
  lines.push("## Summary");
  lines.push(`- **Efficiency:** ${report.efficiencyScore == null ? "unknown" : `${report.efficiencyScore}%`}`);
  lines.push(`- **Injected rules:** ${report.injectedRuleCount || 0}`);
  lines.push(`- **Measured rules:** ${report.measuredRuleCount ?? ((report.followed?.length || 0) + (report.ignored?.length || 0))}`);
  lines.push(`- **Changed files:** ${report.changedFiles?.length ? report.changedFiles.length : "none detected"}`);
  lines.push("");

  // Rule Outcomes
  lines.push("## Rule Outcomes");
  lines.push(`- Followed: ${report.followed?.length || 0}`);
  lines.push(`- Ignored: ${report.ignored?.length || 0}`);
  lines.push(`- Unknown: ${report.unknown?.length || 0}`);
  lines.push(`- Unmeasurable: ${report.unmeasurable?.length || 0}`);
  lines.push("");

  // Backend Engineering Compliance (severity-ranked, category-scoped)
  const complianceSummary = formatComplianceSummary(report);
  if (complianceSummary) {
    lines.push(complianceSummary);
    lines.push("");
  }

  // Suggested Files
  if (report.relevantFiles?.length) {
    lines.push("## Suggested Files");
    for (const [index, file] of report.relevantFiles.entries()) {
      const score = typeof file.score === "number" ? ` (${file.score.toFixed(2)})` : "";
      lines.push(`${index + 1}. ${file.path}${score}`);
    }
    lines.push("");
  }

  // Suggested Skills
  if (report.suggestedSkills?.length) {
    lines.push("## Suggested Skills");
    for (const skill of report.suggestedSkills) {
      const desc = skill.description ? `: ${truncate(skill.description, 80)}` : "";
      lines.push(`- **${skill.name}**${desc}`);
    }
    lines.push("");
  }

  // Suggested Workflows
  if (report.suggestedWorkflows?.length) {
    lines.push("## Suggested Workflows");
    for (const workflow of report.suggestedWorkflows) {
      const name = workflow.title || workflow.name;
      const chain = workflow.chain?.length ? ` → ${workflow.chain.join(" → ")}` : "";
      lines.push(`- **${name}**${chain}`);
    }
    lines.push("");
  }

  // Runtime Telemetry
  if (report.runtimeEvidence?.signals?.length) {
    lines.push("## Runtime Telemetry");
    for (const signal of report.runtimeEvidence.signals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
  }

  // Warnings
  for (const warning of report.warnings || []) lines.push(`> ${warning}\n`);

  // Rule details
  appendBucket(lines, "Followed", report.followed);
  appendBucket(lines, "Ignored", report.ignored);
  appendBucket(lines, "Unknown", report.unknown);
  appendBucket(lines, "Unmeasurable", report.unmeasurable);

  if (report.ignored?.length) {
    lines.push(`> **Suggestion:** Fix ignored rule evidence first: ${truncate(report.ignored[0].rule?.content || "", 70)}`);
  } else if (report.unknown?.length && !(report.followed?.length || report.ignored?.length)) {
    lines.push("> **Suggestion:** These rules need runtime evidence or more concrete keywords before BackendGuard can score them from git diff.");
  }

  return lines.join("\n");
}

export function formatEvidence(report) {
  report = sanitizeReport(report);
  const lines = [];
  lines.push("# BackendGuard Evidence\n");

  lines.push("## Summary");
  lines.push(`- **Prompt:** ${truncate(report.prompt || "(empty)", 100)}`);
  lines.push(`- **Efficiency:** ${report.efficiencyScore == null ? "unknown" : `${report.efficiencyScore}%`}`);
  lines.push(`- **Changed files:** ${report.changedFiles?.length ? report.changedFiles.join(", ") : "none detected"}`);
  lines.push("");

  for (const warning of report.warnings || []) lines.push(`> ${warning}\n`);

  const items = [
    ...(report.followed || []).map((item) => ({ ...item, status: "followed" })),
    ...(report.ignored || []).map((item) => ({ ...item, status: "ignored" })),
    ...(report.unknown || []).map((item) => ({ ...item, status: "unknown" })),
    ...(report.unmeasurable || []).map((item) => ({ ...item, status: "unmeasurable" }))
  ];

  if (!items.length) {
    lines.push("No rule evidence captured for the last report.");
    lines.push("Run a task that schedules at least one relevant rule, then let the Stop hook finish.");
    return lines.join("\n");
  }

  lines.push("## Evidence Details\n");
  for (const [index, item] of items.entries()) {
    lines.push(`### ${index + 1}. ${item.status.toUpperCase()}`);
    lines.push(`- **Rule:** ${truncate(item.rule?.content || "(missing rule)", 120)}`);
    if (item.rule?.sourcePath) lines.push(`- **Source:** ${item.rule.sourcePath}`);
    if (typeof item.rule?.score === "number") lines.push(`- **Score:** ${item.rule.score.toFixed(2)}`);
    if (item.kind) lines.push(`- **Kind:** ${item.kind}`);
    lines.push(`- **Evidence:** ${truncate(item.evidence || "(none)", 120)}`);
    for (const line of item.matchedLines || []) {
      const where = line.file ? `${line.file}${typeof line.line === "number" ? `:${line.line}` : ""}` : "diff";
      lines.push(`  - Match: \`${where}\` ${truncate(line.content || "", 100)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function appendBucket(lines, label, items = []) {
  if (!items.length) return;
  lines.push(`### ${label}`);
  for (const item of items) {
    lines.push(`- **Rule:** ${truncate(item.rule.content, 100)}`);
    lines.push(`  - Evidence: ${truncate(item.evidence, 100)}`);
  }
  lines.push("");
}

function truncate(value, max) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function summarizeRuntimeEvidence(runtimeEvidence = {}) {
  const signals = [
    ...(runtimeEvidence.toolSignals || []),
    ...(runtimeEvidence.commandSignals || []),
    ...(runtimeEvidence.signals || [])
  ];
  return {
    signals: [...new Set(signals)].slice(0, 20),
    sources: (runtimeEvidence.sources || []).slice(0, 10)
  };
}

function sanitizeReport(report = {}) {
  const followed = (report.followed || []).filter((item) => !isSystemUserRule(item.rule));
  const ignored = (report.ignored || []).filter((item) => !isSystemUserRule(item.rule));
  const unknown = (report.unknown || []).filter((item) => !isSystemUserRule(item.rule));
  const unmeasurable = (report.unmeasurable || []).filter((item) => !isSystemUserRule(item.rule));
  const measured = followed.length + ignored.length;
  return {
    ...report,
    injectedRuleCount: followed.length + ignored.length + unknown.length + unmeasurable.length,
    followed,
    ignored,
    unknown,
    unmeasurable,
    measuredRuleCount: measured,
    unknownRuleCount: unknown.length,
    unmeasurableRuleCount: unmeasurable.length,
    efficiencyScore: measured ? Math.round((followed.length / measured) * 100) : null
  };
}
