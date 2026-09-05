import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertMergeableConfig, readJsonConfig, writeJsonConfig } from "../../runtime/fs-utils.js";

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

export function buildClaudeMcpConfig(existingConfig, { installRoot, configPath } = {}) {
  // `typeof [] === "object"`, so an array used to pass this check — and a
  // property added to an array is dropped by JSON.stringify, producing an
  // install that reported success and registered no MCP server.
  const config = structuredClone(assertMergeableConfig(existingConfig, { path: configPath }));
  config.mcpServers = assertMergeableConfig(config.mcpServers, { path: configPath, key: "mcpServers" });
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
  const next = buildClaudeMcpConfig(existing, { installRoot, configPath });
  writeJsonConfig(configPath, next);
  return configPath;
}
