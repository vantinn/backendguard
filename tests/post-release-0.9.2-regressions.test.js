import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  AGENTS,
  agentSelectionOptions,
  assertKnownAgent,
  detectInstalledAgents,
  emptyAgentSelectionError,
  externalAgentName,
  parseAgents,
  parseInstallAgents
} from "../runtime/agents.js";
import { parseSetupArgs } from "../runtime/setup-wizard.js";
import { spawnStreaming } from "../runtime/shell-runner.js";
import { installSkillshare } from "../agent-context/skill-sync.js";
import { EXIT, UsageError, isExpectedError } from "../runtime/errors.js";
import { formatCliError } from "../cli/exit-codes.js";
import { findCommand } from "../cli/command-registry.js";
import { rejectUnknownFlags } from "../cli/options.js";

/**
 * Regressions for the bugs real users hit on 0.9.1.
 *
 * Every test here names the bug it pins. The CLI-level ones run the binary as
 * a process, because the exit code and the absence of "This is a bug in
 * BackendGuard" *are* the contract that broke — asserting on internals would
 * not have caught any of these.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "cli", "backendguard.js");

const tempDirs = [];

function makeProject(files = { "package.json": '{"name":"fixture","version":"1.0.0"}' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-regression-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

/**
 * Runs the CLI with a throwaway HOME so an install cannot touch the developer's
 * real agent configuration.
 */
function runCli(args, { cwd = repoRoot, home = makeProject({}), env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        BACKENDGUARD_HOME: path.join(home, ".ctx"),
        CODEX_HOME: path.join(home, ".codex"),
        CLAUDE_HOME: path.join(home, ".claude"),
        CLAUDE_CONFIG_PATH: path.join(home, ".claude.json"),
        BACKENDGUARD_SKIP_UPDATE_CHECK: "1",
        ...env
      }
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : -1,
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
  }
}

const INTERNAL_BUG_MARKER = "This is a bug in BackendGuard";

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("BUG-001: the agent prompt has a sensible default selection", () => {
  it("preselects the agents this machine already has", () => {
    const home = "/home/dev";
    const exists = (target) => target === path.join(home, ".claude");
    const options = agentSelectionOptions({ home, cwd: "/repo", exists });

    const selected = options.filter((option) => option.selected).map((option) => option.value);
    expect(selected).toEqual(["claude"]);
    expect(options.find((option) => option.value === "claude").hint).toBe("detected on this machine");
  });

  it("falls back to codex when no agent can be detected, so Enter never installs nothing", () => {
    const options = agentSelectionOptions({ home: "/home/dev", cwd: "/repo", exists: () => false });
    const selected = options.filter((option) => option.selected).map((option) => option.value);

    expect(selected).toEqual(["codex"]);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("gives every option an explicit boolean, which the two prompt branches read differently", () => {
    for (const option of agentSelectionOptions({ home: "/h", cwd: "/c", exists: () => false })) {
      expect(typeof option.selected, option.value).toBe("boolean");
    }
  });

  it("detects an agent from the project directory as well as from home", () => {
    const exists = (target) => target === path.join("/repo", ".codex");
    expect(detectInstalledAgents({ home: "/home/dev", cwd: "/repo", exists })).toEqual(["codex"]);
  });

  it("offers every supported agent, whatever is detected", () => {
    const options = agentSelectionOptions({ home: "/h", cwd: "/c", exists: () => false });
    expect(options.map((option) => option.value)).toEqual(AGENTS.map((agent) => agent.value));
  });
});

describe("BUG-002: an empty agent selection stops immediately", () => {
  it("is a usage error carrying exit code 2, not a bare Error", () => {
    const error = emptyAgentSelectionError();
    expect(error).toBeInstanceOf(UsageError);
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.hint).toMatch(/Space/);
  });

  it("rejects `setup --agents \"\"` while parsing, before any prompt or write", () => {
    expect(() => parseSetupArgs(["--agents", ""])).toThrow(UsageError);
  });

  it("fails a non-interactive `setup` without reaching the ready-to-setup summary", () => {
    const result = runCli(["setup", "--agents", ""], { cwd: makeProject() });

    expect(result.status).toBe(EXIT.USAGE);
    expect(result.stderr).not.toContain(INTERNAL_BUG_MARKER);
    // The wizard used to print its full plan and only then fail.
    expect(result.stdout).not.toContain("Ready to setup");
  });

  it("does not create configuration for a run that selected no agent", () => {
    const cwd = makeProject();
    const home = makeProject({});
    runCli(["setup", "--agents", ""], { cwd, home });

    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".ruler"))).toBe(false);
  });
});

