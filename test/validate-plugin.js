#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const pluginRoot = path.resolve("plugins", "ctx");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = readJson(manifestPath);
const packageJson = readJson(path.resolve("package.json"));

assert.equal(manifest.name, "ctx", "plugin name must be ctx");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "version must be semver-like");
assert.equal(manifest.version, packageJson.version, "plugin version must match package version");
assert.equal(manifest.mcpServers, ".mcp.json", "plugin must reference .mcp.json");
assert.ok(manifest.interface?.displayName, "interface.displayName is required");
assert.ok(Array.isArray(manifest.interface?.capabilities), "interface.capabilities must be an array");

const mcpPath = path.join(pluginRoot, manifest.mcpServers);
const mcp = readJson(mcpPath);
const ctxMcp = mcp.mcpServers?.["ctx-mcp"];
assert.ok(ctxMcp, "mcpServers.ctx-mcp is required");
assert.equal(ctxMcp.command, "node", "ctx-mcp command must be node");
assert.deepEqual(ctxMcp.args, ["./mcp/server.js"], "ctx-mcp args must point at ./mcp/server.js");
assert.ok(fs.existsSync(path.join(pluginRoot, "mcp", "server.js")), "mcp/server.js must exist");

const hooks = readJson(path.join(pluginRoot, "hooks.json"));
assert.ok(hooks.hooks?.UserPromptSubmit?.length, "UserPromptSubmit hook is required");
assert.ok(hooks.hooks?.Stop?.length, "Stop hook is required");
assertHookCommand(hooks, "UserPromptSubmit", "bin/on-prompt.js");
assertHookCommand(hooks, "Stop", "bin/on-stop.js");

console.log(`Plugin validation passed: ${pluginRoot}`);

function assertHookCommand(hooks, event, expectedScript) {
  const command = hooks.hooks[event]?.[0]?.hooks?.[0]?.command || "";
  assert.ok(command.includes(expectedScript), `${event} must run ${expectedScript}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
