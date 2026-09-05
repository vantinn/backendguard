import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMANDS, findCommand, renderCommandHelp, renderUsage } from "../cli/command-registry.js";
import { EXIT } from "../cli/exit-codes.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "cli", "backendguard.js");
const FIXTURES = path.join(repoRoot, "evaluation", "detection-quality", "fixtures");

/**
 * These tests drive the CLI the way a user does — as a process, checking stdout
 * and the exit code — rather than importing its internals, because the exit
 * code and the absence of a stack trace *are* the contract.
 */
function run(args, { cwd = repoRoot, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BACKENDGUARD_SKIP_UPDATE_CHECK: "1", ...env }
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

describe("command registry", () => {
  it("gives every command a summary, a usage line and a group", () => {
    for (const command of COMMANDS) {
      expect(command.summary, command.name).toBeTruthy();
      expect(command.usage.length, command.name).toBeGreaterThan(0);
      expect(command.group, command.name).toBeTruthy();
    }
  });

  it("renders help for every documented command", () => {
    for (const command of COMMANDS) {
      const help = renderCommandHelp(command.name);
      expect(help).toContain(`backendguard ${command.name}`);
      expect(help).toContain("Exit codes:");
    }
  });

  it("resolves each alias to its command", () => {
    for (const command of COMMANDS) {
      for (const alias of command.aliases || []) {
        expect(findCommand(alias)?.name).toBe(command.name);
      }
    }
  });

  it("documents every command the CLI actually dispatches", () => {
    // Guards against help text drifting away from the dispatch chain.
    const source = fs.readFileSync(CLI, "utf8");
    const dispatched = new Set([...source.matchAll(/command === "([a-z-]+)"/g)].map((match) => match[1]));
    // Global flags handled by the same chain, not commands.
    for (const flag of ["--help", "-h", "help", "--version", "-v", "--config"]) dispatched.delete(flag);
    const documented = new Set(COMMANDS.flatMap((command) => [command.name, ...(command.aliases || [])]));
    // `debug`/`skills` are the internal names behind `context`/`rules`.
    documented.add("debug");
    documented.add("skills");
    for (const name of dispatched) {
      expect(documented.has(name), `dispatched but undocumented: ${name}`).toBe(true);
    }
  });

  it("lists every command in the top-level usage", () => {
    const usage = renderUsage();
    for (const command of COMMANDS) expect(usage).toContain(command.name);
  });
});

describe("backendguard CLI: help and version", () => {
  it("prints usage with no arguments and exits 0", () => {
    const result = run([]);
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("BackendGuard");
    expect(result.stdout).toContain("Usage:");
  });

  // One process spawn per command; generous timeout so a loaded CI machine
  // does not turn this into a flake.
  it("prints per-command help for every command without running it", () => {
    for (const command of COMMANDS) {
      const result = run([command.name, "--help"]);
      expect(result.status, `${command.name} --help`).toBe(EXIT.OK);
      expect(result.stdout).toContain(`backendguard ${command.name}`);
    }
  }, 60_000);

  it("supports `help <command>` as well as `<command> --help`", () => {
    expect(run(["help", "analyze"]).stdout).toContain("backendguard analyze");
  });

  it("prints a semver version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("backendguard CLI: user errors", () => {
  it("rejects an unknown command with exit 2 and no stack trace", () => {
    const result = run(["frobnicate"]);
    expect(result.status).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("Unknown command: frobnicate");
    expect(result.stderr).not.toContain("at ");
    expect(result.stderr).not.toContain("Error:");
  });

  it("rejects an unknown option instead of silently ignoring it", () => {
    const result = run(["analyze", "--sevrity", "high"]);
    expect(result.status).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("--sevrity");
    expect(result.stderr).toContain("--help");
  });

  it("rejects an invalid severity value and lists the valid ones", () => {
    const result = run(["analyze", "--severity", "huge"]);
    expect(result.status).toBe(EXIT.USAGE);
    expect(result.stderr).toContain('Invalid severity "huge"');
    expect(result.stderr).toContain("critical");
  });

  it("rejects a flag that is missing its value", () => {
    const result = run(["analyze", "--severity"]);
    expect(result.status).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("requires a value");
  });

  it("reports a missing directory as an environment error, not a crash", () => {
    const result = run(["analyze", "./definitely-not-here"]);
    expect(result.status).toBe(EXIT.ENVIRONMENT);
    expect(result.stderr).toContain("No such directory");
    expect(result.stderr).not.toContain("at ");
  });

  it("requires a task for the context command", () => {
    const result = run(["context"]);
    expect(result.status).not.toBe(EXIT.OK);
    expect(result.stderr).toContain("task");
  });

  // Every command that can be invoked with a missing or wrong argument must
  // classify that as a usage error. Six of them previously answered exit 70
  // and "This is a bug in BackendGuard. Please report it."
  it("classifies a missing argument as a usage error on every command that takes one", () => {
    for (const argv of [["context"], ["benchmark"], ["leaderboard"], ["embeddings"], ["embeddings", "warp"], ["sync"], ["ruler"], ["skillshare"]]) {
      const result = run(argv);
      expect(result.status, argv.join(" ")).toBe(EXIT.USAGE);
      expect(result.stderr, argv.join(" ")).not.toContain("Unexpected error");
      expect(result.stderr, argv.join(" ")).not.toContain("This is a bug");
    }
  }, 60_000);

  it("explains that check needs a git repository", () => {
    const outside = makeFixture("no-git");
    writeFiles(outside, { "package.json": "{}" });
    const result = run(["check"], { cwd: outside });
    expect(result.status).toBe(EXIT.ENVIRONMENT);
    expect(result.stderr).toContain("git repository");
  });
});

describe("backendguard CLI: analyze", () => {
  const typeormFixture = path.join(FIXTURES, "nest-typeorm-postgres");
  const secureFixture = path.join(FIXTURES, "secure-baseline");

  it("reports findings for a project with planted defects", () => {
    const result = run(["analyze", typeormFixture]);
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("SEC-003");
    expect(result.stdout).toContain("fix:");
  });

  it("emits valid JSON with --json", () => {
    const result = run(["analyze", typeormFixture, "--json"]);
    const payload = JSON.parse(result.stdout);
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings[0]).toHaveProperty("remediation");
    expect(payload.findings[0]).toHaveProperty("confidence");
    expect(payload.stack.orm).toBe("TypeORM");
  });

  it("exits 1 when --fail-on is met and 0 when it is not", () => {
    expect(run(["analyze", typeormFixture, "--fail-on", "high"]).status).toBe(EXIT.FINDINGS);
    expect(run(["analyze", typeormFixture, "--fail-on", "critical"]).status).toBe(EXIT.OK);
  });

  it("reports nothing and exits 0 for a correct project", () => {
    const result = run(["analyze", secureFixture, "--fail-on", "low"]);
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("No findings.");
  });

  it("filters by severity and by category", () => {
    const high = JSON.parse(run(["analyze", typeormFixture, "--json", "--severity", "high"]).stdout);
    expect(high.findings.every((finding) => ["HIGH", "CRITICAL"].includes(finding.severity))).toBe(true);

    const security = JSON.parse(run(["analyze", typeormFixture, "--json", "--category", "security"]).stdout);
    expect(security.findings.every((finding) => finding.category === "Security")).toBe(true);
    expect(security.findings.length).toBeGreaterThan(0);
  });

  it("lists the registered analyzers", () => {
    const result = run(["analyze", "--list-analyzers"]);
    expect(result.status).toBe(EXIT.OK);
    for (const id of ["nestjs-security", "typeorm", "prisma", "postgresql", "performance", "scalability"]) {
      expect(result.stdout).toContain(id);
    }
  });

  it("states that performance findings are static, not measured", () => {
    const result = run(["analyze", typeormFixture]);
    expect(result.stdout).toContain("not measurements");
  });
});

describe("backendguard CLI: stack", () => {
  it("prints evidence for each detection with --evidence", () => {
    const result = run(["stack", "--evidence"], { cwd: path.join(FIXTURES, "nest-prisma-postgres") });
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("Prisma");
    expect(result.stdout).toContain("←");
  });

  it("emits the detected stack as JSON", () => {
    const result = run(["stack", "--json"], { cwd: path.join(FIXTURES, "nest-prisma-postgres") });
    const stack = JSON.parse(result.stdout);
    expect(stack.orm).toBe("Prisma");
    expect(stack.evidence.orm.length).toBeGreaterThan(0);
  });
});
