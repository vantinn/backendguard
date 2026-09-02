import fs from "node:fs";
import path from "node:path";

import { writeJsonFile } from "./fs-utils.js";
import { defaultDataRoot } from "./workspace-data.js";

const CONFIG_FILE = "output-config.json";

export const OUTPUT_SECTION_OPTIONS = [
  { value: "rules", label: "Critical BackendGuard rules", hint: "Include critical and additional relevant AGENTS.md rules." },
  { value: "files", label: "Suggested files to check", hint: "Include semantic, import-graph, and code-review-graph file suggestions." },
  { value: "skills", label: "Suggested skills for this task", hint: "Include matching local skill recommendations." },
  { value: "workflows", label: "Suggested workflow for this task", hint: "Include matching workflow recommendations." }
];

export const OUTPUT_LIMIT_OPTIONS = [
  { value: "files", label: "Suggested files", defaultValue: "auto", min: 3, max: 15, cap: 20 },
  { value: "skills", label: "Suggested skills", defaultValue: "auto", min: 1, max: 8, cap: 10 },
  { value: "workflows", label: "Suggested workflows", defaultValue: "auto", min: 1, max: 3, cap: 5 }
];

export function defaultOutputConfig() {
  return {
    sections: Object.fromEntries(OUTPUT_SECTION_OPTIONS.map((option) => [option.value, true])),
    limits: Object.fromEntries(OUTPUT_LIMIT_OPTIONS.map((option) => [option.value, option.defaultValue]))
  };
}

export function outputConfigPath(dataRoot = defaultDataRoot()) {
  return path.join(dataRoot, CONFIG_FILE);
}

export function loadOutputConfig({ dataRoot = defaultDataRoot() } = {}) {
  try {
    return normalizeOutputConfig(JSON.parse(fs.readFileSync(outputConfigPath(dataRoot), "utf8")));
  } catch {
    return defaultOutputConfig();
  }
}

export function saveOutputConfig(config, { dataRoot = defaultDataRoot() } = {}) {
  const normalized = normalizeOutputConfig(config);
  writeJsonFile(outputConfigPath(dataRoot), normalized);
  return normalized;
}

export function enabledOutputSections(config = loadOutputConfig()) {
  const normalized = normalizeOutputConfig(config);
  return OUTPUT_SECTION_OPTIONS
    .filter((option) => normalized.sections[option.value])
    .map((option) => option.value);
}

export function enabledOutputSectionsLabel(config = loadOutputConfig()) {
  const enabled = enabledOutputSections(config);
  return enabled.length ? enabled.join(", ") : "(none)";
}

export function outputConfigLimits(config = loadOutputConfig()) {
  const normalized = normalizeOutputConfig(config);
  return Object.fromEntries(OUTPUT_LIMIT_OPTIONS.map((option) => [
    option.value,
    numericLimitForRetrieval(normalized.limits[option.value], option)
  ]));
}

export function outputConfigLimitsLabel(config = loadOutputConfig()) {
  const limits = normalizeOutputConfig(config).limits;
  return OUTPUT_LIMIT_OPTIONS.map((option) => `${option.value}: ${limits[option.value]}`).join(", ");
}

export async function configureOutputSections({
  dataRoot = defaultDataRoot(),
  select,
  askLimit,
  logger = console.log
} = {}) {
  if (typeof select !== "function") throw new Error("configureOutputSections requires a multi-select function");
  const current = loadOutputConfig({ dataRoot });
  const selected = await select({
    message: "Select BackendGuard prompt sections to show:",
    options: OUTPUT_SECTION_OPTIONS.map((option) => ({
      ...option,
      selected: current.sections[option.value]
    }))
  });
  const selectedSet = new Set(selected);
  const limits = {};
  for (const option of OUTPUT_LIMIT_OPTIONS) {
    limits[option.value] = typeof askLimit === "function"
      ? await askLimit({ option, currentValue: current.limits[option.value] })
      : current.limits[option.value];
  }
  const saved = saveOutputConfig({
    sections: Object.fromEntries(OUTPUT_SECTION_OPTIONS.map((option) => [option.value, selectedSet.has(option.value)])),
    limits
  }, { dataRoot });
  logger(`│  Saved BackendGuard prompt section config: ${outputConfigPath(dataRoot)}`);
  logger(`│  Enabled sections: ${enabledOutputSectionsLabel(saved)}`);
  logger(`│  Suggest limits: ${outputConfigLimitsLabel(saved)}`);
  return saved;
}

function normalizeOutputConfig(config = {}) {
  const defaults = defaultOutputConfig();
  const nestedOutput = config.output || {};
  return {
    sections: Object.fromEntries(OUTPUT_SECTION_OPTIONS.map((option) => [
      option.value,
      typeof config.sections?.[option.value] === "boolean"
        ? config.sections[option.value]
        : typeof nestedOutput[option.value]?.enabled === "boolean"
          ? nestedOutput[option.value].enabled
        : defaults.sections[option.value]
    ])),
    limits: Object.fromEntries(OUTPUT_LIMIT_OPTIONS.map((option) => [
      option.value,
      normalizeLimit(config.limits?.[option.value] ?? nestedOutput[option.value]?.limit, option)
    ]))
  };
}

function normalizeLimit(value, option) {
  if (String(value || "").toLowerCase() === "auto") return "auto";
  const number = Number(value);
  if (!Number.isFinite(number)) return option.defaultValue;
  return Math.max(0, Math.min(option.cap || option.max, Math.trunc(number)));
}

function numericLimitForRetrieval(value, option) {
  if (value === "auto") return option.max;
  const number = Number(value);
  if (!Number.isFinite(number)) return option.max;
  return Math.max(0, Math.min(option.cap || option.max, Math.trunc(number)));
}
