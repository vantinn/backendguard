import fs from "node:fs";
import { spawn } from "node:child_process";

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
