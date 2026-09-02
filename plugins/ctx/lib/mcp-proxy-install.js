import fs from "node:fs";
import path from "node:path";

import { readMcpServersFromToml, updateMcpServerFields } from "./toml-config.js";

const DEFAULT_EXCLUDES = new Set(["ctx-mcp"]);

export function installMcpTelemetryProxies({ codexHome, marketplaceRoot, targets = null, excludes = DEFAULT_EXCLUDES } = {}) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return { wrapped: [], skipped: [], configPath };

  const original = fs.readFileSync(configPath, "utf8");
  const proxyPath = path.join(marketplaceRoot, "plugins", "ctx", "mcp", "proxy.js");
  const result = rewriteMcpTelemetryProxies(original, { proxyPath, targets, excludes });
  if (result.content !== original) {
    fs.writeFileSync(configPath, result.content, "utf8");
  }
  return { ...result, configPath };
}

export function rewriteMcpTelemetryProxies(toml, { proxyPath, targets = null, excludes = DEFAULT_EXCLUDES } = {}) {
  let content = String(toml || "");
  const servers = readMcpServersFromToml(content);
  const wrapped = [];
  const skipped = [];

  for (const server of servers) {
    const { name, command, args } = server;
    const shouldProxy = shouldProxyServer(name, { targets, excludes });

    if (command === "node" && args[0] === proxyPath && !shouldProxy) {
      const original = unwrapProxyArgs(args);
      if (original) {
        content = updateMcpServerFields(content, name, original);
        skipped.push({ name, reason: "unwrapped-non-target" });
        continue;
      }
    }

    if (!shouldProxy) {
      skipped.push({ name, reason: "not-targeted" });
      continue;
    }

    if (!command) {
      skipped.push({ name, reason: "missing-command" });
      continue;
    }
    if (command === "node" && args[0] === proxyPath) {
      skipped.push({ name, reason: "already-wrapped" });
      continue;
    }

    content = updateMcpServerFields(content, name, {
      command: "node",
      args: [proxyPath, "--name", name, "--", command, ...args]
    });
    wrapped.push({ name, command, args });
  }

  return { content, wrapped, skipped };
}

function shouldProxyServer(name, { targets, excludes }) {
  if (targets instanceof Set) return targets.has(name);
  if (Array.isArray(targets)) return targets.includes(name);
  return !(excludes || DEFAULT_EXCLUDES).has(name);
}

function unwrapProxyArgs(args) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator >= args.length - 1) return null;
  return {
    command: args[separator + 1],
    args: args.slice(separator + 2)
  };
}
