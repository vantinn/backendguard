import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync, spawn } from "node:child_process";

import { defaultDataRoot } from "./workspace-data.js";
import { formatTomlValue, readMcpServersFromToml } from "./toml-config.js";

const DEFAULT_AGENTS = ["codex", "claude", "antigravity", "copilot"];
const CTX_MCP_NAME = "ctx-mcp";
const BACKENDGUARD_PROXY_MARKER = "/backendguard/plugins/ctx/mcp/proxy.js";
const MCP_SERVER_RELATIVE = path.join("plugins", "ctx", "mcp", "server.js");
const AGENT_ALIASES = new Map([
  ["agy", "antigravity"],
  ["antigravity", "antigravity"],
  ["codex", "codex"],
  ["claude", "claude"],
  ["copilot", "copilot"]
]);

function statusLine(label, value) {
  return `[ctx] ${label.padEnd(38)} ${value}`;
}

function normalizeStdio(stdio) {
  return stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio;
}

function runCommand(command, args, { cwd = process.cwd(), stdio = "pipe", dryRun = false } = {}) {
  if (dryRun) return { stdout: "", skipped: true };
  const stdout = execFileSync(command, args, { cwd, stdio: normalizeStdio(stdio), encoding: "utf8", shell: true });
  return { stdout: stdout || "" };
}

export function parseSyncRulesArgs(args = []) {
  const agentsFlag = args.indexOf("--agents");
  const agents = agentsFlag >= 0
    ? normalizeAgentList(String(args[agentsFlag + 1] || "").split(","))
    : DEFAULT_AGENTS;
  return {
    rules: args.includes("--rules"),
    agents,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    importCodexMcp: !args.includes("--no-import-codex-mcp"),
    yes: args.includes("--yes") || args.includes("-y")
  };
}

export function normalizeAgentName(agent) {
  const key = String(agent || "").trim().toLowerCase();
  return AGENT_ALIASES.get(key) || key;
}

export function normalizeAgentList(agents = []) {
  return [...new Set(agents.map(normalizeAgentName).filter(Boolean))];
}

function displayAgentName(agent) {
  return agent === "antigravity" ? "agy" : agent;
}

function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function claudeUserConfigPath() {
  return process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude.json");
}

export function rulerTomlPath(cwd = process.cwd()) {
  return path.join(cwd, ".ruler", "ruler.toml");
}

export function checkRulerInstalled({ run = runCommand } = {}) {
  try {
    const result = run("ruler", ["--version"]);
    return { installed: true, version: result.stdout.trim() || "installed" };
  } catch {
    return { installed: false, version: "" };
  }
}

async function shouldInstallRuler({ yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("[ctx] Ruler is not installed. Install @intellectronica/ruler globally? [Y/n] ");
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function installRuler({ run = runCommand, yes = false, dryRun = false } = {}) {
  const accepted = await shouldInstallRuler({ yes });
  if (!accepted) {
    throw new Error("Ruler is required for backendguard sync --rules. Install it with `npm install -g @intellectronica/ruler` or rerun with --yes.");
  }
  if (dryRun) {
    run("npm", ["install", "-g", "@intellectronica/ruler"], { stdio: "pipe", dryRun });
  } else {
    console.log("Installing ruler...");
    await spawnCommand("npm", ["install", "-g", "@intellectronica/ruler"]);
  }
}

/**
 * Spawn a child process and stream stdout/stderr line-by-line in real time.
 * stdin is closed immediately to prevent deadlocks on Windows.
 */
function spawnCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true
    });
    const streamLines = (stream) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) console.log(line);
        }
      });
      stream.on("end", () => {
        if (buffer.trim()) console.log(buffer.trim());
      });
    };
    if (child.stdout) streamLines(child.stdout);
    if (child.stderr) streamLines(child.stderr);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export function ensureRulerInit({ cwd = process.cwd(), run = runCommand, dryRun = false } = {}) {
  const tomlPath = rulerTomlPath(cwd);
  if (fs.existsSync(tomlPath)) return { created: false, tomlPath };
  run("ruler", ["init"], { cwd, stdio: "pipe", dryRun });
  return { created: true, tomlPath };
}

