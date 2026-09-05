import { UsageError } from "./exit-codes.js";

/**
 * One description of every command, used for three things that used to drift
 * apart: the top-level `backendguard --help`, per-command `backendguard <cmd>
 * --help`, and validation of the flags a command accepts.
 *
 * A command listed here without a matching dispatch branch (or the reverse) is
 * caught by a test, so the help text cannot describe a command that does not
 * exist — the failure mode that makes a CLI's documentation untrustworthy.
 */

/** @type {Array<{name: string, aliases?: string[], group: string, summary: string, usage: string[], options?: Array<[string, string]>, examples?: string[], exitCodes?: Array<[number, string]>}>} */
export const COMMANDS = [
  {
    name: "analyze",
    group: "Analysis",
    summary: "Run every applicable static analyzer over the project and report findings.",
    usage: ["backendguard analyze [path]"],
    options: [
      ["--json", "Emit findings as JSON instead of formatted text."],
      ["--severity <level>", "Only report findings at or above this severity (critical|high|medium|low). Default: low."],
      ["--confidence <level>", "Only report findings at or above this confidence (certain|high|medium|low). Default: low."],
      ["--category <names>", "Comma-separated categories to include (security, database, performance, scalability)."],
      ["--fail-on <level>", "Exit 1 when a finding at or above this severity is reported. Default: never fail."],
      ["--analyzer <ids>", "Comma-separated analyzer ids to run instead of the applicable set."],
      ["--list-analyzers", "Print the registered analyzers and exit."]
    ],
    examples: [
      "backendguard analyze",
      "backendguard analyze ./services/billing --severity high",
      "backendguard analyze --json --fail-on high"
    ],
    exitCodes: [
      [0, "no findings at or above --fail-on"],
      [1, "findings at or above --fail-on were reported"],
      [2, "invalid arguments"],
      [3, "the path is not a readable directory"]
    ]
  },
  {
    name: "check",
    group: "Analysis",
    summary: "Analyze uncommitted changes for compliance and structural risk.",
    usage: ["backendguard check"],
    options: [
      ["--json", "Emit the compliance report as JSON."],
      ["--fail-on <level>", "Exit 1 when a finding at or above this severity is reported."]
    ],
    examples: ["backendguard check", "backendguard check --fail-on high"],
    exitCodes: [
      [0, "no blocking findings"],
      [1, "findings at or above --fail-on"],
      [3, "not inside a git repository"]
    ]
  },
  {
    name: "stack",
    group: "Analysis",
    summary: "Detect and print the backend stack (framework, database, ORM, cache).",
    usage: ["backendguard stack [path]"],
    options: [
      ["--json", "Emit the detected stack, including evidence, as JSON."],
      ["--evidence", "Show the dependency or file each detection is based on."]
    ],
    examples: ["backendguard stack", "backendguard stack --evidence"]
  },
  {
    name: "doctor",
    group: "Analysis",
    summary: "Score how ready this repository is for agent-assisted backend work.",
    usage: ["backendguard doctor"],
    options: [
      ["--fix", "Generate starter project skills and a workflow."],
      ["--force", "With --fix, overwrite existing generated files."],
      ["--json", "Emit the readiness report as JSON."]
    ],
    examples: ["backendguard doctor", "backendguard doctor --fix"]
  },
  {
    name: "context",
    aliases: ["debug"],
    group: "Agent context",
    summary: "Retrieve task-aware backend engineering context for a task.",
    usage: ['backendguard context -- "task description"'],
    options: [["--json", "Emit the scheduled context as JSON."]],
    examples: ['backendguard context -- "add a registration endpoint"']
  },
  {
    name: "report",
    group: "Analysis",
    summary: "Show the last compliance report.",
    usage: ["backendguard report"],
    options: [["--json", "Emit the stored report as JSON."]]
  },
  {
    name: "evidence",
    group: "Analysis",
    summary: "Show the evidence behind the last compliance report.",
    usage: ["backendguard evidence"]
  },
  {
    name: "install",
    group: "Setup",
    summary: "Install BackendGuard into one or more AI coding agents.",
    usage: ["backendguard install", "backendguard install --agent <name>"],
    options: [
      ["--agent <name>", "codex | claude | antigravity | copilot. One agent per invocation."],
      ["--agents <names>", "Comma-separated list of agents."],
      ["--copy", "Copy a self-contained package under $CODEX_HOME without touching hook/MCP config."]
    ],
    examples: ["backendguard install", "backendguard install --agent claude"]
  },
  {
    name: "setup",
    group: "Setup",
    summary: "Interactive full setup wizard.",
    usage: ["backendguard setup"],
    options: [
      ["--yes", "Auto-confirm all prompts."],
      ["--agents <names>", "Pre-select agents to install."],
      ["--generate-project-context", "Generate starter project skills and workflow."],
      ["--no-rules", "Skip AGENTS.md rule sync."],
      ["--no-skills", "Skip skill sync."],
      ["--quiet", "Minimal output."]
    ]
  },
  {
    name: "sync",
    group: "Setup",
    summary: "Sync rules, skills, or workflows across the installed agents.",
    usage: ["backendguard sync --rules", "backendguard sync --skills", "backendguard sync --workflows"],
    options: [
      ["--rules", "Sync AGENTS.md rules to all agents."],
      ["--skills", "Sync skills across agents."],
      ["--workflows", "Sync workflows across agents."],
      ["--agents <names>", "Restrict the sync to specific agents."],
      ["--dry-run", "Preview without writing."],
      ["--no-import-codex-mcp", "With --rules, skip importing Codex MCP servers."],
      ["--no-collect", "With --skills, skip collecting new skills."],
      ["--no-embeddings", "With --skills, skip embedding generation."],
      ["--verbose", "Verbose output."]
    ]
  },
  {
    name: "rules",
    aliases: ["skills"],
    group: "Agent context",
    summary: "Browse the backend engineering rule library, or explain rule routing for a task.",
    usage: ["backendguard rules", 'backendguard rules doctor -- "task"'],
    options: [
      ["--agents <names>", "Filter rule libraries for specific agents."],
      ["--refresh", "Force refresh of the rule library cache."]
    ]
  },
  {
    name: "health",
    group: "Diagnostics",
    summary: "Show MCP bridge, embedding model, and index health.",
    usage: ["backendguard health"],
    options: [["--json", "Emit health data as JSON."]]
  },
  {
    name: "stats",
    group: "Diagnostics",
    summary: "Show workspace statistics.",
    usage: ["backendguard stats"]
  },
  {
    name: "benchmark",
    group: "Diagnostics",
    summary: "Benchmark retrieval for a task, or run the rule-routing benchmark.",
    usage: ['backendguard benchmark -- "task"', "backendguard benchmark --skills"],
    options: [["--skills", "Run the rule/skill routing benchmark instead of a task benchmark."]]
  },
  {
    name: "leaderboard",
    group: "Diagnostics",
    summary: "Run the hallucination benchmark, offline or through live agent CLIs.",
    usage: ["backendguard leaderboard --hallucination", "backendguard leaderboard --agents codex,gemini"],
    options: [
      ["--hallucination", "Run the offline deterministic benchmark."],
      ["--live", "With --hallucination, run through a live agent CLI."],
      ["--agents <names>", "Agent CLIs to run."],
      ["--limit <n>", "Maximum number of cases."],
      ["--timeout-ms <n>", "Per-case timeout."]
    ]
  },
  {
    name: "refresh",
    group: "Diagnostics",
    summary: "Sync the active Codex marketplace and rebuild local indexes.",
    usage: ["backendguard refresh"]
  },
  {
    name: "embeddings",
    group: "Diagnostics",
    summary: "Pre-warm the local embedding caches.",
    usage: ['backendguard embeddings warm -- "task"']
  },
  {
    name: "autowarm",
    group: "Diagnostics",
    summary: "Warm embedding caches quietly for the current workspace.",
    usage: ["backendguard autowarm"]
  },
  {
    name: "config",
    group: "Setup",
    summary: "Choose which context sections the prompt hook injects.",
    usage: ["backendguard config"]
  },
  {
    name: "ruler",
    group: "Passthrough",
    summary: "Run the ruler CLI (third-party) with BackendGuard's environment.",
    usage: ["backendguard ruler -- <ruler args>"]
  },
  {
    name: "skillshare",
    group: "Passthrough",
    summary: "Run the skillshare CLI (third-party) with BackendGuard's environment.",
    usage: ["backendguard skillshare -- <skillshare args>"]
  }
];

