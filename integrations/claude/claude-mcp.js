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

export function claudeConfigPath() {
  return process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude.json");
}

export function buildClaudeMcpConfig(existingConfig, { installRoot } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers["backendguard-mcp"] = {
    type: "stdio",
    command: "node",
    args: [path.join(installRoot, "integrations", "mcp", "server.js")],
    env: {}
  };
  return config;
}

export function installClaudeMcp({ configPath = claudeConfigPath(), installRoot } = {}) {
  const existing = readJsonFile(configPath, {});
  const next = buildClaudeMcpConfig(existing, { installRoot });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}
