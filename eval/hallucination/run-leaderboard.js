#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvalYaml, runSkillRoutingEval } from "../skill-routing/run-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(__dirname, "..", "skill-routing");
const DEFAULT_CASE_LIMIT = 20;

export async function runHallucinationLeaderboard({
  rootDir = path.resolve(__dirname, "..", ".."),
  casesPath = path.join(evalRoot, "cases.yaml"),
  caseLimit = DEFAULT_CASE_LIMIT
} = {}) {
  const config = parseEvalYaml(fs.readFileSync(casesPath, "utf8"));
  const selectedCases = selectLeaderboardCases(config.cases, caseLimit);
  const wanted = new Set(selectedCases.map(caseId));
  const backendguard = await runSkillRoutingEval({ rootDir, casesPath, topK: 3, threshold: 0.5 });
  const contextRows = backendguard.rows
    .filter((row) => wanted.has(caseId(row)))
    .map((row) => evaluateRow({
      prompt: row.prompt,
      fixture: row.fixture,
      expected: row.expected,
      allowed: row.allowed,
      forbidden: row.forbidden,
      selectedIds: row.selectedIds
    }));
  const rawRows = selectedCases.map((testCase) => evaluateRow({
    prompt: testCase.prompt,
    fixture: testCase.fixture,
    expected: testCase.expected || [],
    allowed: testCase.allowed || [],
    forbidden: testCase.forbidden || [],
    selectedIds: rawAgentSkills({ prompt: testCase.prompt, skills: config.skills, topK: 3 })
  }));

  return {
    caseCount: selectedCases.length,
    repoCount: new Set(selectedCases.map((row) => row.fixture)).size,
    systems: [
      summarizeSystem("Raw heuristic baseline", rawRows),
      summarizeSystem("BackendGuard evidence benchmark", contextRows)
    ],
    rows: selectedCases.map((testCase) => ({
      prompt: testCase.prompt,
      fixture: testCase.fixture,
      expected: testCase.expected || [],
      raw: rawRows.find((row) => row.prompt === testCase.prompt && row.fixture === testCase.fixture),
      backendguard: contextRows.find((row) => row.prompt === testCase.prompt && row.fixture === testCase.fixture)
    }))
  };
}

export function formatHallucinationLeaderboard(result) {
  const lines = [
    "Hallucination Leaderboard",
    `Repos: ${result.repoCount}`,
    `Tasks: ${result.caseCount}`,
    "",
    "System                        Correct Context",
    "----------------------------  ---------------"
  ];
  for (const system of result.systems) {
    lines.push(`${system.name.padEnd(28)}  ${percent(system.correctRate)}`);
  }
  lines.push("", "Sample failures:");
  const failures = result.rows
    .filter((row) => !row.raw.correct || !row.backendguard.correct)
    .slice(0, 6);
  if (!failures.length) {
    lines.push("- none");
  } else {
    for (const row of failures) {
      lines.push(`- ${row.fixture}: "${row.prompt}"`);
      lines.push(`  expected: ${row.expected.join(", ") || "(none)"}`);
      lines.push(`  raw (${row.raw.correct ? "correct" : "wrong"}): ${row.raw.selectedIds.join(", ") || "(none)"}`);
      lines.push(`  backendguard (${row.backendguard.correct ? "correct" : "wrong"}): ${row.backendguard.selectedIds.join(", ") || "(none)"}`);
    }
  }
  return lines.join("\n");
}

function selectLeaderboardCases(cases, limit) {
  const wantedFixtures = [
    "expo-eas",
    "next-vercel",
    "docker-node",
    "railway-render",
    "firebase-hosting",
    "nest-prisma",
    "express-mongo-jwt",
    "oauth-google",
    "redis-cache",
    "backendguard",
    "frontend-only-next",
    "static-docs"
  ];
  const selected = [];
  for (const fixture of wantedFixtures) {
    const match = cases.find((row) => row.fixture === fixture && !selected.some((item) => caseId(item) === caseId(row)));
    if (match) selected.push(match);
    if (selected.length >= limit) return selected;
  }
  for (const row of cases) {
    if (!selected.some((item) => caseId(item) === caseId(row))) selected.push(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

function rawAgentSkills({ prompt, skills, topK }) {
  return skills
    .map((skill) => ({ id: skill.id, score: rawPromptScore(prompt, skill) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK)
    .map((skill) => skill.id);
}

function rawPromptScore(prompt, skill) {
  const promptTokens = new Set(tokenize(prompt));
  const triggerTokens = tokenize([
    skill.id,
    skill.description,
    ...(skill.positive_triggers?.prompts || [])
  ].join(" "));
  let score = 0;
  for (const token of triggerTokens) {
    if (promptTokens.has(token)) score += token.length > 5 ? 2 : 1;
  }
  return score;
}

function evaluateRow({ prompt, fixture, expected, allowed, forbidden, selectedIds }) {
  const selected = new Set(selectedIds);
  const accepted = new Set([...expected, ...allowed]);
  const hasExpected = expected.length
    ? expected.every((skill) => selected.has(skill))
    : selectedIds.length === 0;
  const hasForbidden = forbidden.some((skill) => selected.has(skill));
  const hasUnexpected = selectedIds.some((skill) => !accepted.has(skill));
  return {
    prompt,
    fixture,
    expected,
    allowed,
    forbidden,
    selectedIds,
    correct: hasExpected && !hasForbidden && !hasUnexpected
  };
}

function summarizeSystem(name, rows) {
  const correct = rows.filter((row) => row.correct).length;
  return {
    name,
    correct,
    total: rows.length,
    correctRate: rows.length ? correct / rows.length : 0
  };
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9@.-]+/)
    .filter((token) => token.length > 2);
}

function caseId(row) {
  return `${row.fixture}\0${row.prompt}`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runHallucinationLeaderboard();
  console.log(formatHallucinationLeaderboard(result));
}
