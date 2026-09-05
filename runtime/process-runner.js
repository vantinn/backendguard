import { execFileSync, spawn } from "node:child_process";

/**
 * Safe child-process execution.
 *
 * Every call site in this codebase used to pass `{ shell: true }` together with
 * an argument array. Node concatenates the command and its arguments into a
 * single string and hands it to `sh -c` in that mode (which is why Node emits
 * DEP0190 for it): an argument containing `;`, `$(...)`, backticks or a pipe is
 * then executed as a command. Several of those arguments came from user input —
 * agent names, project paths, MCP server names — so the tool that reports
 * command injection in other people's code was exposed to it itself.
 *
 * The rule here is: **arguments are never handed to a shell.** `shell: false`
 * passes the argv array to the OS directly, so metacharacters are inert.
 *
 * Windows is the one case that historically motivated `shell: true`: `npx`,
 * `ruler` and similar npm binaries are `.cmd` shims that CreateProcess cannot
 * execute. That is handled by resolving the shim's real extension and running
 * it through `cmd.exe` with explicit per-argument quoting, rather than by
 * concatenating a command line.
 */

/**
 * Characters that change the meaning of a cmd.exe command line. Backslash is
 * deliberately absent: it is the Windows path separator, not a metacharacter,
 * and rejecting it would make the fallback useless. `%` is included because
 * cmd expands `%VAR%` even inside double quotes.
 */
const SHELL_METACHARACTERS = /[&|<>^"%`$;()\n\r]/;
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"];

export class UnsafeArgumentError extends Error {
  constructor(argument) {
    super(`Refusing to run a command with an argument containing shell metacharacters: ${JSON.stringify(argument)}`);
    this.name = "UnsafeArgumentError";
  }
}

/**
 * True when an argument is safe to place on a Windows command line.
 * Used only on the Windows shim path, where a shell is unavoidable.
 */
export function isShellSafeArgument(argument) {
  return !SHELL_METACHARACTERS.test(String(argument));
}

export function assertShellSafeArguments(args = []) {
  for (const argument of args) {
    if (!isShellSafeArgument(argument)) throw new UnsafeArgumentError(argument);
  }
}

/** cmd.exe quoting: wrap in double quotes and escape embedded quotes. */
export function quoteWindowsArgument(argument) {
  const value = String(argument);
  if (value === "") return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

function windowsShellInvocation(command, args, env) {
  assertShellSafeArguments([command, ...args]);
  const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine]
  };
}

/**
 * Synchronous execution with output captured.
 *
 * @param {string} command Executable name or path — never a command line.
 * @param {string[]} args  Arguments passed to the process directly.
 * @returns {{stdout: string}}
 */
export function runProcess(command, args = [], {
  cwd = process.cwd(),
  stdio = ["ignore", "pipe", "pipe"],
  env = process.env,
  timeout,
  platform = process.platform,
  exec = execFileSync
} = {}) {
  const options = { cwd, stdio, env, encoding: "utf8", windowsHide: true };
  if (timeout) options.timeout = timeout;

  try {
    const stdout = exec(command, args, options);
    return { stdout: stdout || "" };
  } catch (error) {
    // On Windows an npm-installed CLI is a .cmd shim, which CreateProcess
    // cannot start. Retry through cmd.exe with each argument quoted
    // individually — never by building one concatenated command line from
    // untrusted input.
    if (platform === "win32" && isMissingExecutable(error) && !hasShimExtension(command)) {
      const invocation = windowsShellInvocation(command, args, env);
      const stdout = exec(invocation.file, invocation.args, options);
      return { stdout: stdout || "" };
    }
    throw error;
  }
}

/** Same contract as runProcess, but returns a promise and streams nothing. */
export function spawnProcess(command, args = [], {
  cwd = process.cwd(),
  stdio = ["ignore", "pipe", "pipe"],
  env = process.env,
  platform = process.platform,
  spawnFn = spawn
} = {}) {
  const invocation = platform === "win32" && !hasShimExtension(command)
    ? windowsShellInvocation(command, args, env)
    : { file: command, args };
  return spawnFn(invocation.file, invocation.args, { cwd, stdio, env, windowsHide: true });
}

function isMissingExecutable(error) {
  return error?.code === "ENOENT" || error?.code === "EACCES" || /not recognized as an internal/i.test(error?.message || "");
}

function hasShimExtension(command) {
  return WINDOWS_SHIM_EXTENSIONS.some((extension) => String(command).toLowerCase().endsWith(extension));
}
