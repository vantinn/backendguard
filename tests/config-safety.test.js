import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCli } from "./helpers/run-cli.js";

import { buildClaudeMcpConfig } from "../integrations/claude/claude-mcp.js";
import { buildCopilotMcpConfig } from "../integrations/copilot/copilot-mcp.js";
import { buildAntigravityMcpConfig } from "../integrations/antigravity/antigravity-mcp.js";
import { buildGlobalHooksConfig } from "../integrations/codex/codex-hooks.js";
import { assertMergeableConfig, isPlainObject, readJsonConfig, writeJsonConfig } from "../runtime/fs-utils.js";
import { EXIT } from "../runtime/errors.js";

/**
 * Configuration files belong to the user. BackendGuard adds one key to them
 * and must never lose the rest, never report success after writing something
 * broken, and never blame itself for a permission problem on their machine.
 */

const temp = [];
afterAll(() => temp.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bg-${label}-`));
  temp.push(dir);
  return dir;
}

const runInstall = ({ home, cwd }) => runCli(["install", "claude"], { home, cwd });

const BUILDERS = {
  claude: buildClaudeMcpConfig,
  copilot: buildCopilotMcpConfig,
  antigravity: buildAntigravityMcpConfig
};

describe("a config of the wrong shape is refused, never silently mangled", () => {
  // `typeof [] === "object"`, so an array passed every shape check, and a named
  // property added to an array is dropped by JSON.stringify. The install then
  // reported success having registered no MCP server at all.
  for (const [agent, build] of Object.entries(BUILDERS)) {
    it(`${agent}: refuses an array as the whole config`, () => {
      for (const value of [[], ["a", "b"]]) {
        expect(() => build(value, { installRoot: "/root", configPath: "/c.json" }))
          .toThrow(/not an object/);
      }
    });

    it(`${agent}: refuses a non-object mcpServers`, () => {
      for (const value of [{ mcpServers: ["a"] }, { mcpServers: "x" }, { mcpServers: 1 }]) {
        expect(() => build(value, { installRoot: "/root", configPath: "/c.json" }))
          .toThrow(/mcpServers/);
      }
    });

    it(`${agent}: registers the server and keeps every other key`, () => {
      const out = build({ projects: { "/p": { a: 1 } }, numStartups: 7 },
        { installRoot: "/root", configPath: "/c.json" });
      const round = JSON.parse(JSON.stringify(out));
      expect(round.mcpServers["backendguard-mcp"]).toBeTruthy();
      expect(round.projects["/p"]).toEqual({ a: 1 });
      expect(round.numStartups).toBe(7);
    });

    it(`${agent}: treats null and undefined as an empty config`, () => {
      for (const value of [null, undefined, {}]) {
        const round = JSON.parse(JSON.stringify(build(value, { installRoot: "/root" })));
        expect(round.mcpServers["backendguard-mcp"]).toBeTruthy();
      }
    });
  }

  it("codex hooks refuse an array config and a non-object hooks key", () => {
    expect(() => buildGlobalHooksConfig([], { marketplaceRoot: "/r" })).toThrow(/not an object/);
    expect(() => buildGlobalHooksConfig({ hooks: ["x"] }, { marketplaceRoot: "/r" })).toThrow(/hooks/);
  });

  it("isPlainObject rejects arrays, null and primitives", () => {
    for (const value of [[], null, undefined, 1, "s", true]) expect(isPlainObject(value), String(value)).toBe(false);
    expect(isPlainObject({})).toBe(true);
  });

  it("assertMergeableConfig maps null to an empty object", () => {
    expect(assertMergeableConfig(null)).toEqual({});
    expect(assertMergeableConfig(undefined)).toEqual({});
  });
});

describe("unreadable and unwritable configuration is the environment's problem", () => {
  it("reports a directory where a config file was expected", () => {
    const dir = tempDir("isdir");
    fs.mkdirSync(path.join(dir, "cfg"));
    expect(() => readJsonConfig(path.join(dir, "cfg"))).toThrow(/is a directory/);
  });

  it("classifies each failure as a ConfigurationError, not an internal fault", () => {
    const dir = tempDir("cfgerr");
    fs.writeFileSync(path.join(dir, "bad.json"), "{oops");
    fs.writeFileSync(path.join(dir, "arr.json"), "[]");
    for (const file of ["bad.json", "arr.json"]) {
      try {
        readJsonConfig(path.join(dir, file));
        throw new Error(`expected ${file} to throw`);
      } catch (error) {
        expect(error.name, file).toBe("ConfigurationError");
        expect(error.exitCode, file).toBe(EXIT.USAGE);
        expect(error.hint, file).toBeTruthy();
      }
    }
  });

  it("a read-only parent directory is a usage error, not exit 70", () => {
    const home = tempDir("rodir-home");
    const locked = path.join(home, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "c.json"), "{}");
    fs.chmodSync(locked, 0o555);
    try {
      let thrown;
      try { writeJsonConfig(path.join(locked, "c.json"), { a: 1 }); } catch (error) { thrown = error; }
      expect(thrown, "expected a write failure").toBeTruthy();
      expect(thrown.name).toBe("ConfigurationError");
      expect(thrown.message).toMatch(/permission denied/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe("config writes are atomic and symlink-preserving", () => {
  it("replaces the target of a symlink rather than the symlink itself", () => {
    const dir = tempDir("symlink");
    const real = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    fs.writeFileSync(real, JSON.stringify({ keep: true }));
    fs.symlinkSync(real, link);

    writeJsonConfig(link, { keep: true, added: 1 });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({ keep: true, added: 1 });
  });

  it("leaves no temp file behind", () => {
    const dir = tempDir("tmpfile");
    const target = path.join(dir, "c.json");
    writeJsonConfig(target, { a: 1 });
    expect(fs.readdirSync(dir)).toEqual(["c.json"]);
  });

  it("preserves the original file mode", () => {
    const dir = tempDir("mode");
    const target = path.join(dir, "c.json");
    fs.writeFileSync(target, "{}");
    fs.chmodSync(target, 0o600);
    writeJsonConfig(target, { a: 1 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory when the config is new", () => {
    const dir = tempDir("mkparent");
    const target = path.join(dir, "nested", "deep", "c.json");
    writeJsonConfig(target, { a: 1 });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ a: 1 });
  });
});

describe("the installed CLI never reports a config problem as its own bug", () => {
  const shapes = { "an array": "[]", "a string": '"x"', "truncated JSON": '{"a":', "a bad mcpServers": '{"mcpServers":[]}' };

  for (const [name, content] of Object.entries(shapes)) {
    it(`${name} exits 2 and leaves the file untouched`, async () => {
      const home = tempDir("cli-cfg-home");
      const cwd = tempDir("cli-cfg-proj");
      fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"p","version":"1.0.0"}');
      fs.writeFileSync(path.join(home, ".claude.json"), content);

      const result = await runInstall({ home, cwd });

      expect(result.status, result.out.slice(0, 200)).toBe(EXIT.USAGE);
      expect(result.out).not.toContain("This is a bug in BackendGuard");
      expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe(content);
    }, 180_000);
  }
});

describe("a failing agent does not cancel the agents that can be installed", () => {
  // `install --agents codex,claude` used to abort on codex — whose CLI is
  // absent on most machines — and never attempt claude.
  it("installs the agents it can and exits 3 naming the ones it could not", async () => {
    const home = tempDir("multi-home");
    const cwd = tempDir("multi-proj");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"p","version":"1.0.0"}');

    // PATH is narrowed to Node's own directory so the Codex CLI cannot be
    // found, whatever the machine running this happens to have installed.
    const result = await runCli(["install", "--agents", "codex,claude"], {
      cwd, home, env: { PATH: path.dirname(process.execPath) }
    });

    expect(result.out).not.toContain("This is a bug in BackendGuard");
    // Claude needs no external CLI, so it must have been installed even though
    // codex could not be.
    const config = path.join(home, ".claude.json");
    expect(fs.existsSync(config), result.out.slice(-400)).toBe(true);
    expect(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers["backendguard-mcp"]).toBeTruthy();
    expect(result.status).toBe(EXIT.ENVIRONMENT);
    expect(result.out).toMatch(/Not installed/);
  }, 300_000);

  it("a broken user config still exits 2 with its own message, not a generic install failure", async () => {
    const home = tempDir("multi-cfg-home");
    const cwd = tempDir("multi-cfg-proj");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"p","version":"1.0.0"}');
    fs.writeFileSync(path.join(home, ".claude.json"), "[]");

    const result = await runInstall({ home, cwd });
    expect(result.status).toBe(EXIT.USAGE);
    expect(result.out).toMatch(/not an object/);
  }, 180_000);
});
