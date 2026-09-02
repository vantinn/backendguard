import fs from "node:fs";
import path from "node:path";

const BACKENDGUARD_COMMAND_MARKER = "/backendguard/plugins/ctx/bin/on-";
const QUIET_CODE_REVIEW_GRAPH_STATUS_COMMAND =
  "git rev-parse --git-dir >/dev/null 2>&1 && code-review-graph status >/dev/null 2>&1 || true";
const DRAINED_CODE_REVIEW_GRAPH_UPDATE_COMMAND =
  "cat >/dev/null; git rev-parse --git-dir >/dev/null 2>&1 && code-review-graph update --skip-flows || true";

function shellQuote(value) {
  const s = String(value);
  if (process.platform === "win32") {
    return `"${s.replaceAll('"', '\\"')}"`;
  }
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function readHooksFile(hooksPath) {
  if (!fs.existsSync(hooksPath)) return { hooks: {} };
  const raw = fs.readFileSync(hooksPath, "utf8").trim();
  if (!raw) return { hooks: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.hooks || typeof parsed.hooks !== "object") parsed.hooks = {};
    return parsed;
  } catch {
    console.warn(`[ctx] warning: corrupt JSON in ${hooksPath}, overwriting with defaults`);
    return { hooks: {} };
  }
}

function isBackendGuardHookEntry(entry) {
  return (entry.hooks || []).some((hook) => {
    return typeof hook.command === "string" && hook.command.includes(BACKENDGUARD_COMMAND_MARKER);
  });
}

function withoutBackendGuardEntries(entries = []) {
  return entries.filter((entry) => !isBackendGuardHookEntry(entry));
}

function quietCodeReviewGraphSessionStart(entries = []) {
  return entries.map((entry) => ({
    ...entry,
    hooks: (entry.hooks || []).map((hook) => {
      if (typeof hook.command === "string" && hook.command.includes("code-review-graph status")) {
        return {
          ...hook,
          command: QUIET_CODE_REVIEW_GRAPH_STATUS_COMMAND
        };
      }
      return hook;
    })
  }));
}

function drainCodeReviewGraphPostToolUse(entries = []) {
  return entries.map((entry) => ({
    ...entry,
    hooks: (entry.hooks || []).map((hook) => {
      if (typeof hook.command === "string" && hook.command.includes("code-review-graph update --skip-flows")) {
        return {
          ...hook,
          command: hook.command.includes("cat >/dev/null")
            ? hook.command
            : DRAINED_CODE_REVIEW_GRAPH_UPDATE_COMMAND
        };
      }
      return hook;
    })
  }));
}

function commandFor(marketplaceRoot, scriptName, { injectPromptContext = true } = {}) {
  const envPrefix = scriptName === "on-prompt.js" && !injectPromptContext ? "BACKENDGUARD_INJECT=0 " : "";
  return `${envPrefix}node ${shellQuote(path.join(marketplaceRoot, "plugins", "ctx", "bin", scriptName))}`;
}

function contextOSEntry({ marketplaceRoot, scriptName, matcher, timeout, statusMessage, injectPromptContext = true }) {
  const entry = {
    hooks: [
      {
        type: "command",
        command: commandFor(marketplaceRoot, scriptName, { injectPromptContext }),
        timeout,
        statusMessage
      }
    ]
  };

  if (matcher) entry.matcher = matcher;
  return entry;
}

export function buildGlobalHooksConfig(existingConfig, { marketplaceRoot, injectPromptContext = true }) {
  const config = existingConfig && typeof existingConfig === "object" ? structuredClone(existingConfig) : {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};

  const additions = {
    SessionStart: contextOSEntry({
      marketplaceRoot,
      scriptName: "on-session-start.js",
      matcher: "startup|resume",
      timeout: 10,
      statusMessage: "BackendGuard session start"
    }),
    UserPromptSubmit: contextOSEntry({
      marketplaceRoot,
      scriptName: "on-prompt.js",
      timeout: 10,
      statusMessage: "BackendGuard scheduling context",
      injectPromptContext
    }),
    Stop: contextOSEntry({
      marketplaceRoot,
      scriptName: "on-stop.js",
      timeout: 10,
      statusMessage: "BackendGuard reporting"
    })
  };

  for (const [eventName, entry] of Object.entries(additions)) {
    config.hooks[eventName] = [...withoutBackendGuardEntries(config.hooks[eventName]), entry];
  }

  config.hooks.SessionStart = quietCodeReviewGraphSessionStart(config.hooks.SessionStart);
  config.hooks.PostToolUse = drainCodeReviewGraphPostToolUse(config.hooks.PostToolUse);

  return config;
}

export function installGlobalHooks({ codexHome, marketplaceRoot, injectPromptContext = true }) {
  const hooksPath = path.join(codexHome, "hooks.json");
  const existing = readHooksFile(hooksPath);
  const next = buildGlobalHooksConfig(existing, { marketplaceRoot, injectPromptContext });
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return hooksPath;
}
