import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonConfig } from "../../runtime/fs-utils.js";

import { buildGlobalHooksConfig } from "../codex/codex-hooks.js";

/**
 * Delegates to the shared reader, which refuses to overwrite a config it
 * cannot parse rather than replacing the user's file with defaults.
 */
function readJsonFile(filePath, fallback) {
  return readJsonConfig(filePath, fallback);
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
