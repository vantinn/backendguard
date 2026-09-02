import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCtxMcpToml,
  injectCtxMcp,
  injectMcpServers,
  parseSyncRulesArgs,
  pruneClaudeProjectCtxMcp,
  readCodexMcpServers,
  readProjectMcpJsonServers,
  syncAntigravityMcpFromRuler,
  syncRules,
  verifySync
} from "../plugins/ctx/lib/ruler-sync.js";

describe("ruler sync", () => {
  it("parses sync --rules flags", () => {
    expect(parseSyncRulesArgs(["--rules"])).toMatchObject({
      rules: true,
      agents: ["codex", "claude", "antigravity", "copilot"],
      dryRun: false,
      force: false
    });
    expect(parseSyncRulesArgs(["--rules", "--agents", "codex,claude", "--dry-run", "--force"]).agents).toEqual(["codex", "claude"]);
    expect(parseSyncRulesArgs(["--rules", "--agents", "codex,claude,agy"]).agents).toEqual(["codex", "claude", "antigravity"]);
  });

  it("builds ctx-mcp Ruler TOML for selected agents", () => {
    const toml = buildCtxMcpToml({
      mcpServerPath: "/tmp/backendguard/plugins/ctx/mcp/server.js",
      agents: ["codex", "claude"]
    });

    expect(toml).toContain("[mcp_servers.ctx-mcp]");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/tmp/backendguard/plugins/ctx/mcp/server.js"]');
    expect(toml).toContain("[agents.codex]");
    expect(toml).toContain('output_path = "AGENTS.md"');
    expect(toml).toContain("[agents.claude]");
    expect(toml).toContain('output_path = "CLAUDE.md"');
  });

  it("injects ctx-mcp idempotently without removing user entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-"));
    const tomlPath = path.join(tmp, ".ruler", "ruler.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, [
      "[mcp_servers.github]",
      'command = "npx"',
      'args = ["-y", "github-mcp"]',
      ""
    ].join("\n"));
    const stableServerPath = path.join(process.cwd(), "plugins", "ctx", "mcp", "server.js");

    const first = injectCtxMcp({
      tomlPath,
      mcpServerPath: stableServerPath,
      agents: ["codex"]
    });
    const second = injectCtxMcp({
      tomlPath,
      mcpServerPath: stableServerPath,
      agents: ["codex"]
    });
    const content = fs.readFileSync(tomlPath, "utf8");

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(content).toContain("[mcp_servers.github]");
    expect(content.match(/\[mcp_servers\.ctx-mcp\]/g)).toHaveLength(1);
  });

  it("force reinjects ctx-mcp with a new server path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-force-"));
    const tomlPath = path.join(tmp, ".ruler", "ruler.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, buildCtxMcpToml({
      mcpServerPath: "/old/server.js",
      agents: ["codex"]
    }));

    injectCtxMcp({
      tomlPath,
      mcpServerPath: "/new/server.js",
      agents: ["codex"],
      force: true
    });

    const content = fs.readFileSync(tomlPath, "utf8");
    expect(content).not.toContain("/old/server.js");
    expect(content).toContain("/new/server.js");
    expect(content.match(/\[mcp_servers\.ctx-mcp\]/g)).toHaveLength(1);
  });

  it("refreshes ctx-mcp when ruler.toml points at a temporary path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-stale-"));
    const tomlPath = path.join(tmp, ".ruler", "ruler.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, [
      "[mcp_servers.ctx-mcp]",
      'command = "node"',
      'args = ["/tmp/backendguard/plugins/ctx/mcp/server.js"]',
      ""
    ].join("\n"));

    const result = injectCtxMcp({
      tomlPath,
      mcpServerPath: "/stable/backendguard/plugins/ctx/mcp/server.js",
      agents: ["antigravity"]
    });
    const content = fs.readFileSync(tomlPath, "utf8");

    expect(result.changed).toBe(true);
    expect(content).toContain("/stable/backendguard/plugins/ctx/mcp/server.js");
    expect(content).not.toContain("/tmp/backendguard/plugins/ctx/mcp/server.js");
  });

  it("reads Codex MCP servers and unwraps BackendGuard telemetry proxy commands", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-codex-mcp-"));
    const configPath = path.join(tmp, "config.toml");
    fs.writeFileSync(configPath, [
      "[mcp_servers.code-review-graph]",
      'command = "node"',
      'args = ["/home/me/.ctx/backendguard/plugins/ctx/mcp/proxy.js", "--name", "code-review-graph", "--", "npx", "-y", "code-review-graph"]',
      "",
      "[mcp_servers.agentmemory]",
      'command = "npx"',
      'args = ["-y", "@agentmemory/mcp"]',
      ""
    ].join("\n"));

    expect(readCodexMcpServers({ configPath })).toEqual([
      { name: "code-review-graph", command: "npx", args: ["-y", "code-review-graph"] },
      { name: "agentmemory", command: "npx", args: ["-y", "@agentmemory/mcp"] }
    ]);
  });

  it("unwraps multiline BackendGuard telemetry proxy args from Codex config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-codex-mcp-multiline-"));
    const configPath = path.join(tmp, "config.toml");
    fs.writeFileSync(configPath, `[mcp_servers.code-review-graph]
command = "node"
args = [
  "/home/me/.ctx/backendguard/plugins/ctx/mcp/proxy.js",
  "--name",
  "code-review-graph",
  "--",
  "npx",
  "-y",
  "code-review-graph",
]
`);

    expect(readCodexMcpServers({ configPath })).toEqual([
      { name: "code-review-graph", command: "npx", args: ["-y", "code-review-graph"] }
    ]);
  });

  it("imports Codex MCP servers into ruler.toml without duplicating existing entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-import-mcp-"));
    const tomlPath = path.join(tmp, ".ruler", "ruler.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, [
      "[mcp_servers.agentmemory]",
      'command = "npx"',
      'args = ["-y", "@agentmemory/mcp"]',
      ""
    ].join("\n"));

    const result = injectMcpServers({
      tomlPath,
      servers: [
        { name: "agentmemory", command: "npx", args: ["-y", "@agentmemory/mcp"] },
        { name: "code-review-graph", command: "npx", args: ["-y", "code-review-graph"] }
      ]
    });
    const content = fs.readFileSync(tomlPath, "utf8");

    expect(result.added).toEqual(["code-review-graph"]);
    expect(result.skipped).toEqual(["agentmemory"]);
    expect(content.match(/\[mcp_servers\.agentmemory\]/g)).toHaveLength(1);
    expect(content).toContain("[mcp_servers.code-review-graph]");
  });

  it("reads project .mcp.json servers and skips missing or temporary absolute commands", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-project-mcp-json-"));
    const rtkPath = path.join(tmp, "bin", "mcp-rtk");
    fs.mkdirSync(path.dirname(rtkPath), { recursive: true });
    fs.writeFileSync(rtkPath, "#!/bin/sh\n");
    fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "mcp-rtk": {
          command: rtkPath,
          args: ["--", "code-review-graph", "serve"],
          type: "stdio"
        },
        "missing-rtk": {
          command: "/home/user/.cargo/bin/mcp-rtk",
          args: ["--", "code-review-graph", "serve"]
        },
        "path-binary": {
          command: "mcp-rtk",
          args: ["--", "code-review-graph", "serve"]
        },
        "ctx-mcp": {
          command: "node",
          args: ["/tmp/backendguard/plugins/ctx/mcp/server.js"]
        }
      }
    }));

    expect(readProjectMcpJsonServers({ cwd: tmp })).toEqual([
      {
        name: "path-binary",
        command: "mcp-rtk",
        args: ["--", "code-review-graph", "serve"]
      },
      {
        name: "ctx-mcp",
        command: "node",
        args: ["/tmp/backendguard/plugins/ctx/mcp/server.js"]
      }
    ]);
  });

  it("imports project .mcp.json servers during full sync", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-sync-project-mcp-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmp;
    const rtkPath = path.join(tmp, "bin", "mcp-rtk");
    fs.mkdirSync(path.dirname(rtkPath), { recursive: true });
    fs.writeFileSync(rtkPath, "#!/bin/sh\n");
    fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "mcp-rtk": {
          command: rtkPath,
          args: ["--", "code-review-graph", "serve"]
        },
        "missing-rtk": {
          command: "/home/user/.cargo/bin/mcp-rtk",
          args: ["--", "code-review-graph", "serve"]
        }
      }
    }));
    const run = (command, args) => {
      if (command === "ruler" && args[0] === "--version") return { stdout: "ruler 0.3.0\n" };
      if (command === "ruler" && args[0] === "init") {
        fs.mkdirSync(path.join(tmp, ".ruler"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".ruler", "ruler.toml"), "");
      }
      return { stdout: "" };
    };

    try {
      await syncRules({
        cwd: tmp,
        rootDir: "/tmp/backendguard",
        args: ["--rules", "--agents", "antigravity"],
        run,
        logger: () => {}
      });
    } finally {
      process.env.HOME = originalHome;
    }

    const content = fs.readFileSync(path.join(tmp, ".ruler", "ruler.toml"), "utf8");
    expect(content).not.toContain("[mcp_servers.mcp-rtk]");
    expect(content).not.toContain(rtkPath);
    expect(content).not.toContain("[mcp_servers.missing-rtk]");
    expect(content).not.toContain("/home/user/.cargo/bin/mcp-rtk");
  });

  it("verifies generated configs per project path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-verify-"));
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "[mcp_servers.ctx-mcp]\n");

    const checks = verifySync({ cwd: tmp, agents: ["codex"] });
    expect(checks).toEqual([{ agent: "codex", ok: true, filePath: path.join(tmp, ".codex", "config.toml") }]);
  });

  it("syncs all Ruler MCP servers into Antigravity app and CLI config files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-agy-mcp-"));
    const tomlPath = path.join(tmp, ".ruler", "ruler.toml");
    const appPath = path.join(tmp, "antigravity", "mcp_config.json");
    const cliPath = path.join(tmp, "antigravity-cli", "mcp_config.json");
    const legacyEditorPath = path.join(tmp, "config", "mcp_config.json");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.writeFileSync(appPath, JSON.stringify({
      mcpServers: {
        "mcp-rtk": {
          command: "/home/user/.cargo/bin/mcp-rtk",
          args: ["--", "code-review-graph", "serve"]
        }
      }
    }));
    fs.writeFileSync(tomlPath, [
      "[mcp_servers.ctx-mcp]",
      'command = "node"',
      'args = ["/tmp/backendguard/plugins/ctx/mcp/server.js"]',
      "",
      "[mcp_servers.missing-rtk]",
      'command = "/home/user/.cargo/bin/mcp-rtk"',
      'args = ["--", "code-review-graph", "serve"]',
      "",
      "[mcp_servers.agentmemory]",
      'command = "npx"',
      'args = ["-y", "@agentmemory/mcp"]',
      ""
    ].join("\n"));

    const result = syncAntigravityMcpFromRuler({
      tomlPath,
      configPaths: [appPath, cliPath, legacyEditorPath]
    });

    expect(result.servers).toEqual(["ctx-mcp", "agentmemory"]);
    expect(result.skipped).toEqual(["missing-rtk"]);
    expect(result.removed).toEqual(["mcp-rtk"]);
    for (const filePath of [appPath, cliPath, legacyEditorPath]) {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(config.mcpServers["ctx-mcp"].command).toBe("node");
      expect(config.mcpServers.agentmemory.args).toEqual(["-y", "@agentmemory/mcp"]);
      expect(config.mcpServers["missing-rtk"]).toBeUndefined();
      expect(config.mcpServers["mcp-rtk"]).toBeUndefined();
    }
  });

  it("removes project ctx-mcp for Claude when user-scope ctx-mcp already exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-claude-prune-"));
    const userConfigPath = path.join(tmp, ".claude.json");
    const projectConfigPath = path.join(tmp, "repo", ".mcp.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(userConfigPath, JSON.stringify({
      mcpServers: {
        "ctx-mcp": {
          command: "node",
          args: ["/stable/backendguard/plugins/ctx/mcp/server.js"]
        }
      }
    }));
    fs.writeFileSync(projectConfigPath, JSON.stringify({
      mcpServers: {
        "ctx-mcp": {
          command: "node",
          args: ["/project/backendguard/plugins/ctx/mcp/server.js"]
        },
        agentmemory: {
          command: "npx",
          args: ["-y", "@agentmemory/mcp"]
        }
      }
    }));

    const result = pruneClaudeProjectCtxMcp({
      projectConfigPath,
      userConfigPath
    });
    const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));

    expect(result.removed).toBe(true);
    expect(projectConfig.mcpServers["ctx-mcp"]).toBeUndefined();
    expect(projectConfig.mcpServers.agentmemory.command).toBe("npx");
  });

  it("runs full sync with mocked Ruler commands", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-ruler-sync-"));
    const calls = [];
    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "ruler" && args[0] === "--version") return { stdout: "ruler 0.3.0\n" };
      if (command === "ruler" && args[0] === "init") {
        fs.mkdirSync(path.join(tmp, ".ruler"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".ruler", "ruler.toml"), "");
        return { stdout: "" };
      }
      if (command === "ruler" && args[0] === "apply") {
        fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "[mcp_servers.ctx-mcp]\n");
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    const result = await syncRules({
      cwd: tmp,
      rootDir: "/tmp/backendguard",
      args: ["--rules", "--agents", "codex"],
      run,
      logger: () => {}
    });

    expect(result.checks[0].ok).toBe(true);
    expect(calls).toContainEqual(["ruler", ["init"]]);
    expect(calls).toContainEqual(["ruler", ["apply", "--agents", "codex"]]);
    expect(fs.readFileSync(path.join(tmp, ".ruler", "ruler.toml"), "utf8")).toContain("[mcp_servers.ctx-mcp]");
  });
});