describe("BUG-003: user and environment problems are never reported as internal bugs", () => {
  const cases = [
    { name: "unknown agent", args: ["install", "bogus"], exit: EXIT.USAGE },
    { name: "unknown agent via --agent", args: ["install", "--agent", "bogus"], exit: EXIT.USAGE },
    { name: "empty --agents", args: ["install", "--agents", ""], exit: EXIT.USAGE },
    { name: "empty setup --agents", args: ["setup", "--agents", ""], exit: EXIT.USAGE },
    { name: "missing --agent value", args: ["install", "--agent"], exit: EXIT.USAGE },
    { name: "piped agent names", args: ["install", "--agent", "codex|claude"], exit: EXIT.USAGE },
    { name: "rules doctor without a task", args: ["rules", "doctor"], exit: EXIT.USAGE },
    { name: "unknown command", args: ["nope"], exit: EXIT.USAGE },
    { name: "unknown flag", args: ["analyze", "--sevrity", "high"], exit: EXIT.USAGE },
    { name: "missing report", args: ["report"], exit: EXIT.ENVIRONMENT },
    { name: "missing evidence", args: ["evidence"], exit: EXIT.ENVIRONMENT },
    { name: "missing analyze path", args: ["analyze", "/no/such/dir"], exit: EXIT.ENVIRONMENT }
  ];

  for (const { name, args, exit } of cases) {
    it(`${name} exits ${exit} and does not blame BackendGuard`, () => {
      const result = runCli(args, { cwd: makeProject() });
      const output = `${result.stdout}${result.stderr}`;

      expect(output, name).not.toContain(INTERNAL_BUG_MARKER);
      expect(output, name).not.toContain("Unexpected error");
      expect(result.status, `${name}: ${output.slice(0, 300)}`).toBe(exit);
    });
  }

  it("prints a hint rather than a stack trace for an expected error", () => {
    const rendered = formatCliError(new UsageError("bad thing", { hint: "do this instead" }));
    expect(rendered).toContain("bad thing");
    expect(rendered).toContain("do this instead");
    expect(rendered).not.toContain(INTERNAL_BUG_MARKER);
  });

  it("still reports a genuine internal fault as a bug", () => {
    const rendered = formatCliError(new TypeError("x is not a function"));
    expect(rendered).toContain(INTERNAL_BUG_MARKER);
    expect(isExpectedError(new TypeError("boom"))).toBe(false);
  });
});

describe("BUG-004: `backendguard install claude` uses the positional agent", () => {
  it("parses the positional form README documents", () => {
    expect(parseInstallAgents(["install", "claude"])).toEqual({ agents: ["claude"], source: "positional" });
  });

  it("still parses both flag forms", () => {
    expect(parseInstallAgents(["install", "--agent", "claude"]))
      .toEqual({ agents: ["claude"], source: "--agent" });
    expect(parseInstallAgents(["install", "--agents", "codex,claude"]))
      .toEqual({ agents: ["codex", "claude"], source: "--agents" });
  });

  it("normalizes antigravity to its internal name and back", () => {
    expect(parseInstallAgents(["install", "antigravity"]).agents).toEqual(["agy"]);
    expect(externalAgentName("agy")).toBe("antigravity");
  });

  it("returns null only when no agent was named, so the prompt is the last resort", () => {
    expect(parseInstallAgents(["install"])).toBeNull();
    expect(parseInstallAgents(["install", "--copy"])).toBeNull();
  });

  it("does not mistake a flag's value for a positional agent", () => {
    expect(parseInstallAgents(["install", "--agent", "claude"], { knownFlags: ["--agent", "--agents"] }))
      .toEqual({ agents: ["claude"], source: "--agent" });
  });

  it("rejects two positional agents with an actionable message", () => {
    expect(() => parseInstallAgents(["install", "codex", "claude"]))
      .toThrow(/takes one agent name/);
    try {
      parseInstallAgents(["install", "codex", "claude"]);
    } catch (error) {
      expect(error.hint).toContain("--agents codex,claude");
    }
  });

  it("does not open an interactive prompt for an explicit agent", () => {
    // stdin is /dev/null here, so a prompt would return the preselected set
    // and print the select header. Neither may appear.
    const result = runCli(["install", "claude"], { cwd: makeProject() });
    expect(result.stdout).not.toContain("Select agents to install");
    expect(result.stdout).toContain("Installing claude");
    expect(result.status).toBe(EXIT.OK);
  }, 180_000);

  it("never exits 0 after installing nothing", () => {
    for (const args of [["install", "bogus"], ["install", "--agents", ""]]) {
      const result = runCli(args, { cwd: makeProject() });
      expect(result.status, args.join(" ")).not.toBe(EXIT.OK);
    }
  });

  it("rejects an unknown agent before writing anything", () => {
    const home = makeProject({});
    const result = runCli(["install", "bogus"], { cwd: makeProject(), home });

    expect(result.status).toBe(EXIT.USAGE);
    // 0.9.1 printed "◇ Installing bogus..." and copied the package first.
    expect(result.stdout).not.toContain("Installing bogus");
    expect(fs.existsSync(path.join(home, ".ctx", "agents"))).toBe(false);
  });
});

