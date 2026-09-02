import fs from "node:fs";
import path from "node:path";

import { safeReadText } from "./fs-utils.js";
import { section, table, truncateCell } from "./terminal-ui.js";

function readJsonLines(filePath) {
  return safeReadText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function average(values) {
  const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

export function loadStats(dataDir) {
  const prompts = readJsonLines(path.join(dataDir, "prompt-history.jsonl"));
  const reportsFromHistory = readJsonLines(path.join(dataDir, "report-history.jsonl"));
  const lastPrompt = readJsonIfExists(path.join(dataDir, "last-prompt-context.json"));
  const lastReport = readJsonIfExists(path.join(dataDir, "last-report.json"));
  const events = readJsonLines(path.join(dataDir, "debug.log"));
  const reports = reportsFromHistory.length ? reportsFromHistory : [lastReport].filter(Boolean);

  const byEvent = new Map();
  for (const item of events) {
    byEvent.set(item.event, (byEvent.get(item.event) || 0) + 1);
  }

  const promptCount = prompts.length || (lastPrompt ? 1 : 0);
  const injectedCount = prompts.filter((item) => item.injected).length + (!prompts.length && lastPrompt?.injected ? 1 : 0);
  const analyzedPrompts = prompts.length ? prompts : [lastPrompt].filter(Boolean);
  const knownEfficiency = reports.map((report) => report.efficiencyScore).filter((score) => score != null);
  const followed = reports.reduce((sum, report) => sum + (report.followed?.length || 0), 0);
  const ignored = reports.reduce((sum, report) => sum + (report.ignored?.length || 0), 0);
  const unknown = reports.reduce((sum, report) => sum + (report.unknown?.length || 0), 0);
  const unmeasurable = reports.reduce((sum, report) => sum + (report.unmeasurable?.length || 0), 0);

  return {
    dataDir,
    events: Object.fromEntries([...byEvent.entries()].sort()),
    promptCount,
    reportCount: reports.length,
    injectedCount,
    quietCount: Math.max(0, promptCount - injectedCount),
    injectionRate: percent(injectedCount, promptCount),
    averagePromptMs: average(analyzedPrompts.map((item) => item.elapsedMs)),
    averageEfficiency: average(knownEfficiency),
    followed,
    ignored,
    unknown,
    unmeasurable,
    lastPrompt: analyzedPrompts.at(-1) || null,
    lastReport: reports.at(-1) || null
  };
}

export function formatStats(stats) {
  const lines = [];
  lines.push("BackendGuard stats");
  lines.push(section("Summary"));
  lines.push(table(["Metric", "Value"], [
    ["Data dir", stats.dataDir],
    ["Prompts analyzed", stats.promptCount],
    ["Reports generated", stats.reportCount],
    ["Prompt mode", `${stats.injectedCount} injected, ${stats.quietCount} quiet (${stats.injectionRate}% injected)`],
    ["Average prompt analysis", stats.averagePromptMs == null ? "unknown" : `${stats.averagePromptMs}ms`],
    ["Average efficiency", formatAverageEfficiency(stats)]
  ]));

  lines.push(section("Rule Outcomes"));
  lines.push(table(["Status", "Count"], [
    ["followed", stats.followed],
    ["ignored", stats.ignored],
    ["unknown", stats.unknown],
    ["unmeasurable", stats.unmeasurable || 0]
  ]));

  lines.push(section("Hook Events"));
  lines.push(Object.keys(stats.events).length
    ? table(["Event", "Count"], Object.entries(stats.events))
    : "none");

  if (stats.lastPrompt) {
    lines.push(section("Last Prompt"));
    lines.push(table(["Field", "Value"], [
      ["Prompt", truncateCell(stats.lastPrompt.prompt || "(empty)", 100)],
      ["Scheduled rules", scheduledRuleCount(stats.lastPrompt)],
      ["Suggested files", (stats.lastPrompt.relevantFiles || []).map((file) => file.path).join(", ") || "none"]
    ]));
  }

  if (stats.lastReport) {
    lines.push(section("Last Report"));
    lines.push(table(["Metric", "Value"], [
      ["Efficiency", stats.lastReport.efficiencyScore == null ? "unknown" : `${stats.lastReport.efficiencyScore}%`],
      ["Measured rules", stats.lastReport.measuredRuleCount ?? ((stats.lastReport.followed?.length || 0) + (stats.lastReport.ignored?.length || 0))],
      ["Unknown rules", stats.lastReport.unknownRuleCount ?? (stats.lastReport.unknown?.length || 0)],
      ["Unmeasurable rules", stats.lastReport.unmeasurableRuleCount ?? (stats.lastReport.unmeasurable?.length || 0)],
      ["Changed files", stats.lastReport.changedFiles?.join(", ") || "none"]
    ]));
  }

  return lines.join("\n");
}

function formatAverageEfficiency(stats) {
  if (stats.averageEfficiency != null) return `${stats.averageEfficiency}%`;
  if (!stats.reportCount) return "unknown (no Stop reports yet)";
  if (stats.followed + stats.ignored === 0) return "unknown (no measurable followed/ignored rule evidence yet)";
  return "unknown";
}

function scheduledRuleCount(prompt) {
  return (prompt.scheduled?.highRules?.length || 0) + (prompt.scheduled?.midRules?.length || 0);
}
