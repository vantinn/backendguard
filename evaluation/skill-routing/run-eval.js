#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { suggestSkills } from "../../agent-context/skill-discoverer.js";
import { EnvironmentError } from "../../runtime/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = __dirname;

export async function runSkillRoutingEval({
  rootDir = path.resolve(evalRoot, "..", ".."),
  casesPath = path.join(evalRoot, "cases.yaml"),
  topK = 3,
  threshold = 0.5
} = {}) {
  // Fixtures are development assets and are deliberately excluded from the
  // published package (see package.json#files). Fail with an explanation
  // instead of a confusing ENOENT when the benchmark is run from an install.
  if (!fs.existsSync(path.join(evalRoot, "fixtures"))) {
    throw new EnvironmentError("The routing benchmark needs its fixture repositories, which are not shipped in the npm package.", {
      hint: "Run it from a checkout of the BackendGuard repository: `git clone`, `npm install`, then `npm run benchmark:skills`."
    });
  }
  const config = parseEvalYaml(fs.readFileSync(casesPath, "utf8"));
  const skills = config.skills.map((skill) => ({
    name: skill.id,
    description: skill.description,
    path: path.join(evalRoot, "skills", skill.id, "SKILL.md"),
    metadata: skillToMetadata(skill)
  }));

  const rows = [];
  for (const testCase of config.cases) {
    const cwd = testCase.fixture === "backendguard"
      ? rootDir
      : path.join(evalRoot, "fixtures", testCase.fixture);
    const scores = semanticScores({ prompt: testCase.prompt, skills });
    const suggestions = await suggestSkills({
      cwd,
      prompt: testCase.prompt,
      skills,
      limit: Math.max(topK, 10),
      dataDir: path.join(evalRoot, ".tmp"),
      indexedSearcher: async () => ({
        status: "enabled",
        items: skills.map((skill) => ({
          id: normalizeSkillId(skill.name),
          text: skill.name,
          embeddingScore: scores.get(skill.name) || 0.45
        }))
      })
    });
    const selected = suggestions
      .filter((skill) => Number(skill.confidence || skill.score || 0) >= threshold)
      .slice(0, topK);
    rows.push({
      prompt: testCase.prompt,
      fixture: testCase.fixture,
      expected: testCase.expected,
      allowed: testCase.allowed || [],
      forbidden: testCase.forbidden,
      selected,
      selectedIds: selected.map((skill) => skill.name)
    });
  }

  return summarizeRows(rows, { topK });
}

