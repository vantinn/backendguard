#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "backendguard");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = readJson(manifestPath);
const packageJson = readJson(path.join(repoRoot, "package.json"));

assert.equal(manifest.name, "backendguard", "plugin name must be backendguard");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "version must be semver-like");
assert.equal(manifest.version, packageJson.version, "plugin version must match package version");
assert.equal(manifest.mcpServers, ".mcp.json", "plugin must reference .mcp.json");
assert.ok(manifest.interface?.displayName, "interface.displayName is required");
assert.ok(Array.isArray(manifest.interface?.capabilities), "interface.capabilities must be an array");

const mcp = readJson(path.join(pluginRoot, manifest.mcpServers));
const server = mcp.mcpServers?.["backendguard-mcp"];
assert.ok(server, "mcpServers.backendguard-mcp is required");
assert.equal(server.command, "node", "backendguard-mcp command must be node");
assert.deepEqual(server.args, ["./mcp/server.js"], "backendguard-mcp args must point at ./mcp/server.js");
assert.ok(fs.existsSync(path.join(pluginRoot, "mcp", "server.js")), "mcp/server.js must exist");

const hooks = readJson(path.join(pluginRoot, "hooks.json"));
assert.ok(hooks.hooks?.UserPromptSubmit?.length, "UserPromptSubmit hook is required");
assert.ok(hooks.hooks?.Stop?.length, "Stop hook is required");
assertHookCommand(hooks, "UserPromptSubmit", "bin/on-prompt.js");
assertHookCommand(hooks, "Stop", "bin/on-stop.js");

// The marketplace manifest is what `codex plugin marketplace add` reads; a stale
// `source.path` here silently installs nothing, so it is validated too.
const marketplace = readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"));
const entry = (marketplace.plugins || []).find((plugin) => plugin.name === manifest.name);
assert.ok(entry, `marketplace.json must list a plugin named ${manifest.name}`);
assert.ok(
  fs.existsSync(path.join(repoRoot, entry.source.path)),
  `marketplace source.path ${entry.source.path} must exist`
);

// Every file the plugin declares must actually ship: `package.json#files` decides
// what npm publishes, and a hook path outside it produces a broken install.
const shipped = new Set(packageJson.files.map((entry) => entry.replace(/\/$/, "")));
for (const relative of ["plugins", "cli", "integrations"]) {
  assert.ok(shipped.has(relative), `package.json#files must include ${relative}/`);
}

console.log(`Plugin validation passed: ${path.relative(repoRoot, pluginRoot)}`);

function assertHookCommand(hooks, event, expectedScript) {
  const command = hooks.hooks[event]?.[0]?.hooks?.[0]?.command || "";
  assert.ok(command.includes(expectedScript), `${event} must run ${expectedScript}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
