import fs from "node:fs";
import path from "node:path";

import { readJsonConfig } from "../../runtime/fs-utils.js";

/**
 * Copilot MCP configuration lives at .vscode/mcp.json (workspace-level).
 * This is the standard location for VS Code / GitHub Copilot agent mode.
 */

/**
 * Delegates to the shared reader, which refuses to overwrite a config it
 * cannot parse rather than replacing the user's file with defaults.
 */
function readJsonFile(filePath, fallback) {
  return readJsonConfig(filePath, fallback);
}

export function copilotMcpConfigPath(cwd = process.cwd()) {
  return path.join(cwd, ".vscode", "mcp.json");
}

export function buildCopilotMcpConfig(existingConfig, { installRoot } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers["backendguard-mcp"] = {
    type: "stdio",
    command: "node",
    args: [path.join(installRoot, "integrations", "mcp", "server.js")]
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