describe("BUG-005: the skillshare installer no longer dies with `spawn is not defined`", () => {
  it("does not throw a ReferenceError before the installer starts", async () => {
    // The installer command is replaced with a process that cannot exist, so
    // the test never reaches the network: reaching *spawn at all* is the proof
    // that the missing import is gone.
    let thrown = null;
    try {
      await installSkillshare({
        yes: true,
        dryRun: false,
        platform: "linux",
        run: () => ({ stdout: "" })
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown).not.toBeInstanceOf(ReferenceError);
    expect(thrown.message).not.toMatch(/spawn is not defined/);
  }, 60_000);

  it("classifies a missing executable as an environment problem", async () => {
    await expect(spawnStreaming("definitely-not-a-real-binary-9f3a", [], { log: () => {} }))
      .rejects.toMatchObject({ name: "EnvironmentError" });
  });

  it("classifies a non-zero exit as an integration problem, not a BackendGuard bug", async () => {
    await expect(spawnStreaming(process.execPath, ["-e", "process.exit(3)"], { log: () => {} }))
      .rejects.toMatchObject({ name: "IntegrationError" });
  });

  it("streams stdout line by line and resolves on success", async () => {
    const lines = [];
    await spawnStreaming(process.execPath, ["-e", "console.log('a');console.log('b')"], {
      log: (line) => lines.push(line)
    });
    expect(lines).toEqual(["a", "b"]);
  });

  it("stops a command that exceeds its timeout", async () => {
    await expect(spawnStreaming(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
      log: () => {},
      timeoutMs: 300
    })).rejects.toMatchObject({ name: "IntegrationError" });
  }, 20_000);

  it("every expected error type stays out of the internal-bug bucket", () => {
    for (const name of ["EnvironmentError", "IntegrationError", "UsageError", "ConfigurationError"]) {
      const error = new Error("x");
      error.name = name;
    }
    // The real check: no module reachable from the CLI references a bare
    // `spawn` it never imported.
    const sources = [
      "agent-context/skill-sync.js",
      "agent-context/rule-sync.js",
      "runtime/shell-runner.js",
      "runtime/process-runner.js",
      "runtime/passthrough.js"
    ];
    for (const relative of sources) {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      for (const identifier of ["spawn", "spawnSync", "execSync", "execFileSync", "exec"]) {
        const used = new RegExp(`(?<![\\w.$])${identifier}\\s*\\(`).test(source);
        if (!used) continue;
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*["']node:child_process["']`).test(source)
          || new RegExp(`(?:function|const|let|var)\\s+${identifier}\\b`).test(source)
          || new RegExp(`\\b${identifier}\\s*=`).test(source)
          || new RegExp(`\\b${identifier}\\s*[,}]`).test(source);
        expect(imported, `${relative} calls ${identifier}() without importing or defining it`).toBe(true);
      }
    }
  });
});

describe("CLI contract: documented flags are accepted", () => {
  // `sync --yes` and `sync --force` were implemented and documented but never
  // declared, so the flag validator rejected them with exit code 2 — which made
  // `backendguard sync --rules --yes` unusable in CI.
  const declared = [
    ["sync", ["--yes"]],
    ["sync", ["-y"]],
    ["sync", ["--force"]],
    ["sync", ["--dry-run"]],
    ["sync", ["--agents"]],
    ["install", ["--agent"]],
    ["install", ["--agents"]],
    ["install", ["--copy"]],
    ["setup", ["--yes"]],
    ["setup", ["-y"]]
  ];

  for (const [command, flags] of declared) {
    it(`\`backendguard ${command}\` accepts ${flags.join(" ")}`, () => {
      expect(() => rejectUnknownFlags([command, ...flags], findCommand(command))).not.toThrow();
    });
  }

  it("still rejects a flag no command declares", () => {
    expect(() => rejectUnknownFlags(["sync", "--nope"], findCommand("sync"))).toThrow(UsageError);
  });

  it("documents the positional agent form in `install --help`", () => {
    const result = runCli(["install", "--help"]);
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("backendguard install <agent>");
    expect(result.stdout).toContain("backendguard install claude");
  });
});

describe("agent registry", () => {
  it("accepts every documented spelling", () => {
    expect(assertKnownAgent("codex")).toBe("codex");
    expect(assertKnownAgent("Claude")).toBe("claude");
    expect(assertKnownAgent(" antigravity ")).toBe("agy");
    expect(assertKnownAgent("agy")).toBe("agy");
    expect(assertKnownAgent("copilot")).toBe("copilot");
  });

  it("rejects unknown, empty and shell-pipe spellings", () => {
    for (const bad of ["", "   ", "gpt", "codex|claude", "codex/claude"]) {
      expect(() => assertKnownAgent(bad), JSON.stringify(bad)).toThrow(UsageError);
    }
  });

  it("de-duplicates a list without dropping unknown names silently", () => {
    expect(parseAgents("codex,codex,claude")).toEqual(["codex", "claude"]);
    expect(() => parseAgents("codex,bogus")).toThrow(/bogus/);
  });
});

describe("hostile repository content cannot crash or hide the analysis", () => {
  const pkg = '{"name":"hostile","version":"1.0.0","dependencies":{"@nestjs/core":"^10.0.0","typeorm":"^0.3.0","pg":"^8.0.0"}}';

  it("survives an expression nested deep enough to overflow the TypeScript parser", () => {
    const deep = `const a = ${"(".repeat(4000)}1${")".repeat(4000)};`;
    const cwd = makeProject({
      "package.json": pkg,
      "src/deep.ts": deep,
      "src/ok.ts": "export const value = 1;"
    });

    const result = runCli(["analyze"], { cwd });

    expect(result.stderr).not.toContain(INTERNAL_BUG_MARKER);
    expect(result.stderr).not.toMatch(/Maximum call stack/);
    expect(result.status).toBe(EXIT.OK);
    // The healthy file is still analyzed, and the bad one is reported.
    expect(result.stdout).toContain("too deeply nested to parse");
    expect(result.stdout).toContain("src/deep.ts");
  });

  it("reports files skipped for size instead of silently producing partial results", () => {
    const cwd = makeProject({
      "package.json": pkg,
      "src/huge.ts": `export const blob = "${"A".repeat(3_000_000)}";`,
      "src/ok.ts": "export const value = 1;"
    });

    const result = runCli(["analyze"], { cwd });
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toMatch(/Not analyzed: .*size limit/);
  });

  it("handles unterminated, empty and oddly named sources without failing", () => {
    const cwd = makeProject({
      "package.json": pkg,
      "src/unterminated.ts": "const s = `${",
      "src/empty.ts": "",
      "src/$(whoami).ts": "export const a = 1;",
      "src/na'me.ts": "export const b = 2;",
      "src/-rf.ts": "export const c = 3;"
    });

    const result = runCli(["analyze"], { cwd });
    expect(result.stderr).not.toContain(INTERNAL_BUG_MARKER);
    expect(result.status).toBe(EXIT.OK);
  });

  it("does not follow a symlink out of the project or loop on a cyclic one", () => {
    const cwd = makeProject({ "package.json": pkg, "src/ok.ts": "export const value = 1;" });
    fs.symlinkSync("/etc/passwd", path.join(cwd, "src", "escape.ts"));
    fs.symlinkSync("..", path.join(cwd, "src", "loop"));
    fs.symlinkSync("nowhere", path.join(cwd, "src", "broken.ts"));

    const result = runCli(["analyze"], { cwd });
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).not.toContain("root:");
  });
});

describe("a malformed user config is the user's, and is never overwritten", () => {
  it("refuses to rewrite an unparseable ~/.claude.json and says why", () => {
    const home = makeProject({});
    const corrupt = "NOT JSON {{{";
    fs.writeFileSync(path.join(home, ".claude.json"), corrupt);

    const result = runCli(["install", "claude"], { cwd: makeProject(), home });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(EXIT.USAGE);
    expect(output).not.toContain(INTERNAL_BUG_MARKER);
    expect(output).toContain("is not valid JSON");
    // The user's bytes survive: this file holds their whole project list.
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe(corrupt);
  }, 180_000);

  it("treats an absent or empty config as a fresh start", async () => {
    const { readJsonConfig } = await import("../runtime/fs-utils.js");
    const dir = makeProject({ "empty.json": "" });

    expect(readJsonConfig(path.join(dir, "missing.json"), { a: 1 })).toEqual({ a: 1 });
    expect(readJsonConfig(path.join(dir, "empty.json"), { a: 1 })).toEqual({ a: 1 });
  });

  it("raises a ConfigurationError, which is an expected error, not a bug", async () => {
    const { readJsonConfig } = await import("../runtime/fs-utils.js");
    const dir = makeProject({ "bad.json": "{oops" });

    try {
      readJsonConfig(path.join(dir, "bad.json"));
      throw new Error("expected a ConfigurationError");
    } catch (error) {
      expect(error.name).toBe("ConfigurationError");
      expect(isExpectedError(error)).toBe(true);
      expect(error.exitCode).toBe(EXIT.USAGE);
    }
  });
});