function removeTomlSection(content, sectionName) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let skipping = false;
  const header = `[${sectionName}]`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[[^\]]+\]\s*$/.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) result.push(line);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}

function hasTomlSection(content, sectionName) {
  return new RegExp(`^\\[${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`, "m").test(content);
}

function tomlString(value) {
  return formatTomlValue(value);
}

function tomlArray(values = []) {
  return formatTomlValue(values);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unwrapBackendGuardProxy(command, args = []) {
  if (command !== "node" || !String(args[0] || "").includes(BACKENDGUARD_PROXY_MARKER)) {
    return { command, args };
  }
  const separator = args.indexOf("--");
  if (separator < 0 || separator >= args.length - 1) return { command, args };
  return {
    command: args[separator + 1],
    args: args.slice(separator + 2)
  };
}

export function readCodexMcpServers({ configPath = codexConfigPath() } = {}) {
  if (!fs.existsSync(configPath)) return [];
  const content = fs.readFileSync(configPath, "utf8");
  return readMcpServersFromToml(content).map(({ name, command, args }) => {
    const unwrapped = unwrapBackendGuardProxy(command, args);
    return {
      name,
      command: unwrapped.command,
      args: unwrapped.args
    };
  });
}

export function readProjectMcpJsonServers({ cwd = process.cwd(), configPath = path.join(cwd, ".mcp.json") } = {}) {
  if (!fs.existsSync(configPath)) return [];
  const config = readJsonFile(configPath, {});
  const mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  return Object.entries(mcpServers)
    .filter(([, server]) => server && typeof server.command === "string")
    .filter(([, server]) => isRunnableMcpCommand(server.command))
    .map(([name, server]) => ({
      name,
      command: server.command,
      args: Array.isArray(server.args) ? server.args : []
    }));
}

function isRunnableMcpCommand(command) {
  if (isEphemeralAbsoluteCommand(command)) return false;
  if (!path.isAbsolute(command)) return true;
  return fs.existsSync(command);
}

function isEphemeralAbsoluteCommand(command) {
  if (!path.isAbsolute(command)) return false;
  const resolved = path.resolve(command);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`);
}

function mergeMcpServers(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const server of group || []) {
      if (!server?.name || !server?.command) continue;
      if (!merged.has(server.name)) merged.set(server.name, server);
    }
  }
  return [...merged.values()];
}

function readRulerMcpServers({ tomlPath } = {}) {
  if (!tomlPath || !fs.existsSync(tomlPath)) return [];
  const content = fs.readFileSync(tomlPath, "utf8");
  return readMcpServersFromToml(content);
}

function readRulerMcpServer({ tomlPath, name } = {}) {
  return readRulerMcpServers({ tomlPath }).find((server) => server.name === name) || null;
}

function antigravityMcpConfigPaths() {
  const home = os.homedir();
  return [
    path.join(home, ".gemini", "antigravity", "mcp_config.json"),
    path.join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    path.join(home, ".gemini", "config", "mcp_config.json")
  ];
}

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function syncAntigravityMcpFromRuler({ tomlPath, configPaths = antigravityMcpConfigPaths(), dryRun = false } = {}) {
  const allServers = readRulerMcpServers({ tomlPath });
  const servers = allServers.filter((server) => isRunnableMcpCommand(server.command));
  const skipped = allServers.filter((server) => !isRunnableMcpCommand(server.command)).map((server) => server.name);
  if (!servers.length && !skipped.length) return { changed: false, servers: [], skipped, removed: [], configPaths };

  const removed = [];
  for (const configPath of configPaths) {
    const config = readJsonFile(configPath, {});
    if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server?.command && !isRunnableMcpCommand(server.command)) {
        delete config.mcpServers[name];
        removed.push(name);
      }
    }
    for (const server of servers) {
      config.mcpServers[server.name] = {
        command: server.command,
        args: server.args || []
      };
    }
    if (!dryRun) writeJsonFile(configPath, config);
  }

  return { changed: true, servers: servers.map((server) => server.name), skipped, removed: [...new Set(removed)], configPaths };
}

export function pruneClaudeProjectCtxMcp({
  cwd = process.cwd(),
  projectConfigPath = path.join(cwd, ".mcp.json"),
  userConfigPath = claudeUserConfigPath(),
  dryRun = false
} = {}) {
  const userConfig = readJsonFile(userConfigPath, {});
  const userHasCtx = Boolean(userConfig?.mcpServers?.[CTX_MCP_NAME]);
  if (!userHasCtx || !fs.existsSync(projectConfigPath)) {
    return { changed: false, removed: false, projectConfigPath };
  }

  const projectConfig = readJsonFile(projectConfigPath, {});
  if (!projectConfig?.mcpServers?.[CTX_MCP_NAME]) {
    return { changed: false, removed: false, projectConfigPath };
  }

  delete projectConfig.mcpServers[CTX_MCP_NAME];
  if (!dryRun) writeJsonFile(projectConfigPath, projectConfig);
  return { changed: true, removed: true, projectConfigPath };
}

export function buildCtxMcpToml({ mcpServerPath, agents = DEFAULT_AGENTS } = {}) {
  const blocks = [
    "# Added by backendguard sync --rules",
    "[mcp]",
    "enabled = true",
    'merge_strategy = "merge"',
    "",
    `[mcp_servers.${CTX_MCP_NAME}]`,
    'command = "node"',
    `args = [${JSON.stringify(mcpServerPath)}]`
  ];

  for (const agent of agents) {
    const outputPath = agent === "claude" ? "CLAUDE.md" : "AGENTS.md";
    blocks.push(
      "",
      `[agents.${agent}]`,
      "enabled = true",
      `output_path = "${outputPath}"`,
      "",
      `[agents.${agent}.mcp]`,
      "enabled = true",
      'merge_strategy = "merge"'
    );
  }

  return `${blocks.join("\n")}\n`;
}

export function buildMcpServerToml(server) {
  return [
    `# Imported by backendguard sync --rules from Codex MCP config`,
    `[mcp_servers.${server.name}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args || [])}`
  ].join("\n");
}