export function formatSkillRoutingBenchmark(result) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const failures = result.rows.filter((row) => row.failed);
  const lines = [
    "Skill Routing Benchmark",
    `Cases: ${result.caseCount}`,
    `Top-1 Accuracy: ${percent(result.top1Accuracy)}`,
    `Top-3 Recall: ${percent(result.top3Recall)}`,
    `False Positive Rate: ${percent(result.falsePositiveRate)}`,
    `Confidence Calibration: ${percent(result.confidenceCalibration)}`,
    `Negative Gate Accuracy: ${percent(result.negativeGateAccuracy)}`,
    "",
    failures.length ? "Failures:" : "Failures: none"
  ];
  for (const row of failures) {
    lines.push(`- ${row.fixture}: "${row.prompt}"`);
    lines.push(`  expected: ${row.expected.join(", ") || "(none)"}`);
    if (row.allowed.length) {
      lines.push(`  allowed: ${row.allowed.join(", ")}`);
    }
    lines.push(`  selected: ${row.selectedIds.join(", ") || "(none)"}`);
    if (row.forbidden.length) {
      lines.push(`  rejected: ${row.forbidden.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function summarizeRows(rows, { topK }) {
  let top1Hits = 0;
  let recallHits = 0;
  let recallTotal = 0;
  let falsePositiveHits = 0;
  let falsePositiveTotal = 0;
  let negativeGateHits = 0;
  let negativeGateTotal = 0;
  let calibrationHits = 0;
  let calibrationTotal = 0;

  for (const row of rows) {
    const expected = new Set(row.expected);
    const accepted = new Set([...row.expected, ...row.allowed]);
    const selected = row.selectedIds.slice(0, topK);
    row.failed = false;
    if (!row.expected.length) {
      if (!selected.length) {
        top1Hits += 1;
      }
    } else if (expected.has(selected[0])) {
      top1Hits += 1;
    }

    recallTotal += row.expected.length;
    for (const skill of row.expected) {
      if (selected.includes(skill)) {
        recallHits += 1;
      } else {
        row.failed = true;
      }
    }

    falsePositiveTotal += selected.length;
    for (const skill of selected) {
      if (!accepted.has(skill)) {
        falsePositiveHits += 1;
        row.failed = true;
      }
    }

    negativeGateTotal += row.forbidden.length;
    for (const skill of row.forbidden) {
      if (!selected.includes(skill)) {
        negativeGateHits += 1;
      } else {
        row.failed = true;
      }
    }

    for (const skill of row.selected) {
      calibrationTotal += 1;
      const acceptedSelected = accepted.has(skill.name);
      const confident = Number(skill.confidence || 0) >= 0.65;
      if (acceptedSelected === confident) calibrationHits += 1;
    }
    if (!row.selected.length && !row.expected.length) {
      calibrationTotal += 1;
      calibrationHits += 1;
    }
  }

  return {
    caseCount: rows.length,
    top1Accuracy: rows.length ? top1Hits / rows.length : 0,
    top3Recall: recallTotal ? recallHits / recallTotal : 1,
    falsePositiveRate: falsePositiveTotal ? falsePositiveHits / falsePositiveTotal : 0,
    confidenceCalibration: calibrationTotal ? calibrationHits / calibrationTotal : 1,
    negativeGateAccuracy: negativeGateTotal ? negativeGateHits / negativeGateTotal : 1,
    rows
  };
}

function skillToMetadata(skill) {
  return {
    id: skill.id,
    name: skill.id,
    positivePrompts: skill.positive_triggers?.prompts || [],
    files: skill.positive_triggers?.files || [],
    dependencies: skill.positive_triggers?.dependencies || [],
    negativePrompts: skill.negative_triggers?.prompts || [],
    negativeFiles: skill.negative_triggers?.files || [],
    negativeDependencies: skill.negative_triggers?.dependencies || [],
    relatedSkills: skill.related_skills || []
  };
}

function semanticScores({ prompt, skills }) {
  const promptTokens = new Set(tokenize(prompt));
  const scores = new Map();
  for (const skill of skills) {
    const tokens = new Set(tokenize(`${skill.name} ${skill.description}`));
    const overlap = [...promptTokens].filter((token) => tokens.has(token)).length;
    scores.set(skill.name, Math.max(0.45, Math.min(0.92, 0.5 + overlap * 0.1)));
  }
  return scores;
}

function tokenize(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9@.-]+/).filter((token) => token.length > 2);
}

function normalizeSkillId(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function parseEvalYaml(content) {
  const lines = String(content || "").split(/\r?\n/);
  const result = { skills: [], cases: [] };
  let section = null;
  let current = null;
  let triggerGroup = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const line = rawLine.trim();
    if (line === "skills:") {
      section = "skills";
      current = null;
      continue;
    }
    if (line === "cases:") {
      section = "cases";
      current = null;
      continue;
    }
    if (line.startsWith("- id:")) {
      current = {
        id: scalar(line.slice(5)),
        description: "",
        positive_triggers: {},
        negative_triggers: {},
        related_skills: []
      };
      result.skills.push(current);
      triggerGroup = null;
      continue;
    }
    if (line.startsWith("- prompt:")) {
      current = {
        prompt: scalar(line.slice(9)),
        fixture: "",
        expected: [],
        allowed: [],
        forbidden: []
      };
      result.cases.push(current);
      triggerGroup = null;
      continue;
    }
    if (!current) continue;
    if (line === "positive_triggers:") {
      triggerGroup = current.positive_triggers;
      continue;
    }
    if (line === "negative_triggers:") {
      triggerGroup = current.negative_triggers;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const normalizedKey = key === "rejected" ? "forbidden" : key;
    const target = triggerGroup && ["prompts", "files", "dependencies"].includes(key)
      ? triggerGroup
      : current;
    target[normalizedKey] = parseValue(rawValue);
  }

  return result;
}

function parseValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(scalar).filter(Boolean);
  }
  return scalar(trimmed);
}

function scalar(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSkillRoutingEval();
  console.log(formatSkillRoutingBenchmark(result));
}
