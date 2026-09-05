import fs from "node:fs";
import { spawn } from "node:child_process";
import { EnvironmentError, IntegrationError } from "./errors.js";

export function shellInvocation(command, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }
  return {
    command: fs.existsSync("/bin/sh") ? "/bin/sh" : "sh",
    args: ["-c", command]
  };
}

export function runPrefixedCommand(commandText, {
  spawnFn = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = "inherit",
  platform = process.platform,
  env = process.env,
  prefix = "\x1B[2m│\x1B[0m  "
} = {}) {
  const shell = shellInvocation(commandText, { platform, env });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let child;
    try {
      child = spawnFn(shell.command, shell.args, {
        stdio: [stdin, "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      fail(error);
      return;
    }

    pipePrefixed(child.stdout, stdout, prefix);
    pipePrefixed(child.stderr, stderr, prefix);

    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        fail(new Error([
          `Unable to start shell '${shell.command}' for installer command.`,
          `Original command: ${commandText}`,
          platform === "win32"
            ? "Fix: ensure cmd.exe is available through ComSpec/COMSPEC, or run BackendGuard from a normal Command Prompt, PowerShell, or Windows Terminal session."
            : "Fix: ensure /bin/sh exists, or install a POSIX shell before running BackendGuard installers."
        ].join("\n")));
        return;
      }
      fail(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`Installer command exited with code ${code}: ${commandText}`));
    });
  });
}

function pipePrefixed(stream, target, prefix) {
  if (!stream) return;
  let needPrefix = true;
  stream.on("data", (buf) => {
    const str = buf.toString();
    let out = "";
    for (const ch of str) {
      if (needPrefix) {
        out += prefix;
        needPrefix = false;
      }
      out += ch;
      if (ch === "\n") needPrefix = true;
    }
    target.write(out);
  });
}

/**
 * Spawn a command and stream its output line-by-line through a logger.
 *
 * This exists so callers that want streamed installer output do not each
 * hand-roll a `spawn` wrapper — one of them referenced `spawn` without
 * importing it, and every skillshare auto-install died with
 * `ReferenceError: spawn is not defined` before the installer ever started.
 *
 * `shell: false`: the argv array reaches the OS directly. A caller that
 * genuinely needs a shell pipeline passes the shell itself as `command`
 * (see `shellInvocation`), which keeps that decision explicit and local.
 */
export function spawnStreaming(command, args = [], {
  spawnFn = spawn,
  log = console.log,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 0,
  label = command,
  integration = null
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    let child;
    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      finish(reject, describeSpawnFailure(error, { command, label, integration }));
      return;
    }

    const streamLines = (stream) => {
      if (!stream) return;
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) log(line);
        }
      });
      stream.on("end", () => {
        if (buffer.trim()) log(buffer.trim());
      });
    };

    streamLines(child.stdout);
    streamLines(child.stderr);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(reject, new IntegrationError(`${label} did not finish within ${timeoutMs}ms and was stopped.`, {
          hint: "Re-run when the network is reachable, or install the tool manually.",
          integration
        }));
      }, timeoutMs);
    }

    child.on("error", (error) => {
      finish(reject, describeSpawnFailure(error, { command, label, integration }));
    });

    child.on("close", (code, signal) => {
      if (signal) {
        finish(reject, new IntegrationError(`${label} was terminated by signal ${signal}.`, { integration }));
        return;
      }
      if (code === 0) finish(resolve, { code: 0 });
      else {
        finish(reject, new IntegrationError(`${label} exited with code ${code}.`, {
          hint: "The output above is from the third-party installer, not from BackendGuard.",
          integration
        }));
      }
    });
  });
}

/**
 * Turns a spawn-level failure into an error the CLI can classify. A missing
 * executable or a permission problem is the environment's, not a bug.
 */
function describeSpawnFailure(error, { command, label, integration }) {
  if (error?.code === "ENOENT") {
    return new EnvironmentError(`Could not run '${command}': the executable was not found.`, {
      hint: `Install ${label} and make sure it is on PATH, then re-run.`
    });
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new EnvironmentError(`Could not run '${command}': permission denied.`, {
      hint: `Check that ${command} is executable by the current user.`
    });
  }
  return new IntegrationError(`${label} could not be started: ${error?.message || error}`, { integration, cause: error });
}