export function injectMcpServers({ tomlPath, servers = [], force = false, dryRun = false } = {}) {
  if (!servers.length) return { changed: false, added: [], skipped: [] };
  let content = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
  const added = [];
  const skipped = [];

  for (const server of servers) {
    if (!server?.name || !server?.command) continue;
    const sectionName = `mcp_servers.${server.name}`;
    const exists = hasTomlSection(content, sectionName);
    if (exists && !force) {
      skipped.push(server.name);
      continue;
    }
    if (exists && force) content = removeTomlSection(content, sectionName);
    const prefix = content.trim() ? "\n\n" : "";
    content = `${content.trimEnd()}${prefix}${buildMcpServerToml(server)}\n`;
    added.push(server.name);
  }

  if (added.length && !dryRun) {
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, content, "utf8");
  }
  return { changed: added.length > 0, added, skipped, content };
}

export function injectCtxMcp({ tomlPath, mcpServerPath, agents = DEFAULT_AGENTS, force = false, dryRun = false } = {}) {
  if (!fs.existsSync(tomlPath)) {
    if (dryRun) return { changed: true, existed: false, content: buildCtxMcpToml({ mcpServerPath, agents }) };
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, buildCtxMcpToml({ mcpServerPath, agents }), "utf8");
    return { changed: true, existed: false };
  }

  let content = fs.readFileSync(tomlPath, "utf8");
  const sectionExists = hasTomlSection(content, `mcp_servers.${CTX_MCP_NAME}`);
  if (sectionExists && !force) {
    const existingServer = readRulerMcpServer({ tomlPath, name: CTX_MCP_NAME });
    const existingPath = existingServer?.command === "node" ? existingServer.args?.[0] : existingServer?.command;
    if (existingPath && isRunnableMcpCommand(existingPath)) return { changed: false, existed: true };
    force = true;
  }

  if (force) {
    content = removeTomlSection(content, "mcp");
    content = removeTomlSection(content, `mcp_servers.${CTX_MCP_NAME}`);
    for (const agent of agents) {
      content = removeTomlSection(content, `agents.${agent}`);
      content = removeTomlSection(content, `agents.${agent}.mcp`);
    }
  }

  const next = `${content.trimEnd()}\n\n${buildCtxMcpToml({ mcpServerPath, agents })}`;
  if (!dryRun) fs.writeFileSync(tomlPath, next, "utf8");
  return { changed: true, existed: sectionExists, content: next };
}

