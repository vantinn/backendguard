import { parseRules, filterActionableRules, scoreRules } from "../rules/rule-engine.js";
import { readAgentsChain } from "../rules/agents-file-reader.js";
import { scheduleContext } from "../rules/context-scheduler.js";
import { section, table, truncateCell } from "./terminal-ui.js";

export function benchmarkContext({ markdown, sources = [], task = "", openFiles = [], topK = 8 } = {}) {
  const parsedRules = parseRules(markdown);
  const actionableRules = filterActionableRules(parsedRules);
  const scoredRules = scoreRules(actionableRules, task, openFiles);
  const relevantRules = scoredRules.filter((rule) => Number(rule.score || 0) >= 0.1);
  const scheduled = scheduleContext({ rules: scoredRules, relevantFiles: [] });

  const originalPositions = new Map(actionableRules.map((rule, index) => [rule.content, index]));
  const middleStart = Math.floor(actionableRules.length * 0.25);
  const middleEnd = Math.ceil(actionableRules.length * 0.75);
  const lostMiddle = relevantRules.filter((rule) => {
    const index = originalPositions.get(rule.content);
    return typeof index === "number" && index >= middleStart && index <= middleEnd;
  });

  return {
    task,
    sources,
    rulesParsed: parsedRules.length,
    actionableRules: actionableRules.length,
    filteredRules: parsedRules.length - actionableRules.length,
    relevantRules: relevantRules.length,
    baseline: {
      relevantRulesInMiddle: lostMiddle.length,
      middleRiskPercent: relevantRules.length ? Math.round((lostMiddle.length / relevantRules.length) * 100) : 0
    },
    backendguard: {
      highRules: scheduled.highRules.length,
      midRules: scheduled.midRules.length,
      topRules: scoredRules.slice(0, topK).map((rule) => ({
        score: rule.score,
        content: rule.content,
        reasons: rule.reasons || []
      })),
      repeatsHighRulesAtEnd: scheduled.highRules.length > 0
    }
  };
}

export function benchmarkWorkspace({ cwd = process.cwd(), task = "", openFiles = [], topK = 8 } = {}) {
  const merged = readAgentsChain({ cwd });
  return benchmarkContext({
    markdown: merged.content,
    sources: merged.sources,
    task,
    openFiles,
    topK
  });
}

export function formatBenchmark(result) {
  const lines = [];
  lines.push("BackendGuard benchmark");
  lines.push(section("Summary"));
  lines.push(table(["Metric", "Value"], [
    ["Task", truncateCell(result.task || "(empty)", 100)],
    ["Rules parsed", result.rulesParsed],
    ["Actionable rules", result.actionableRules],
    ["Filtered rules", result.filteredRules],
    ["Relevant rules", result.relevantRules],
    ["Baseline middle-risk", `${result.baseline.relevantRulesInMiddle}/${result.relevantRules} relevant rules (${result.baseline.middleRiskPercent}%)`],
    ["BackendGuard scheduled", `${result.backendguard.highRules} high, ${result.backendguard.midRules} mid`],
    ["Recency reminder", result.backendguard.repeatsHighRulesAtEnd ? "enabled" : "not needed"]
  ]));
  if (result.backendguard.topRules.length) {
    lines.push(section("Top Rules"));
    lines.push(table(["Score", "Rule", "Reasons"], result.backendguard.topRules.map((rule) => [
      Number(rule.score || 0).toFixed(2),
      truncateCell(rule.content, 88),
      truncateCell(rule.reasons?.join(", ") || "", 40)
    ])));
  }
  return lines.join("\n");
}
