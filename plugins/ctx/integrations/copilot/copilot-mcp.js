import fs from "node:fs";
import path from "node:path";

/**
 * Copilot MCP configuration lives at .vscode/mcp.json (workspace-level).
 * This is the standard location for VS Code / GitHub Copilot agent mode.
 */

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[ctx] warning: corrupt JSON in ${filePath}, overwriting with defaults`);
    return fallback;
  }
}

export function copilotMcpConfigPath(cwd = process.cwd()) {
  return path.join(cwd, ".vscode", "mcp.json");
}

export function buildCopilotMcpConfig(existingConfig, { installRoot } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers["ctx-mcp"] = {
    type: "stdio",
    command: "node",
    args: [path.join(installRoot, "plugins", "ctx", "mcp", "server.js")]
  };
  return config;
}

export function installCopilotMcp({ cwd = process.cwd(), configPath, installRoot } = {}) {
  const mcpPath = configPath || copilotMcpConfigPath(cwd);
  const existing = readJsonFile(mcpPath, {});
  const next = buildCopilotMcpConfig(existing, { installRoot });
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return mcpPath;
}
