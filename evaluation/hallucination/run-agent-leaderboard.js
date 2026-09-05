#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvalYaml } from "../skill-routing/run-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const skillEvalRoot = path.resolve(__dirname, "..", "skill-routing");
const DEFAULT_AGENTS = ["codex", "gemini"];
const DEFAULT_CASE_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 120000;

export function runAgentLeaderboard({
  agents = DEFAULT_AGENTS,
  casesPath = path.join(skillEvalRoot, "cases.yaml"),
  caseLimit = DEFAULT_CASE_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  rootDir = repoRoot
} = {}) {
  const config = parseEvalYaml(fs.readFileSync(casesPath, "utf8"));
  const cases = config.cases
    .filter((row) => row.expected?.length)
    .slice(0, caseLimit);
  const skillIds = config.skills.map((skill) => skill.id);
  const systems = [];

  for (const agent of agents) {
    const template = agentCommandTemplate(agent);
    const binary = template ? template.split(/\s+/).filter(Boolean)[0] : findBinary(agent);
    if (!binary) {
      systems.push({ name: agent, status: "skipped", reason: "binary not found", rows: [], correctRate: 0 });
      continue;
    }
    const rows = cases.map((testCase) => runAgentCase({
      agent,
      binary,
      testCase,
      skillIds,
      timeoutMs,
      rootDir
    }));
    const completed = rows.filter((row) => row.status === "ok");
    const correct = completed.filter((row) => row.correct).length;
    systems.push({
      name: agent,
      status: completed.length ? "ok" : "skipped",
      reason: completed.length ? "" : firstReason(rows),
      rows,
      correctRate: completed.length ? correct / completed.length : 0
    });
  }

  return {
    mode: "live-agent-cli",
    caseCount: cases.length,
    systems
  };
}

export function formatAgentLeaderboard(result) {
  const lines = [
    "Live Agent Leaderboard",
    `Mode: ${result.mode}`,
    `Tasks: ${result.caseCount}`,
    "",
    "System    Status    Correct Skill",
    "--------  --------  -------------"
  ];
  for (const system of result.systems) {
    const score = system.status === "ok" ? percent(system.correctRate) : system.reason;
    lines.push(`${system.name.padEnd(8)}  ${system.status.toUpperCase().padEnd(8)}  ${score}`);
  }
  lines.push("", "Cases:");
  for (const system of result.systems) {
    lines.push(`- ${system.name}`);
    for (const row of system.rows.slice(0, 5)) {
      lines.push(`  - ${row.fixture}: "${row.prompt}"`);
      lines.push(`    selected (${row.correct ? "correct" : "wrong"}): ${row.selectedIds.join(", ") || "(none)"}`);
      if (row.status !== "ok") lines.push(`    status: ${row.status}; ${row.reason}`);
    }
  }
  return lines.join("\n");
}

function runAgentCase({ agent, binary, testCase, skillIds, timeoutMs, rootDir }) {
  const cwd = testCase.fixture === "backendguard"
    ? rootDir
    : path.join(skillEvalRoot, "fixtures", testCase.fixture);
  const prompt = buildPrompt({ task: testCase.prompt, skillIds });
  const startedAt = Date.now();
  const result = spawnSync(binary, agentArgs({ agent, cwd, prompt }), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CI: process.env.CI || "1"
    }
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const selectedIds = parseSkillIds(output, skillIds).slice(0, 3);
  const correct = isCorrect({
    selectedIds,
    expected: testCase.expected || [],
    allowed: testCase.allowed || [],
    forbidden: testCase.forbidden || []
  });
  return {
    status: result.error ? "error" : result.status === 0 ? "ok" : "error",
    reason: result.error?.message || (result.status === 0 ? "" : `exit ${result.status}`),
    prompt: testCase.prompt,
    fixture: testCase.fixture,
    expected: testCase.expected || [],
    selectedIds,
    correct,
    durationMs: Date.now() - startedAt
  };
}