export function runRulerApply({ agents = DEFAULT_AGENTS, cwd = process.cwd(), run = runCommand, dryRun = false } = {}) {
  run("ruler", ["apply", "--agents", normalizeAgentList(agents).join(",")], { cwd, stdio: "pipe", dryRun });
}

function fileContains(filePath, pattern) {
  try {
    return fs.readFileSync(filePath, "utf8").includes(pattern);
  } catch {
    return false;
  }
}

export function verifySync({ cwd = process.cwd(), agents = DEFAULT_AGENTS } = {}) {
  const checks = [];
  const definitions = {
    codex: [path.join(cwd, ".codex", "config.toml")],
    claude: [path.join(cwd, ".mcp.json"), path.join(cwd, ".claude", "settings.json"), path.join(os.homedir(), ".claude.json")],
    antigravity: [
      path.join(cwd, ".gemini", "settings.json"),
      path.join(cwd, ".gemini", "mcp.json"),
      ...antigravityMcpConfigPaths(),
      path.join(cwd, "AGENTS.md")
    ],
    copilot: [
      path.join(cwd, ".vscode", "mcp.json"),
      path.join(cwd, ".github", "copilot-instructions.md")
    ]
  };

  for (const agent of agents) {
    const files = definitions[agent] || [];
    const found = files.find((filePath) => fileContains(filePath, CTX_MCP_NAME));
    checks.push({ agent, ok: Boolean(found), filePath: found || files[0] || "" });
  }
  return checks;
}

function resolveStableMcpServerPath(rootDir) {
  const codexRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "marketplaces", "backendguard");
  const dataRoot = defaultDataRoot();
  const candidates = [
    path.join(codexRoot, MCP_SERVER_RELATIVE),
    path.join(dataRoot, "agents", "claude", "backendguard", MCP_SERVER_RELATIVE),
    path.join(dataRoot, "agents", "agy", "backendguard", MCP_SERVER_RELATIVE),
    path.join(dataRoot, "agents", "copilot", "backendguard", MCP_SERVER_RELATIVE),
    path.join(rootDir, MCP_SERVER_RELATIVE)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(rootDir, MCP_SERVER_RELATIVE);
}

