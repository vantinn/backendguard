import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageError } from "./errors.js";

/**
 * The single source of truth for which agents BackendGuard supports and how
 * their names are spelled.
 *
 * Before this module the same knowledge was written down four times — the
 * install command's `SUPPORTED_AGENTS`, the setup wizard's inline option list,
 * `normalizeInstallAgent` and `normalizeSetupAgent` — and they disagreed. The
 * install command accepted any string and only discovered `bogus` was not an
 * agent *after* it had already copied the package and printed "Installing
 * bogus...", then reported the user's typo as an internal BackendGuard bug.
 *
 * `value` is the internal identifier, kept as-is for backward compatibility:
 * Antigravity is `agy` internally and `antigravity` to Ruler and skillshare.
 */
export const AGENTS = [
  { value: "codex", label: "Codex", aliases: ["codex"], home: ".codex" },
  { value: "claude", label: "Claude Code", aliases: ["claude"], home: ".claude" },
  { value: "agy", label: "Antigravity", aliases: ["agy", "antigravity"], home: ".gemini" },
  { value: "copilot", label: "GitHub Copilot", aliases: ["copilot"], home: ".github" }
];

/** Internal identifiers, in display order. */
export const AGENT_VALUES = AGENTS.map((agent) => agent.value);

/** Every spelling a user may type, for error messages. */
export const AGENT_ALIASES = [...new Set(AGENTS.flatMap((agent) => agent.aliases))];

/** The agent used when nothing is selected and nothing can be detected. */
export const FALLBACK_AGENT = "codex";

const ALIAS_TO_VALUE = new Map();
for (const agent of AGENTS) {
  for (const alias of agent.aliases) ALIAS_TO_VALUE.set(alias, agent.value);
}

function agentListHint() {
  return `Supported agents: ${AGENT_ALIASES.join(", ")}.`;
}

/**
 * Maps any accepted spelling to its internal identifier.
 * Returns null for anything unrecognised — callers decide whether that is an
 * error (an explicit `--agent bogus`) or simply a value to drop.
 */
export function resolveAgent(name) {
  return ALIAS_TO_VALUE.get(String(name || "").trim().toLowerCase()) || null;
}

/** The name Ruler and skillshare use, which is `antigravity`, not `agy`. */
export function externalAgentName(value) {
  return value === "agy" ? "antigravity" : value;
}

export function agentLabel(value) {
  return AGENTS.find((agent) => agent.value === value)?.label || value;
}

/**
 * Validates one agent name, raising a usage error the CLI prints as a message
 * rather than a stack trace.
 */
export function assertKnownAgent(name) {
  const raw = String(name || "").trim();
  if (!raw) {
    throw new UsageError("An agent name is required.", {
      hint: `Example: backendguard install claude. ${agentListHint()}`
    });
  }
  if (/[|/]/.test(raw)) {
    throw new UsageError(`Invalid agent '${raw}'.`, {
      hint: "Install one agent per command — `|` is a shell pipe, not a separator. "
        + "For several agents use a comma: backendguard install --agents codex,claude"
    });
  }
  const resolved = resolveAgent(raw);
  if (!resolved) {
    throw new UsageError(`Unknown agent '${raw}'.`, { hint: agentListHint() });
  }
  return resolved;
}

/**
 * Parses a comma-separated agent list, rejecting unknown names.
 * An empty or whitespace-only list is a usage error, not an empty result:
 * `--agents ""` used to install nothing and exit 0, so a mistyped shell
 * variable looked like a successful install.
 */
export function parseAgents(value, { flag = "--agents" } = {}) {
  const raw = String(value ?? "");
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    throw new UsageError(`${flag} needs at least one agent name.`, {
      hint: `Example: ${flag} codex,claude. ${agentListHint()}`
    });
  }
  return [...new Set(parts.map((part) => assertKnownAgent(part)))];
}

