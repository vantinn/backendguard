import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

export function claudeConfigPath() {
  return process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude.json");
}

export function buildClaudeMcpConfig(existingConfig, { installRoot } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers["ctx-mcp"] = {
    type: "stdio",
    command: "node",
    args: [path.join(installRoot, "plugins", "ctx", "mcp", "server.js")],
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
