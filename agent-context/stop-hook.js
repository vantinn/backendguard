import fs from "node:fs";

import { appendJsonLine, readJsonFile, writeJsonFile } from "../runtime/fs-utils.js";
import { readGitSnapshot, checkCompliance } from "../compliance/rule-compliance.js";
import { structuralComplianceForChangedFiles } from "../analysis/index.js";
import { buildReport } from "../compliance/compliance-reporter.js";
import { loadRuntimeEvidence } from "../runtime/telemetry.js";
import { filterActionableRules } from "../rules/rule-engine.js";
import { resolveHookCwd } from "./hook-io.js";

export function handleStopPayload(payload, { contextPath, reportPath, historyPath, telemetryPath } = {}) {
  const cwd = resolveHookCwd(payload);
  const promptContext = contextPath && fs.existsSync(contextPath) ? readJsonFile(contextPath) : null;
  const rawScheduledRules = [
    ...(promptContext?.scheduled?.highRules || []),
    ...(promptContext?.scheduled?.midRules || [])
  ];
  const scheduledRules = filterActionableRules(rawScheduledRules);
  const scheduled = promptContext?.scheduled
    ? {
      ...promptContext.scheduled,
      highRules: filterActionableRules(promptContext.scheduled.highRules || []),
      midRules: filterActionableRules(promptContext.scheduled.midRules || []),
      droppedRules: [
        ...(promptContext.scheduled.droppedRules || []),
        ...rawScheduledRules.filter((rule) => !scheduledRules.some((item) => item.content === rule.content && item.sourcePath === rule.sourcePath))
      ]
    }
    : null;
  const gitSnapshot = readGitSnapshot({ cwd });
  const runtimeEvidence = loadRuntimeEvidence({
    telemetryPath,
    since: promptContext?.at,
    cwd,
    payload
  });
  const compliance = [
    ...checkCompliance({
      rules: scheduledRules,
      addedLines: gitSnapshot.addedLines,
      runtimeEvidence
    }),
    ...structuralComplianceForChangedFiles({ cwd, changedFiles: gitSnapshot.changedFiles })
  ];
  const report = buildReport({
    cwd,
    prompt: promptContext?.prompt || "",
    relevantFiles: promptContext?.relevantFiles || [],
    suggestedSkills: promptContext?.suggestedSkills || [],
    suggestedWorkflows: promptContext?.suggestedWorkflows || [],
    scheduled,
    gitSnapshot,
    compliance,
    runtimeEvidence
  });

  if (reportPath) writeJsonFile(reportPath, report);
  if (historyPath) appendJsonLine(historyPath, report);

  return {
    continue: true
  };
}
