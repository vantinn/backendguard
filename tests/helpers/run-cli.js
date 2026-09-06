import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the CLI as a real process, asynchronously.
 *
 * Async matters here, not just style. These tests spawn `backendguard install`,
 * which takes ten seconds or so, and `execFileSync` blocks the whole worker
 * thread for that time — long enough that the worker stops answering Vitest's
 * `onTaskUpdate` RPC, which fails the run with an unhandled
 * "Timeout calling onTaskUpdate" even though every test passed. Awaiting a
 * spawn keeps the worker's event loop responsive.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = path.join(repoRoot, "cli", "backendguard.js");

/** A throwaway HOME so a test install cannot touch real agent configuration. */
export function sandboxEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    BACKENDGUARD_HOME: path.join(home, ".ctx"),
    CLAUDE_HOME: path.join(home, ".claude"),
    CLAUDE_CONFIG_PATH: path.join(home, ".claude.json"),
    CODEX_HOME: path.join(home, ".codex"),
    BACKENDGUARD_SKIP_UPDATE_CHECK: "1",
    ...extra
  };
}

export function makeTempDir(label = "bg") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

/**
 * @returns {Promise<{status: number, out: string, stdout: string, stderr: string}>}
 */
export function runCli(args, { cwd = repoRoot, home, env = {}, timeout = 240_000 } = {}) {
  const sandbox = home || makeTempDir("bg-home");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: sandboxEnv(sandbox, env),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: -1, out: `${stdout}${stderr}`, stdout, stderr });
    }, timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: -1, out: String(error?.message || error), stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code === null ? -1 : code, out: `${stdout}${stderr}`, stdout, stderr });
    });
  });
}
