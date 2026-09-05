import fs from "node:fs";
import path from "node:path";

import { assertMergeableConfig, readJsonConfig, writeJsonConfig } from "../../runtime/fs-utils.js";

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

export function buildCopilotMcpConfig(existingConfig, { installRoot, configPath } = {}) {
  // `typeof [] === "object"`, so an array used to pass this check — and a
  // property added to an array is dropped by JSON.stringify, producing an
  // install that reported success and registered no MCP server.
  const config = structuredClone(assertMergeableConfig(existingConfig, { path: configPath }));
  config.mcpServers = assertMergeableConfig(config.mcpServers, { path: configPath, key: "mcpServers" });
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
  const next = buildCopilotMcpConfig(existing, { installRoot, configPath: mcpPath });
  writeJsonConfig(mcpPath, next);
  return mcpPath;
}
