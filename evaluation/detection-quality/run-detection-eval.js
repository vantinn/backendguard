#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeProject } from "../../analysis/index.js";

/**
 * Measures detection quality against labelled fixtures.
 *
 * Each fixture carries an `expected-findings.json` listing:
 *   - `expected`  defects deliberately planted; a missing one is a FALSE NEGATIVE.
 *   - `controls`  files written to be correct; any finding in one is a
 *                 FALSE POSITIVE, including findings that merely *look* right —
 *                 a control file is the honest test of precision.
 *   - `tolerated` genuinely ambiguous cases the tool reports at low confidence.
 *                 These count as neither a true nor a false positive; they are
 *                 listed separately so the number stays visible instead of
 *                 being quietly excused.
 *
 * The rates this prints are rates *over this fixture corpus*, not a claim about
 * detection quality on arbitrary code. That distinction is stated in the output
 * so a reader cannot mistake one for the other.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function listFixtures(fixturesDir = FIXTURES_DIR) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fixturesDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "expected-findings.json")))
    .sort();
}

export function evaluateFixture(fixtureDir) {
  const label = JSON.parse(fs.readFileSync(path.join(fixtureDir, "expected-findings.json"), "utf8"));
  const result = analyzeProject({ cwd: fixtureDir });
  const findings = result.findings;

  const controlFiles = new Set((label.controls || []).map((entry) => entry.file));
  const tolerated = new Set((label.tolerated || []).map((entry) => `${entry.id}@${entry.file}`));

  const truePositives = [];
  const falseNegatives = [];
  for (const expected of label.expected || []) {
    const hit = findings.find((finding) => finding.id === expected.id && finding.file === expected.file);
    if (hit) truePositives.push({ ...expected, line: hit.line });
    else falseNegatives.push(expected);
  }

  const expectedKeys = new Set((label.expected || []).map((entry) => `${entry.id}@${entry.file}`));
  const falsePositives = [];
  const toleratedHits = [];
  const extra = [];
  for (const finding of findings) {
    const key = `${finding.id}@${finding.file}`;
    if (expectedKeys.has(key)) continue;
    if (tolerated.has(key)) {
      toleratedHits.push(finding);
    } else if (controlFiles.has(finding.file)) {
      falsePositives.push(finding);
    } else {
      // A finding outside both the expected list and the control files: real
      // but unlabelled. Reported so the corpus can be extended rather than
      // silently counted as either correct or incorrect.
      extra.push(finding);
    }
  }

  // Stack detection is part of detection quality: routing the wrong analyzers
  // is a failure mode of its own.
  const stackMismatches = Object.entries(label.stack || {})
    .filter(([field, value]) => result.stack[field] !== value)
    .map(([field, value]) => ({ field, expected: value, actual: result.stack[field] }));

  const forbiddenAnalyzersRun = (label.forbiddenAnalyzers || []).filter((id) => result.ran.includes(id));

  return {
    name: label.name,
    description: label.description,
    filesAnalyzed: result.filesAnalyzed,
    analyzersRun: result.ran,
    analyzerErrors: result.errors,
    truePositives,
    falsePositives,
    falseNegatives,
    toleratedHits,
    extra,
    stackMismatches,
    forbiddenAnalyzersRun,
    totalFindings: findings.length
  };
}

export function runDetectionEval({ fixturesDir = FIXTURES_DIR } = {}) {
  const fixtures = listFixtures(fixturesDir).map(evaluateFixture);
  const sum = (key) => fixtures.reduce((total, fixture) => total + fixture[key].length, 0);
  const truePositives = sum("truePositives");
  const falsePositives = sum("falsePositives");
  const falseNegatives = sum("falseNegatives");
  const expected = truePositives + falseNegatives;

  return {
    fixtures,
    totals: {
      expected,
      truePositives,
      falsePositives,
      falseNegatives,
      tolerated: sum("toleratedHits"),
      unlabelled: sum("extra"),
      recall: expected ? round(truePositives / expected) : 0,
      // Precision is measured over control files only: those are the files
      // asserted to be correct, so a finding there is unambiguously wrong.
      precision: truePositives + falsePositives ? round(truePositives / (truePositives + falsePositives)) : 1,
      falseNegativeRate: expected ? round(falseNegatives / expected) : 0,
      falsePositiveRate: truePositives + falsePositives ? round(falsePositives / (truePositives + falsePositives)) : 0,
      stackMismatches: sum("stackMismatches"),
      forbiddenAnalyzersRun: sum("forbiddenAnalyzersRun"),
      analyzerErrors: sum("analyzerErrors")
    }
  };
}

function round(value) {
  return Number(value.toFixed(4));
}

export function formatDetectionEval(result) {
  const lines = ["Detection quality (labelled fixtures)", ""];
  for (const fixture of result.fixtures) {
    lines.push(`${fixture.name} — ${fixture.filesAnalyzed} files, analyzers: ${fixture.analyzersRun.join(", ")}`);
    lines.push(`  true positives : ${fixture.truePositives.length}/${fixture.truePositives.length + fixture.falseNegatives.length}`);
    lines.push(`  false positives: ${fixture.falsePositives.length} (findings inside files labelled correct)`);
    lines.push(`  false negatives: ${fixture.falseNegatives.length}`);
    lines.push(`  tolerated      : ${fixture.toleratedHits.length} (ambiguous, reported at low confidence)`);
    lines.push(`  unlabelled     : ${fixture.extra.length}`);
    for (const missing of fixture.falseNegatives) lines.push(`    MISSED ${missing.id} in ${missing.file} — ${missing.why}`);
    for (const wrong of fixture.falsePositives) lines.push(`    FALSE  ${wrong.id} in ${wrong.file}:${wrong.line} — ${wrong.title}`);
    for (const item of fixture.stackMismatches) lines.push(`    STACK  ${item.field}: expected ${item.expected}, got ${item.actual}`);
    for (const id of fixture.forbiddenAnalyzersRun) lines.push(`    WRONG-ANALYZER ${id} ran against this stack`);
    for (const error of fixture.analyzerErrors) lines.push(`    ERROR  ${error.analyzer}: ${error.message}`);
    lines.push("");
  }
  const totals = result.totals;
  lines.push("Totals across the fixture corpus");
  lines.push(`  recall               : ${percent(totals.recall)} (${totals.truePositives}/${totals.expected} planted defects found)`);
  lines.push(`  precision (controls) : ${percent(totals.precision)}`);
  lines.push(`  false negative rate  : ${percent(totals.falseNegativeRate)}`);
  lines.push(`  false positive rate  : ${percent(totals.falsePositiveRate)}`);
  lines.push(`  tolerated ambiguous  : ${totals.tolerated}`);
  lines.push(`  unlabelled findings  : ${totals.unlabelled}`);
  lines.push(`  stack mismatches     : ${totals.stackMismatches}`);
  lines.push(`  analyzer errors      : ${totals.analyzerErrors}`);
  lines.push("");
  lines.push("These rates describe this fixture corpus only. They are not a claim about");
  lines.push("detection quality on arbitrary codebases.");
  return lines.join("\n");
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runDetectionEval();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDetectionEval(result));
  }
  const failed = result.totals.falseNegatives > 0
    || result.totals.falsePositives > 0
    || result.totals.stackMismatches > 0
    || result.totals.forbiddenAnalyzersRun > 0
    || result.totals.analyzerErrors > 0;
  process.exitCode = failed ? 1 : 0;
}
