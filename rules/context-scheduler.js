import path from "node:path";

import { loadOutputConfig } from "../agent-context/output-config.js";

const MAX_CONTEXT_CHARS = 4000;

export function scheduleContext({
  rules = [],
  relevantFiles = [],
  suggestedSkills = [],
  suggestedWorkflows = [],
  prompt = "",
  maxChars = MAX_CONTEXT_CHARS,
  outputConfig = loadOutputConfig()
} = {}) {
  const orderedRules = [...rules].sort(compareRulesForContext);
  const high = orderedRules.filter((rule) => rule.score >= 0.5);
  const mid = orderedRules.filter((rule) => rule.score >= 0.1 && rule.score < 0.5);
  const dropped = orderedRules.filter((rule) => rule.score < 0.1);
  const fileSelection = selectFilesForContext(relevantFiles, { prompt, limit: outputConfig.limits?.files });
  const skillSelection = selectScoredItemsForContext(suggestedSkills, { limit: outputConfig.limits?.skills, min: 1, max: 8, gap: 0.18, floor: 0.55, label: "confidence elbow" });
  const workflowSelection = selectScoredItemsForContext(suggestedWorkflows, { limit: outputConfig.limits?.workflows, min: 1, max: 3, gap: 0.25, floor: 0.30, label: "workflow confidence" });

  const sections = [];
  if (outputConfig.sections.rules && high.length) {
    sections.push(section("Critical BackendGuard rules", high.slice(0, 5).map(formatRule)));
  }
  if (outputConfig.sections.files && fileSelection.items.length) {
    sections.push(commaSection(withReason("Suggested files to check", fileSelection), formatFiles(fileSelection.items)));
  }
  if (outputConfig.sections.skills && skillSelection.items.length) {
    sections.push(inlineSection(withReason("Suggested skills for this task", skillSelection), skillSelection.items.map(formatSkill)));
  }
  if (outputConfig.sections.workflows && workflowSelection.items.length) {
    sections.push(section(withReason("Suggested workflow for this task", workflowSelection), workflowSelection.items.map(formatWorkflow)));
  }
  if (outputConfig.sections.rules && mid.length) {
    sections.push(section("Additional relevant rules", mid.slice(0, 5).map(formatRule)));
  }

  const additionalContext = trimToLimit(sections.filter(Boolean).join("\n\n"), maxChars);
  return {
    highRules: high,
    midRules: mid,
    droppedRules: dropped,
    relevantFiles: fileSelection.items,
    suggestedSkills: skillSelection.items,
    suggestedWorkflows: workflowSelection.items,
    selection: {
      files: fileSelection,
      skills: skillSelection,
      workflows: workflowSelection
    },
    additionalContext
  };
}

function withReason(title, selection) {
  return selection.auto && selection.reason ? `${title} (${selection.items.length} auto: ${selection.reason})` : title;
}

function compareRulesForContext(a, b) {
  return rulePriority(b) - rulePriority(a)
    || Number(b.score || 0) - Number(a.score || 0)
    || Number(a.originalOrder || 0) - Number(b.originalOrder || 0);
}

function rulePriority(rule) {
  const content = String(rule.content || "").toLowerCase();
  let priority = 0;
  if (/\b(important|always|must|required|mandatory|strictly|never)\b/.test(content)) priority += 10;
  if (/\b(code-review-graph|query_graph|get_minimal_context|detect_changes|semantic_search_nodes)\b/.test(content)) priority += 4;
  return priority;
}

function section(title, lines) {
  const uniqueLines = [...new Set(lines)];
  if (!uniqueLines.length) return "";
  return `## ${title}\n${uniqueLines.join("\n")}`;
}

function inlineSection(title, values) {
  const uniqueValues = [...new Set(values)];
  if (!uniqueValues.length) return "";
  return `## ${title}: ${uniqueValues.join(", ")}`;
}

function commaSection(title, values) {
  const uniqueValues = [...new Set(values)];
  if (!uniqueValues.length) return "";
  return `## ${title}, ${uniqueValues.join(", ")}`;
}

function formatRule(rule) {
  return `- ${rule.content}`;
}

