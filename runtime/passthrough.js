import { spawnSync } from "node:child_process";
import { EnvironmentError, UsageError } from "./errors.js";

const SUPPORTED_COMMANDS = new Set(["ruler", "skillshare"]);

export function parsePassthroughArgs(args = []) {
  const command = args[0];
  if (!SUPPORTED_COMMANDS.has(command)) {
    throw new UsageError(`Unsupported passthrough command: ${command || "(none)"}`, {
      hint: `Supported passthrough commands: ${[...SUPPORTED_COMMANDS].join(", ")}.`
    });
  }

  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new UsageError(`\`backendguard ${command}\` needs arguments to forward.`, {
      hint: `Everything after \`--\` is passed to ${command}: backendguard ${command} -- --version`
    });
  }

  return {
    command,
    args: args.slice(separator + 1)
  };
}

export function runPassthrough({
  command,
  args = [],
  spawn = spawnSync,
  cwd = process.cwd(),
  env = process.env
} = {}) {
  if (!SUPPORTED_COMMANDS.has(command)) {
    throw new Error(`Unsupported passthrough command: ${command || ""}`);
  }

  // `shell: false`: the arguments after `--` come straight from the user's
  // command line and are forwarded verbatim to the third-party CLI. Handing
  // them to a shell here would let `backendguard ruler -- "; rm -rf ~"` run
  // that second command.
  const result = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.error) {
    const hint = command === "ruler"
      ? "Install it with `npm install -g @intellectronica/ruler`."
      : "Install it with `curl -fsSL https://raw.githubusercontent.com/runkids/skillshare/main/install.sh | sh`.";
    throw new EnvironmentError(`Could not run ${command}: ${result.error.message}`, { hint });
  }

  return {
    status: typeof result.status === "number" ? result.status : 1,
    signal: result.signal || null
  };
}
