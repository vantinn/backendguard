import fs from "node:fs";
import path from "node:path";

import { assertMergeableConfig, readJsonConfig, writeJsonConfig } from "../../runtime/fs-utils.js";

// Entries this installer previously wrote are recognised so a re-install
// replaces them instead of appending a duplicate. The pre-0.9.0 path
// (which lived under a differently named plugin directory) is matched too, so
// upgrading cleans up the old entry rather than leaving a second, now-broken
// hook behind.
const LEGACY_PLUGIN_DIR_NAME = "ctx";
const BACKENDGUARD_COMMAND_MARKERS = [
  "/backendguard/plugins/backendguard/bin/on-",
  `/backendguard/plugins/${LEGACY_PLUGIN_DIR_NAME}/bin/on-`
];
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
  // A hooks file that does not parse is left alone rather than replaced with
  // defaults: it is the user's, and it may hold hooks BackendGuard did not add.
  const parsed = readJsonConfig(hooksPath, { hooks: {} });
  parsed.hooks = assertMergeableConfig(parsed.hooks, { path: hooksPath, key: "hooks" });
  return parsed;
}

function isBackendGuardHookEntry(entry) {
  return (entry.hooks || []).some((hook) => {
    return typeof hook.command === "string"
      && BACKENDGUARD_COMMAND_MARKERS.some((marker) => hook.command.includes(marker));
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
  return `${envPrefix}node ${shellQuote(path.join(marketplaceRoot, "plugins", "backendguard", "bin", scriptName))}`;
}

function codexHookEntry({ marketplaceRoot, scriptName, matcher, timeout, statusMessage, injectPromptContext = true }) {
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

export function buildGlobalHooksConfig(existingConfig, { marketplaceRoot, injectPromptContext = true, configPath } = {}) {
  // An array passes `typeof === "object"`; properties added to it are dropped
  // by JSON.stringify, which would write a settings file with no hooks in it.
  const config = structuredClone(assertMergeableConfig(existingConfig, { path: configPath }));
  config.hooks = assertMergeableConfig(config.hooks, { path: configPath, key: "hooks" });

  const additions = {
    SessionStart: codexHookEntry({
      marketplaceRoot,
      scriptName: "on-session-start.js",
      matcher: "startup|resume",
      timeout: 10,
      statusMessage: "BackendGuard session start"
    }),
    UserPromptSubmit: codexHookEntry({
      marketplaceRoot,
      scriptName: "on-prompt.js",
      timeout: 10,
      statusMessage: "BackendGuard scheduling context",
      injectPromptContext
    }),
    Stop: codexHookEntry({
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
  const next = buildGlobalHooksConfig(existing, { marketplaceRoot, injectPromptContext, configPath: hooksPath });
  writeJsonConfig(hooksPath, next);
  return hooksPath;
}
