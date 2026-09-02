import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defaultDataRoot } from "./workspace-data.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
export const CTX_MCP_BRIDGE_REVISION = 2;

export function ctxMcpSocketPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, "ctx-mcp.sock");
}

export function invalidateCtxMcpSocket(dataDir = defaultDataDir()) {
  const socketPath = ctxMcpSocketPath(dataDir);
  if (!fs.existsSync(socketPath)) return false;
  try {
    fs.rmSync(socketPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function callCtxScoreContext(payload, {
  dataDir = defaultDataDir(),
  timeoutMs = Number(process.env.BACKENDGUARD_MCP_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  connectTimeoutMs = Number(process.env.BACKENDGUARD_MCP_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  createConnection = net.createConnection
} = {}) {
  return callBridge(payload, { dataDir, timeoutMs, connectTimeoutMs, createConnection });
}

export async function callCtxHealth({
  dataDir = defaultDataDir(),
  timeoutMs = Number(process.env.BACKENDGUARD_MCP_HEALTH_TIMEOUT_MS || 250),
  connectTimeoutMs = Number(process.env.BACKENDGUARD_MCP_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  createConnection = net.createConnection
} = {}) {
  const response = await callBridge({ type: "health" }, { dataDir, timeoutMs, connectTimeoutMs, createConnection });
  return response.health || {};
}

export async function ensureCtxMcpDaemon({
  dataDir = defaultDataDir(),
  waitMs = Number(process.env.BACKENDGUARD_MCP_AUTOSTART_WAIT_MS || 1500),
  enabled = process.env.BACKENDGUARD_MCP_AUTOSTART !== "0",
  socketPath = ctxMcpSocketPath(dataDir),
  spawnProcess = spawn,
  healthClient = callCtxHealth
} = {}) {
  if (!enabled) return { started: false, status: "disabled" };
  if (fs.existsSync(socketPath)) return { started: false, status: "socket-present" };

  const serverPath = fileURLToPath(new URL("../mcp/server.js", import.meta.url));
  const child = spawnProcess(process.execPath, [serverPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BACKENDGUARD_MCP_DAEMON: "1"
    }
  });
  child.unref?.();

  const deadline = Date.now() + Math.max(0, waitMs);
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const health = await healthClient({
        dataDir,
        timeoutMs: Math.min(250, Math.max(50, waitMs)),
        connectTimeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, Math.max(50, waitMs))
      });
      return { started: true, status: "ready", health };
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  return {
    started: true,
    status: "timeout",
    error: lastError?.message || String(lastError || "ctx-mcp daemon did not become ready")
  };
}

async function callBridge(payload, {
  dataDir,
  timeoutMs,
  connectTimeoutMs,
  createConnection
}) {
  const socketPath = ctxMcpSocketPath(dataDir);
  if (!fs.existsSync(socketPath)) {
    throw new Error(`ctx-mcp bridge socket not found: ${socketPath}`);
  }
  const socketIdentity = statIdentity(socketPath);

  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let raw = "";
    let responseTimer;
    const connectTimer = setTimeout(() => {
      invalidateSocketIfUnchanged(socketPath, socketIdentity);
      client.destroy();
      reject(new Error(`ctx-mcp bridge connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    client.on("connect", () => {
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => {
        invalidateSocketIfUnchanged(socketPath, socketIdentity);
        client.destroy();
        reject(new Error(`ctx-mcp bridge timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      client.write(`${JSON.stringify(payload)}\n`);
    });
    client.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    client.on("end", () => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      try {
        const response = JSON.parse(raw || "{}");
        if (response.bridgeRevision !== CTX_MCP_BRIDGE_REVISION) {
          invalidateSocketIfUnchanged(socketPath, socketIdentity);
          reject(new Error(`ctx-mcp bridge revision mismatch: expected ${CTX_MCP_BRIDGE_REVISION}, received ${response.bridgeRevision || "missing"}`));
          return;
        }
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    client.on("error", (error) => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      reject(error);
    });
  });
}

function invalidateSocketIfUnchanged(socketPath, expectedIdentity) {
  if (!expectedIdentity || statIdentity(socketPath) !== expectedIdentity) return false;
  try {
    fs.rmSync(socketPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function statIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function defaultDataDir() {
  return defaultDataRoot();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
