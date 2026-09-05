import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGlobalHooksConfig } from "../codex/codex-hooks.js";

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[backendguard] warning: corrupt JSON in ${filePath}, overwriting with defaults`);
    return fallback;
  }
}

export function claudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

export function installClaudeHooks({ claudeHome: home = claudeHome(), installRoot, injectPromptContext = true } = {}) {
  const settingsPath = path.join(home, "settings.json");
  const existing = readJsonFile(settingsPath, {});
  const next = buildGlobalHooksConfig(existing, {
    marketplaceRoot: installRoot,
    injectPromptContext
  });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return settingsPath;
}