function agentArgs({ agent, cwd, prompt }) {
  const genericTemplate = agentCommandTemplate(agent);
  if (genericTemplate) return expandTemplate(genericTemplate, { cwd, prompt }).slice(1);
  if (agent === "codex") {
    return [
      "exec",
      "--cd", cwd,
      "--sandbox", "read-only",
      "--ask-for-approval", "never",
      prompt
    ];
  }
  if (agent === "gemini") {
    const template = process.env.BACKENDGUARD_GEMINI_CMD;
    if (template) return expandTemplate(template, { cwd, prompt });
    return ["-p", prompt];
  }
  return [prompt];
}

function agentCommandTemplate(agent) {
  const envKey = `BACKENDGUARD_${String(agent || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CMD`;
  return process.env[envKey] || "";
}

function buildPrompt({ task, skillIds }) {
  return [
    "You are evaluating a repository for a coding-agent skill router benchmark.",
    "Do not edit files. Do not run commands.",
    `Task: ${task}`,
    `Allowed skill IDs: ${skillIds.join(", ")}`,
    "Return only the top skill IDs as comma-separated text. No explanations."
  ].join("\n");
}

function parseSkillIds(output, skillIds) {
  const normalized = new Map(skillIds.map((id) => [normalize(id), id]));
  const found = [];
  for (const token of String(output || "").split(/[^A-Za-z0-9_.@-]+/)) {
    const id = normalized.get(normalize(token));
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

function isCorrect({ selectedIds, expected, allowed, forbidden }) {
  const selected = new Set(selectedIds);
  const accepted = new Set([...expected, ...allowed]);
  return expected.every((skill) => selected.has(skill))
    && forbidden.every((skill) => !selected.has(skill))
    && selectedIds.every((skill) => accepted.has(skill));
}

function findBinary(name) {
  const safeName = shellQuote(name);
  const candidates = [
    path.join(os.homedir(), ".local", "bin", safeName),
    path.join(os.homedir(), ".npm-global", "bin", safeName),
    path.join(os.homedir(), ".nvm", "current", "bin", safeName),
    ...windowsNpmCandidates(safeName)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, safeName);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const command of [
    `command -v ${safeName}`,
    `source ~/.profile >/dev/null 2>&1 || true; source ~/.bashrc >/dev/null 2>&1 || true; command -v ${safeName}`
  ]) {
    try {
      const found = execFileSync("bash", ["-lc", command], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // continue
    }
  }
  return "";
}

function firstReason(rows) {
  return rows.find((row) => row.reason)?.reason || "no completed cases";
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * npm's global bin on Windows, including the WSL view of it.
 *
 * These used to be hardcoded against one developer's Windows username, which
 * resolves for nobody else. Derive them from the environment instead.
 */
function windowsNpmCandidates(name) {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm"));
  const winUser = process.env.WSL_USER || process.env.USERNAME;
  if (winUser) roots.push(`/mnt/c/Users/${winUser}/AppData/Roaming/npm`);
  return roots.flatMap((root) => [path.join(root, name), path.join(root, `${name}.cmd`)]);
}

function shellQuote(value) {
  return String(value).replace(/[^A-Za-z0-9_./-]/g, "");
}

function expandTemplate(template, vars) {
  const file = path.join(os.tmpdir(), `backendguard-agent-prompt-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, vars.prompt, "utf8");
  return String(template)
    .replaceAll("{cwd}", vars.cwd)
    .replaceAll("{prompt_file}", file)
    .split(/\s+/)
    .filter(Boolean);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agentsArg = process.argv.find((arg) => arg.startsWith("--agents="));
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
  const result = runAgentLeaderboard({
    agents: agentsArg ? agentsArg.slice("--agents=".length).split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_AGENTS,
    caseLimit: limitArg ? Number(limitArg.slice("--limit=".length)) : DEFAULT_CASE_LIMIT,
    timeoutMs: timeoutArg ? Number(timeoutArg.slice("--timeout-ms=".length)) : DEFAULT_TIMEOUT_MS
  });
  console.log(formatAgentLeaderboard(result));
}