function formatFiles(files) {
  const counts = new Map();
  for (const file of files) {
    const name = path.basename(file.path);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return files.map((file) => formatFile(file, counts));
}

function formatFile(file, basenameCounts) {
  const name = path.basename(file.path);
  return basenameCounts.get(name) > 1 ? file.path : name;
}

function formatSkill(skill) {
  const name = String(skill.name || "").trim();
  if (!name) return "";
  if (name.startsWith("$")) return name;
  return skill.explicit ? `$${name}` : name;
}

function selectFilesForContext(files = [], { prompt = "", limit } = {}) {
  const manual = manualLimit(limit);
  if (manual !== null) {
    return { items: files.slice(0, manual), auto: false, reason: "manual" };
  }
  const complexity = classifyTaskComplexity(prompt);
  const baseMax = fileLimitForComplexity(complexity, files.length);
  const max = Math.min(15, baseMax, files.length);
  const scored = files
    .filter((file) => !hasScore(file) || normalizedScore(file) >= 0.20 || Number(file.score || 0) > 0)
    .sort((a, b) => normalizedScore(b) - normalizedScore(a) || String(a.path || "").localeCompare(String(b.path || "")));
  const items = diversifyFiles(scored, max);
  const buckets = new Set(items.map((file) => fileBucket(file.path)));
  const bucketLabel = `${buckets.size} ${buckets.size === 1 ? "bucket" : "buckets"}`;
  return {
    items,
    auto: true,
    reason: `${complexity.replace("_", " ")} task, ${bucketLabel}`
  };
}

function selectScoredItemsForContext(items = [], { limit, min, max, gap, floor, label } = {}) {
  const manual = manualLimit(limit);
  if (manual !== null) return { items: items.slice(0, manual), auto: false, reason: "manual" };
  const sorted = items
    .filter((item) => normalizedScore(item) >= floor)
    .sort((a, b) => normalizedScore(b) - normalizedScore(a) || String(a.name || a.title || "").localeCompare(String(b.name || b.title || "")));
  let cut = Math.min(sorted.length, max);
  for (let index = min; index < Math.min(sorted.length, max); index += 1) {
    const delta = normalizedScore(sorted[index - 1]) - normalizedScore(sorted[index]);
    if (delta >= gap) {
      cut = index;
      break;
    }
  }
  return {
    items: sorted.slice(0, cut),
    auto: true,
    reason: label
  };
}

function manualLimit(limit) {
  if (String(limit || "").toLowerCase() === "auto") return null;
  const number = Number(limit);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.trunc(number));
}

function normalizedScore(item = {}) {
  if (!hasScore(item)) return 0.75;
  const raw = Number(item.confidence ?? item.rankScore ?? item.embeddingScore ?? item.score ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return raw > 1 ? Math.min(1, raw / 10) : Math.max(0, Math.min(1, raw));
}

function hasScore(item = {}) {
  return ["confidence", "rankScore", "embeddingScore", "score"].some((key) => item[key] !== undefined && item[key] !== null);
}

function classifyTaskComplexity(prompt = "") {
  const text = String(prompt || "").toLowerCase();
  const actionCount = (text.match(/\b(add|build|create|implement|wire|integrate|design|refactor|migrate|rename|notify|checkout|purchase|page|flow|dashboard|service|api|tests?)\b/g) || []).length;
  if (/\b(refactor|migration|migrate|rename across|repo-wide|monorepo|all usages)\b/.test(text)) return "refactor";
  if (actionCount >= 5 || /\b(flow|page|dashboard|end-to-end|e2e|multiple|resources|collections|chat|forum|checkout|notifications?)\b/.test(text)) return "large_feature";
  if (/\b(add|build|create|implement|feature|page|api|endpoint|component)\b/.test(text)) return "feature";
  if (/\b(fix|bug|error|test|lint|type|small|minor)\b/.test(text)) return "small_fix";
  return "feature";
}

function fileLimitForComplexity(complexity, candidateCount) {
  if (complexity === "small_fix") return 3;
  if (complexity === "feature") return Math.min(8, candidateCount);
  if (complexity === "large_feature") return 12;
  if (complexity === "refactor") return 15;
  return Math.min(8, candidateCount);
}

function diversifyFiles(files, max) {
  const buckets = new Map();
  for (const file of files) {
    const bucket = fileBucket(file.path);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(file);
  }
  const result = [];
  while (result.length < max) {
    let added = false;
    for (const bucketFiles of buckets.values()) {
      const next = bucketFiles.shift();
      if (!next) continue;
      result.push(next);
      added = true;
      if (result.length >= max) break;
    }
    if (!added) break;
  }
  return result;
}

function fileBucket(filePath = "") {
  const value = String(filePath || "").toLowerCase();
  if (/(^|\/)(app|pages|routes)(\/|$)|page\.(tsx?|jsx?)$|route\.(tsx?|jsx?)$/.test(value)) return "routes/pages";
  if (/(^|\/)(components|molecules|atoms|organisms)(\/|$)/.test(value)) return "components";
  if (/(^|\/)(features|modules)(\/|$)/.test(value)) return "features";
  if (/(^|\/)(services|api|server|controllers)(\/|$)|service\./.test(value)) return "services";
  if (/(\.test\.|\.spec\.|__tests__|\/tests?\/)/.test(value)) return "tests";
  if (/(package\.json|\.config\.|config\/|\.github\/|dockerfile|compose|\.env)/.test(value)) return "config";
  return "other";
}

function formatWorkflow(workflow) {
  const name = workflow.title || workflow.name;
  const chain = workflow.chain?.length ? `\n  chain: ${workflow.chain.join(" -> ")}` : "";
  return `- ${name}${chain}`;
}

function trimToLimit(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[BackendGuard truncated context to ${maxChars} chars]`;
}
