import fs from "node:fs";

import { appendJsonLine } from "./fs-utils.js";

const MAX_TEXT_VALUES = 80;
const MAX_TEXT_LENGTH = 500;
const MAX_EVENTS = 500;

const TOOL_SIGNAL_KEYS = new Set([
  "tool",
  "tool_name",
  "toolName",
  "name",
  "server",
  "mcp",
  "command",
  "cmd"
]);

const SIGNAL_PATTERNS = [
  /\bcode-review-graph\b/i,
  /\brtk\b/i,
  /\bdetect_changes\b/i,
  /\bget_review_context\b/i,
  /\bget_impact_radius\b/i,
  /\bget_affected_flows\b/i,
  /\bquery_graph\b/i,
  /\bsemantic_search_nodes\b/i,
  /\bget_architecture_overview\b/i,
  /\blist_communities\b/i,
  /\bagentmemory\b/i
];

export function appendTelemetry({ telemetryPath, event, payload, extra = {} }) {
  if (!telemetryPath) return;
  try {
    appendJsonLine(telemetryPath, buildTelemetryEvent({ event, payload, extra }));
  } catch {
    // Telemetry is diagnostic; hooks must stay fail-open.
  }
}

export function buildTelemetryEvent({ event, payload, extra = {}, at = new Date() }) {
  const extracted = extractPayloadSignals(payload);
  return {
    at: at.toISOString(),
    event,
    cwd: payload?.cwd || payload?.working_directory || null,
    ...extra,
    signals: extracted.signals,
    toolSignals: extracted.toolSignals,
    commandSignals: extracted.commandSignals
  };
}

export function loadRuntimeEvidence({ telemetryPath, since, cwd, payload } = {}) {
  const events = [];
  if (telemetryPath && fs.existsSync(telemetryPath)) {
    const lines = fs.readFileSync(telemetryPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-MAX_EVENTS);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore corrupt telemetry lines.
      }
    }
  }

  if (payload) {
    events.push(buildTelemetryEvent({ event: payload.hook_event_name || "Stop", payload }));
  }

  const sinceMs = since ? Date.parse(since) : null;
  const filtered = events.filter((event) => {
    if (cwd && event.cwd && event.cwd !== cwd) return false;
    if (sinceMs && event.at && Date.parse(event.at) < sinceMs) return false;
    return true;
  });

  const signals = new Set();
  const toolSignals = new Set();
  const commandSignals = new Set();
  const sources = [];

  for (const event of filtered) {
    for (const signal of event.signals || []) signals.add(signal);
    for (const signal of event.toolSignals || []) toolSignals.add(signal);
    for (const signal of event.commandSignals || []) commandSignals.add(signal);
    if ((event.signals?.length || event.toolSignals?.length || event.commandSignals?.length) && sources.length < 20) {
      sources.push({ at: event.at, event: event.event, cwd: event.cwd });
    }
  }

  return {
    signals: [...signals],
    toolSignals: [...toolSignals],
    commandSignals: [...commandSignals],
    sources
  };
}

export function findRuntimeEvidence(rule, runtimeEvidence = {}) {
  const content = String(rule?.content || "");
  const candidates = [
    ...(runtimeEvidence.toolSignals || []),
    ...(runtimeEvidence.commandSignals || []),
    ...(runtimeEvidence.signals || [])
  ];
  const lowerCandidates = candidates.map((value) => String(value || "").toLowerCase());

  const wanted = runtimeKeywordsForRule(content);
  for (const keyword of wanted) {
    const lowerKeyword = keyword.toLowerCase();
    const match = lowerCandidates.find((candidate) => candidate.includes(lowerKeyword));
    if (match) {
      return {
        keyword,
        evidence: `runtime telemetry observed ${keyword}`
      };
    }
  }

  return null;
}

export function runtimeKeywordsForRule(content) {
  const lower = String(content || "").toLowerCase();
  const keywords = [];
  for (const pattern of SIGNAL_PATTERNS) {
    const match = lower.match(pattern);
    if (match?.[0]) keywords.push(match[0]);
  }
  const backticks = [...String(content || "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  for (const value of backticks) {
    if (SIGNAL_PATTERNS.some((pattern) => pattern.test(value))) keywords.push(value);
  }
  return [...new Set(keywords)];
}

function extractPayloadSignals(payload) {
  const values = [];
  const toolSignals = [];
  const commandSignals = [];

  walk(payload, [], (path, value) => {
    if (values.length < MAX_TEXT_VALUES) values.push(value);
    const key = path.at(-1) || "";
    if (TOOL_SIGNAL_KEYS.has(key)) {
      toolSignals.push(value);
      if (key === "command" || key === "cmd") commandSignals.push(value);
    }
  });

  const signals = [];
  for (const value of values) {
    for (const pattern of SIGNAL_PATTERNS) {
      const match = String(value).match(pattern);
      if (match?.[0]) signals.push(match[0]);
    }
  }

  return {
    signals: [...new Set(signals)],
    toolSignals: [...new Set(toolSignals.filter(hasSignalPattern))],
    commandSignals: [...new Set(commandSignals.filter(hasSignalPattern))]
  };
}

function walk(value, path, onText) {
  if (value == null) return;
  if (typeof value === "string") {
    const text = value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
    onText(path, text);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => walk(item, [...path, String(index)], onText));
    return;
  }
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    walk(item, [...path, key], onText);
  }
}

function hasSignalPattern(value) {
  return SIGNAL_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}
