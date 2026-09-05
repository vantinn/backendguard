#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkWorkspace, formatBenchmark } from "../../runtime/benchmark.js";
import { formatBackendGuardReady, inspectBackendGuardReady } from "../../compliance/readiness-scorer.js";
import { formatHallucinationLeaderboard, runHallucinationLeaderboard } from "../../evaluation/hallucination/run-leaderboard.js";
import { runSkillRoutingEval } from "../../evaluation/skill-routing/run-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const render = path.join(__dirname, "render-terminal-gif.mjs");
const leaderboard = await runHallucinationLeaderboard({ rootDir: repoRoot });
const skillEval = await runSkillRoutingEval({ rootDir: repoRoot });

const demos = [
  {
    log: "same-prompt-different-context.txt",
    gif: "same-prompt-different-context.gif",
    steps: [
      ["backendguard leaderboard --hallucination", formatHallucinationLeaderboard(leaderboard)],
      ["backendguard skills doctor -- \"fix deployed\"  # Expo fixture", routeSummary("expo-eas", "fix deployed")],
      ["backendguard skills doctor -- \"fix deployed\"  # Next/Vercel fixture", routeSummary("next-vercel", "fix deployed")]
    ]
  },
  {
    log: "agents-lost-middle.txt",
    gif: "agents-lost-middle.gif",
    steps: [
      ["backendguard benchmark -- \"fix failing test\"", formatBenchmark(benchmarkWorkspace({ cwd: repoRoot, task: "fix failing test" }))]
    ]
  },
  {
    log: "backendguard-ready.txt",
    gif: "backendguard-ready.gif",
    steps: [
      ["backendguard doctor", formatBackendGuardReady(inspectBackendGuardReady({ cwd: repoRoot }))]
    ]
  }
];

for (const demo of demos) {
  const logPath = path.join(__dirname, demo.log);
  const gifPath = path.join(__dirname, demo.gif);
  const chunks = [];
  for (const [label, output] of demo.steps) {
    chunks.push(`$ ${label}`);
    chunks.push(cleanOutput(output));
    chunks.push("");
  }
  fs.writeFileSync(logPath, chunks.join("\n").trimEnd() + "\n", "utf8");
  execFileSync(process.execPath, [render, logPath, gifPath], { cwd: repoRoot, stdio: "inherit" });
}

function cleanOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function routeSummary(fixture, prompt) {
  const row = skillEval.rows.find((item) => item.fixture === fixture && item.prompt === prompt);
  if (!row) return "No route found.";
  return [
    "BackendGuard skill doctor",
    `fixture: ${fixture}`,
    `prompt: ${prompt}`,
    `selected: ${row.selectedIds.join(", ") || "(none)"}`,
    `expected: ${row.expected.join(", ") || "(none)"}`,
    `rejected: ${row.forbidden.join(", ") || "(none)"}`
  ].join("\n");
}