export async function syncRules({
  cwd = process.cwd(),
  rootDir,
  args = [],
  run = runCommand,
  logger = console.log
} = {}) {
  const options = parseSyncRulesArgs(args);
  if (!options.rules) throw new Error("Usage: backendguard sync --rules [--agents codex,claude,antigravity,copilot] [--dry-run] [--force]");

  logger("");
  const ruler = checkRulerInstalled({ run });
  if (!ruler.installed) {
    logger(statusLine("Checking ruler installation...", options.dryRun ? "missing (dry-run)" : "missing"));
    if (!options.dryRun) await installRuler({ run, yes: options.yes });
  } else {
    logger(statusLine("Checking ruler installation...", ruler.version));
  }

  const init = ensureRulerInit({ cwd, run, dryRun: options.dryRun });
  logger(statusLine("Checking .ruler/ruler.toml...", init.created ? "created" : "found"));

  const mcpServerPath = resolveStableMcpServerPath(rootDir);
  const injected = injectCtxMcp({
    tomlPath: init.tomlPath,
    mcpServerPath,
    agents: options.agents,
    force: options.force,
    dryRun: options.dryRun
  });
  logger(statusLine("Injecting ctx-mcp into ruler.toml...", injected.changed ? "added" : "already configured"));

  let importedMcp = { added: [], skipped: [] };
  let importedServers = [];
  if (options.importCodexMcp) {
    importedServers = mergeMcpServers(
      readCodexMcpServers(),
      readProjectMcpJsonServers({ cwd })
    ).filter((server) => server.name !== CTX_MCP_NAME);
    importedMcp = injectMcpServers({
      tomlPath: init.tomlPath,
      servers: importedServers,
      force: options.force,
      dryRun: options.dryRun
    });
    const importedLabel = importedMcp.added.length
      ? `added ${importedMcp.added.join(", ")}`
      : importedServers.length
        ? "already configured"
        : "none found";
    logger(statusLine("Importing existing MCP servers...", importedLabel));
  }

  logger("[ctx] Running ruler apply...");
  runRulerApply({ agents: options.agents, cwd, run, dryRun: options.dryRun });

  let claudePrune = { changed: false, removed: false };
  if (options.agents.includes("claude")) {
    claudePrune = pruneClaudeProjectCtxMcp({ cwd, dryRun: options.dryRun });
    logger(statusLine("Deduping Claude ctx-mcp scope...", claudePrune.removed ? "removed project duplicate" : "no duplicate"));
  }

  let antigravityMcp = { changed: false, servers: [], configPaths: [] };
  if (options.agents.includes("antigravity")) {
    antigravityMcp = options.dryRun
      ? {
        changed: true,
        servers: [CTX_MCP_NAME, ...importedServers.map((server) => server.name)],
        configPaths: antigravityMcpConfigPaths()
      }
      : syncAntigravityMcpFromRuler({ tomlPath: init.tomlPath });
    logger(statusLine("Syncing Antigravity MCP config...", antigravityMcp.servers.length ? antigravityMcp.servers.join(", ") : "none found"));
  }

  let copilotMcp = { changed: false };
  if (options.agents.includes("copilot")) {
    // Copilot MCP is managed by integrations/copilot/copilot-mcp.js during install,
    // but we verify it's still in place during sync.
    const vscodeMcpPath = path.join(cwd, ".vscode", "mcp.json");
    if (fs.existsSync(vscodeMcpPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(vscodeMcpPath, "utf8"));
        copilotMcp.changed = Boolean(content?.mcpServers?.[CTX_MCP_NAME]);
        logger(statusLine("Verifying Copilot MCP config...", copilotMcp.changed ? "ctx-mcp found" : "not configured"));
      } catch {
        logger(statusLine("Verifying Copilot MCP config...", "parse error"));
      }
    } else {
      logger(statusLine("Verifying Copilot MCP config...", "not installed (run backendguard install --agent copilot)"));
    }
  }
  logger("[ctx] Verifying sync...");
  const checks = options.dryRun ? options.agents.map((agent) => ({ agent, ok: true, filePath: "(dry-run)" })) : verifySync({ cwd, agents: options.agents });
  for (const check of checks) {
    logger(`      → ctx-mcp in ${displayAgentName(check.agent).padEnd(12)} ${check.ok ? "found" : "not found"}${check.filePath ? ` ${check.filePath}` : ""}`);
  }

  const okCount = checks.filter((check) => check.ok).length;
  logger("");
  logger(`[ctx] ${options.dryRun ? "Dry run complete" : "Done"}. Rules ${options.dryRun ? "would sync" : "synced"} to ${okCount}/${options.agents.length} agents.`);
  logger(`      ${options.dryRun ? "No files were changed." : "Restart each agent to activate ctx-mcp."}`);

  return { options, ruler, init, injected, importedMcp, antigravityMcp, checks };
}
