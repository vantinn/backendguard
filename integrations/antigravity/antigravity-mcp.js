import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonConfig } from "../../runtime/fs-utils.js";

/**
 * Delegates to the shared reader, which refuses to overwrite a config it
 * cannot parse rather than replacing the user's file with defaults.
 */
function readJsonFile(filePath, fallback) {
  return readJsonConfig(filePath, fallback);
}

export function antigravityMcpConfigPaths() {
  if (process.env.ANTIGRAVITY_MCP_CONFIG_PATH) {
    return [process.env.ANTIGRAVITY_MCP_CONFIG_PATH];
  }
  const home = os.homedir();
  return [
    path.join(home, ".gemini", "antigravity", "mcp_config.json"),
    path.join(home, ".gemini", "antigravity-cli", "mcp_config.json"),
    path.join(home, ".gemini", "config", "mcp_config.json")
  ];
}

export function buildAntigravityMcpConfig(existingConfig, { installRoot } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers["backendguard-mcp"] = {
    command: "node",
    args: [path.join(installRoot, "integrations", "mcp", "server.js")]
  };
  return config;
}

export function installAntigravityMcp({ configPaths = antigravityMcpConfigPaths(), installRoot } = {}) {
  const written = [];
  for (const configPath of configPaths) {
    const existing = readJsonFile(configPath, {});
    const next = buildAntigravityMcpConfig(existing, { installRoot });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    written.push(configPath);
  }
  return written;
}
