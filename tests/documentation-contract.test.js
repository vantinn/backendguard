import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { COMMANDS, findCommand } from "../cli/command-registry.js";
import { runCli } from "./helpers/run-cli.js";

/**
 * The README is an API contract.
 *
 * 0.9.1 documented `backendguard install claude`, which was ignored, and
 * `install --quiet` / `--inject`, which never existed — three documented
 * behaviours that did not work. This test extracts every `backendguard ...`
 * line from the README and checks it against the CLI's own declared surface,
 * so documentation and implementation cannot drift apart again silently.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "cli", "backendguard.js");
const README = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

const temp = [];
afterAll(() => temp.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-doc-"));
  temp.push(dir);
  return dir;
}

const run = (args, { cwd = repoRoot } = {}) => runCli(args, { cwd, home: sandbox() });

/** Every `backendguard <...>` invocation shown in a fenced block in the README. */
function documentedInvocations() {
  const found = new Map();
  for (const block of README.match(/```bash\n[\s\S]*?```/g) || []) {
    for (const line of block.split("\n")) {
      const text = line.replace(/#.*$/, "").trim();
      if (!text.startsWith("backendguard ")) continue;
      const tokens = text.split(/\s+/).slice(1);
      if (!tokens.length) continue;
      found.set(text, tokens);
    }
  }
  return found;
}

describe("README documents only commands that exist", () => {
  const invocations = documentedInvocations();

  it("finds invocations to check", () => {
    expect(invocations.size).toBeGreaterThan(15);
  });

  it("every documented command name is a real command", () => {
    const unknown = [];
    for (const [text, tokens] of invocations) {
      const name = tokens[0];
      if (name.startsWith("-")) continue;
      if (!findCommand(name)) unknown.push(text);
    }
    expect(unknown).toEqual([]);
  });

  it("every documented flag is declared by the command it is used with", () => {
    const undeclared = [];
    for (const [text, tokens] of invocations) {
      const command = findCommand(tokens[0]);
      if (!command) continue;
      const declared = new Set(["--help", "-h", "--debug", "--json"]);
      for (const [flags] of command.options || []) {
        for (const token of flags.split(",")) {
          const flag = token.trim().split(" ")[0];
          if (flag.startsWith("-")) declared.add(flag);
        }
      }
      const separator = tokens.indexOf("--");
      const scanned = separator >= 0 ? tokens.slice(0, separator) : tokens;
      for (const token of scanned.slice(1)) {
        if (token.startsWith("-") && !declared.has(token)) undeclared.push(`${text}  (${token})`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("no documented invocation is rejected as a usage error", async () => {
    // Usage errors (exit 2) mean the CLI does not accept what the README shows.
    // Commands needing network, an agent CLI or prior state may legitimately
    // fail otherwise, so only exit code 2 is treated as a contract breach.
    const rejected = [];
    for (const [text, tokens] of invocations) {
      if (!findCommand(tokens[0])) continue;
      // Skip the ones that mutate the machine or need a third-party CLI.
      if (/^(install|setup|sync|refresh|ruler|skillshare|leaderboard|benchmark|embeddings|autowarm)\b/.test(tokens[0])) continue;
      const result = await run([...tokens, "--help"]);
      if (result.status === 2) rejected.push(`${text} -> exit 2: ${result.out.split("\n")[0]}`);
    }
    expect(rejected).toEqual([]);
  });
});

describe("every registered command answers --help", () => {
  for (const command of COMMANDS) {
    it(`${command.name} --help`, async () => {
      const result = await run([command.name, "--help"]);
      expect(result.status, result.out.slice(0, 200)).toBe(0);
      expect(result.out).toContain(command.name);
      expect(result.out).toMatch(/Usage:/);
    });
  }
});

describe("the analyzer list the README points at is the real one", () => {
  it("--list-analyzers runs and names the documented analyzers", async () => {
    const result = await run(["analyze", "--list-analyzers"]);
    expect(result.status).toBe(0);
    for (const id of ["nestjs-security", "typeorm", "prisma", "postgresql", "performance", "scalability"]) {
      expect(result.out, id).toContain(id);
    }
  });

  it("README's not-implemented list does not name an analyzer that exists", () => {
    const claimed = README.match(/\*\*Not implemented:\*\*([^\n]*)/)?.[1] || "";
    expect(claimed).toBeTruthy();
    // A registered analyzer id must never appear in the "not implemented" list.
    for (const id of ["nestjs-security", "typeorm", "prisma", "postgresql", "scalability"]) {
      expect(claimed.toLowerCase(), id).not.toContain(`\`${id}\``);
    }
  });
});