const GLOBAL_OPTIONS = [
  ["--help, -h", "Show help. Use `backendguard <command> --help` for a single command."],
  ["--version, -v", "Print the installed version."],
  ["--debug", "Include a stack trace when an unexpected error occurs."]
];

const ALIASES = new Map();
for (const command of COMMANDS) {
  for (const alias of command.aliases || []) ALIASES.set(alias, command.name);
}

export function resolveCommandName(name) {
  return ALIASES.get(name) || name;
}

export function findCommand(name) {
  const resolved = resolveCommandName(name);
  return COMMANDS.find((command) => command.name === resolved) || null;
}

export function renderUsage() {
  const lines = [
    "BackendGuard — AI backend engineering guardrails (NestJS · PostgreSQL · TypeORM · Prisma)",
    "",
    "Usage:",
    "  backendguard <command> [options]",
    ""
  ];
  const groups = [...new Set(COMMANDS.map((command) => command.group))];
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 4;
  for (const group of groups) {
    lines.push(`${group}:`);
    for (const command of COMMANDS.filter((entry) => entry.group === group)) {
      const label = command.aliases?.length ? `${command.name} (${command.aliases.join(", ")})` : command.name;
      lines.push(`  ${label.padEnd(width + 8)}${command.summary}`);
    }
    lines.push("");
  }
  lines.push("Global options:");
  for (const [flag, description] of GLOBAL_OPTIONS) lines.push(`  ${flag.padEnd(width + 8)}${description}`);
  lines.push("");
  lines.push("Run `backendguard <command> --help` for the options and exit codes of one command.");
  return lines.join("\n");
}

export function renderCommandHelp(name) {
  const command = findCommand(name);
  if (!command) {
    throw new UsageError(`Unknown command: ${name}`, { hint: "Run `backendguard --help` for the list of commands." });
  }
  const lines = [`backendguard ${command.name} — ${command.summary}`, "", "Usage:"];
  for (const line of command.usage) lines.push(`  ${line}`);
  if (command.aliases?.length) lines.push("", `Aliases: ${command.aliases.join(", ")}`);
  if (command.options?.length) {
    lines.push("", "Options:");
    const width = Math.max(...command.options.map(([flag]) => flag.length)) + 2;
    for (const [flag, description] of command.options) lines.push(`  ${flag.padEnd(width)}${description}`);
  }
  if (command.examples?.length) {
    lines.push("", "Examples:");
    for (const example of command.examples) lines.push(`  ${example}`);
  }
  lines.push("", "Exit codes:");
  const exitCodes = command.exitCodes || [[0, "success"], [2, "invalid arguments"], [70, "internal error"]];
  for (const [code, description] of exitCodes) lines.push(`  ${String(code).padEnd(4)}${description}`);
  return lines.join("\n");
}

export function wantsHelp(args) {
  return args.includes("--help") || args.includes("-h");
}
