import { spawnSync } from "node:child_process";

const SUPPORTED_COMMANDS = new Set(["ruler", "skillshare"]);

export function parsePassthroughArgs(args = []) {
  const command = args[0];
  if (!SUPPORTED_COMMANDS.has(command)) {
    throw new Error(`Unsupported passthrough command: ${command || ""}`);
  }

  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new Error(`Usage: backendguard ${command} -- <${command} args>`);
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

  const result = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: true
  });

  if (result.error) {
    const hint = command === "ruler"
      ? "Install it with `npm install -g @intellectronica/ruler`."
      : "Install it with `curl -fsSL https://raw.githubusercontent.com/runkids/skillshare/main/install.sh | sh`.";
    throw new Error(`Failed to run ${command}: ${result.error.message}. ${hint}`);
  }

  return {
    status: typeof result.status === "number" ? result.status : 1,
    signal: result.signal || null
  };
}
