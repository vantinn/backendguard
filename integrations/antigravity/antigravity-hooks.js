import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function shellQuote(value) {
  const s = String(value);
  if (process.platform === "win32") {
    return `"${s.replaceAll('"', '\\"')}"`;
  }
  return `'${s.replaceAll("'", "'\\''")}'`;
}

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

function commandFor(installRoot, scriptName, { injectPromptContext = true } = {}) {
  const envPrefix = scriptName === "on-antigravity-preinvocation.js" && !injectPromptContext ? "BACKENDGUARD_INJECT=0 " : "";
  return `${envPrefix}node ${shellQuote(path.join(installRoot, "plugins", "backendguard", "bin", scriptName))}`;
}

export function antigravityHooksPath() {
  return process.env.ANTIGRAVITY_HOOKS_PATH
    || path.join(os.homedir(), ".gemini", "config", "hooks.json");
}

export function buildAntigravityHooksConfig(existingConfig, { installRoot, injectPromptContext = true } = {}) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  config.backendguard = {
    enabled: true,
    PreInvocation: [
      {
        type: "command",
        command: commandFor(installRoot, "on-antigravity-preinvocation.js", { injectPromptContext }),
        timeout: 10
      }
    ],
    Stop: [
      {
        type: "command",
        command: commandFor(installRoot, "on-antigravity-stop.js"),
        timeout: 10
      }
    ]
  };
  return config;
}

export function installAntigravityHooks({ hooksPath = antigravityHooksPath(), installRoot, injectPromptContext = true } = {}) {
  const existing = readJsonFile(hooksPath, {});
  const next = buildAntigravityHooksConfig(existing, { installRoot, injectPromptContext });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return hooksPath;
}
