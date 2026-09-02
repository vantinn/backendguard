import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { callCtxHealth, callCtxScoreContext, ctxMcpSocketPath, ensureCtxMcpDaemon, invalidateCtxMcpSocket } from "../plugins/ctx/lib/ctx-mcp-client.js";

describe("ctx mcp client", () => {
  it("fails stale socket connects within the connect timeout", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-connect-timeout-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");
    const client = fakeClient();
    const started = Date.now();

    await expect(callCtxScoreContext({}, {
      dataDir,
      connectTimeoutMs: 20,
      timeoutMs: 1000,
      createConnection: () => client
    })).rejects.toThrow("ctx-mcp bridge connect timed out after 20ms");

    expect(Date.now() - started).toBeLessThan(200);
    expect(client.destroyed).toBe(true);
    expect(fs.existsSync(ctxMcpSocketPath(dataDir))).toBe(false);
  });

  it("keeps a separate response timeout after connecting", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-response-timeout-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");
    const client = fakeClient();
    const pending = callCtxScoreContext({ prompt: "test" }, {
      dataDir,
      connectTimeoutMs: 20,
      timeoutMs: 40,
      createConnection: () => client
    });
    client.emit("connect");

    await expect(pending).rejects.toThrow("ctx-mcp bridge timed out after 40ms");
    expect(client.writes).toEqual(['{"prompt":"test"}\n']);
    expect(fs.existsSync(ctxMcpSocketPath(dataDir))).toBe(false);
  });

  it("rejects responses from stale bridge revisions", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-revision-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");
    const client = fakeClient();
    const pending = callCtxScoreContext({ prompt: "test" }, {
      dataDir,
      createConnection: () => client
    });
    client.emit("connect");
    client.emit("data", Buffer.from('{"suggestedSkills":[]}'));
    client.emit("end");

    await expect(pending).rejects.toThrow("ctx-mcp bridge revision mismatch");
    expect(fs.existsSync(ctxMcpSocketPath(dataDir))).toBe(false);
  });

  it("reads bridge health before scoring", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-health-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");
    const client = fakeClient();
    const pending = callCtxHealth({
      dataDir,
      createConnection: () => client
    });
    client.emit("connect");
    client.emit("data", Buffer.from(JSON.stringify({
      bridgeRevision: 2,
      health: {
        model_cache_ready: true,
        embedding_pipeline_loaded: true,
        bridge_ready: true,
        preload_status: "loaded"
      }
    })));
    client.emit("end");

    await expect(pending).resolves.toMatchObject({
      model_cache_ready: true,
      embedding_pipeline_loaded: true,
      bridge_ready: true
    });
    expect(client.writes).toEqual(['{"type":"health"}\n']);
  });

  it("invalidates an existing private bridge socket", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-invalidate-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");

    expect(invalidateCtxMcpSocket(dataDir)).toBe(true);
    expect(fs.existsSync(ctxMcpSocketPath(dataDir))).toBe(false);
  });

  it("does not spawn ctx-mcp daemon when the bridge socket already exists", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-daemon-present-"));
    fs.writeFileSync(ctxMcpSocketPath(dataDir), "");

    const result = await ensureCtxMcpDaemon({
      dataDir,
      spawnProcess: () => {
        throw new Error("should not spawn");
      }
    });

    expect(result).toMatchObject({ started: false, status: "socket-present" });
  });

  it("spawns ctx-mcp daemon and waits briefly for bridge health", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-mcp-daemon-start-"));
    const spawns = [];
    const result = await ensureCtxMcpDaemon({
      dataDir,
      waitMs: 50,
      spawnProcess: (command, args, options) => {
        spawns.push({ command, args, options });
        return { unref: () => {} };
      },
      healthClient: async () => ({
        model_cache_ready: true,
        embedding_pipeline_loaded: true,
        bridge_ready: true
      })
    });

    expect(result).toMatchObject({ started: true, status: "ready" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].command).toBe(process.execPath);
    expect(spawns[0].options.detached).toBe(true);
    expect(spawns[0].options.stdio).toBe("ignore");
    expect(spawns[0].options.env.BACKENDGUARD_MCP_DAEMON).toBe("1");
  });
});

function fakeClient() {
  const client = new EventEmitter();
  client.destroyed = false;
  client.writes = [];
  client.destroy = () => {
    client.destroyed = true;
  };
  client.write = (value) => {
    client.writes.push(value);
  };
  return client;
}