/**
 * Resolves the agents for `backendguard install` from its argv.
 *
 * Three spellings are supported, all of them documented:
 *   backendguard install claude            (positional — was silently ignored)
 *   backendguard install --agent claude
 *   backendguard install --agents claude,codex
 *
 * Returns null when the user named no agent at all, which is the only case
 * that should reach an interactive prompt.
 */
export function parseInstallAgents(argv = [], { knownFlags = [] } = {}) {
  const flagIndex = Math.max(argv.indexOf("--agent"), argv.indexOf("--agents"));
  if (flagIndex >= 0) {
    const flag = argv[flagIndex];
    const value = argv[flagIndex + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`${flag} requires a value.`, {
        hint: `Example: backendguard install ${flag} claude. ${agentListHint()}`
      });
    }
    return { agents: parseAgents(value, { flag }), source: flag };
  }

  // A positional agent name: everything that is not a flag and not the value
  // consumed by a flag. `install --copy` has no positional, so this stays null.
  const consumed = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    if (knownFlags.includes(argv[index])) consumed.add(index + 1);
  }
  const positionals = argv
    .slice(1)
    .filter((argument, index) => !argument.startsWith("-") && !consumed.has(index + 1));

  if (!positionals.length) return null;
  if (positionals.length > 1) {
    throw new UsageError(`backendguard install takes one agent name, got: ${positionals.join(", ")}.`, {
      hint: `For several agents use --agents: backendguard install --agents ${positionals.join(",")}`
    });
  }
  return { agents: [assertKnownAgent(positionals[0])], source: "positional" };
}

/**
 * Agents this machine or project shows evidence of, used to preselect the
 * interactive prompt. Evidence is an agent's own config directory — the same
 * signal the doctor command already reads — so the default reflects what the
 * user actually has installed rather than an arbitrary choice.
 */
export function detectInstalledAgents({
  home = os.homedir(),
  cwd = process.cwd(),
  exists = fs.existsSync
} = {}) {
  return AGENTS
    .filter((agent) => exists(path.join(home, agent.home)) || exists(path.join(cwd, agent.home)))
    .map((agent) => agent.value);
}

/**
 * The options passed to the interactive multi-select.
 *
 * Every option carries an explicit boolean `selected`, because the prompt
 * treats a missing `selected` as true in one code path and as false in
 * another. Detected agents are preselected and say so; when nothing is
 * detected, Codex is preselected so pressing Enter always installs something
 * rather than silently doing nothing.
 */
export function agentSelectionOptions({
  home = os.homedir(),
  cwd = process.cwd(),
  exists = fs.existsSync,
  preselect = null
} = {}) {
  const detected = new Set(detectInstalledAgents({ home, cwd, exists }));
  const explicit = preselect === null ? null : new Set(preselect);
  const fallback = !explicit && detected.size === 0;

  return AGENTS.map((agent) => {
    const selected = explicit
      ? explicit.has(agent.value)
      : detected.has(agent.value) || (fallback && agent.value === FALLBACK_AGENT);
    let hint;
    if (detected.has(agent.value)) hint = "detected on this machine";
    else if (fallback && agent.value === FALLBACK_AGENT) hint = "default";
    return { label: agent.label, value: agent.value, selected, ...(hint ? { hint } : {}) };
  });
}

/**
 * The error raised the moment a selection comes back empty.
 *
 * This is a usage problem — the user picked nothing — so it must carry exit
 * code 2 and instructions. The setup wizard used to throw a bare `Error` for
 * this, and only after it had asked every remaining question, so the run ended
 * in "This is a bug in BackendGuard. Please report it."
 */
export function emptyAgentSelectionError({ command = "backendguard install" } = {}) {
  return new UsageError("No agents selected — nothing would be installed.", {
    hint: `Press Space to toggle an agent, then Enter. To skip the prompt: ${command} --agents codex,claude. ${agentListHint()}`
  });
}
