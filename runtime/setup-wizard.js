import { parseAgents, resolveAgent } from "./agents.js";

/**
 * Interactive setup used to start with nothing selected, so pressing Enter at
 * the agent prompt produced an empty selection — and the wizard only noticed
 * after asking every remaining question. The interactive default now comes
 * from `agentSelectionOptions()`, which preselects the agents this machine
 * actually has; this list stays empty only as the "user has not chosen yet"
 * marker that the prompt fills in.
 *
 * Non-interactive `--yes` needs a deterministic target, so it defaults to Codex.
 */
const DEFAULT_AGENTS = [];
const DEFAULT_YES_AGENTS = ["codex"];

export function parseSetupArgs(args = []) {
  const agentsFlag = args.indexOf("--agents");
  const agentsProvided = agentsFlag >= 0;
  const yes = args.includes("--yes") || args.includes("-y");
  // `--agents ""` and `--agents bogus` used to yield an empty list that only
  // failed at the very end of the wizard, as an "internal bug". Validate here.
  const agents = agentsFlag >= 0
    ? parseAgents(args[agentsFlag + 1], { flag: "--agents" })
    : yes
      ? DEFAULT_YES_AGENTS
      : DEFAULT_AGENTS;

  return {
    agents,
    agentsProvided,
    yes,
    quiet: args.includes("--quiet"),
    syncRules: !args.includes("--no-rules"),
    syncSkills: !args.includes("--no-skills"),
    generateProjectContext: args.includes("--generate-project-context")
  };
}

/**
 * Lenient parse, kept for callers that build a list from already-trusted input.
 * Use `parseAgents` from `runtime/agents.js` for anything a user typed: it
 * rejects unknown names instead of dropping them.
 */
export function parseAgentList(value = "") {
  const agents = String(value || "")
    .split(",")
    .map((item) => normalizeSetupAgent(item))
    .filter(Boolean);
  return [...new Set(agents)];
}

export function normalizeSetupAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  return resolveAgent(normalized) || normalized;
}

export function setupSummaryLines({
  cwd = process.cwd(),
  agents = DEFAULT_AGENTS,
  syncRules = true,
  syncSkills = true,
  generateProjectContext = false,
  promptSections = null,
  promptLimits = null
} = {}) {
  const lines = [
    `Installation directory: ${cwd}`,
    `Agents: ${agents.join(", ") || "(none)"}`,
    `Prompt context injection: always enabled`,
    `Ruler rule/MCP sync: ${syncRules ? "enabled" : "skipped"}`,
    `skillshare skill sync: ${syncSkills ? "enabled" : "skipped"}`,
    `Project context generation: ${generateProjectContext ? "enabled" : "skipped"}`
  ];
  if (promptSections !== null) lines.push(`Prompt sections shown: ${promptSections}`);
  if (promptLimits !== null) lines.push(`Prompt suggest limits: ${promptLimits}`);
  return lines;
}
