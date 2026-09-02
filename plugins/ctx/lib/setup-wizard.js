// Interactive setup starts empty so users choose intentionally. Non-interactive
// --yes needs a deterministic target, so it defaults to Codex.
const DEFAULT_AGENTS = [];
const DEFAULT_YES_AGENTS = ["codex"];

export function parseSetupArgs(args = []) {
  const agentsFlag = args.indexOf("--agents");
  const agentsProvided = agentsFlag >= 0;
  const yes = args.includes("--yes") || args.includes("-y");
  const agents = agentsFlag >= 0
    ? parseAgentList(args[agentsFlag + 1])
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

export function parseAgentList(value = "") {
  const agents = String(value || "")
    .split(",")
    .map((item) => normalizeSetupAgent(item))
    .filter(Boolean);
  return [...new Set(agents)];
}

export function normalizeSetupAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  if (normalized === "antigravity") return "agy";
  return normalized;
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
