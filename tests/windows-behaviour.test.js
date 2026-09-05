import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertShellSafeArguments,
  isShellSafeArgument,
  quoteWindowsArgument,
  runProcess,
  UnsafeArgumentError
} from "../runtime/process-runner.js";
import { shellInvocation } from "../runtime/shell-runner.js";
import { detectOS } from "../agent-context/skill-sync.js";

/**
 * Windows behaviour, pinned deterministically.
 *
 * These run on whatever platform CI uses by injecting `platform` and a fake
 * `exec`, so they verify the *decisions* BackendGuard makes for Windows —
 * which shell it picks, how it quotes, when it falls back to a `.cmd` shim.
 *
 * They are not a substitute for running the CLI on Windows. No Windows machine
 * was used in this release; real Windows execution remains unverified, and the
 * README and CHANGELOG say so.
 */

describe("Windows shell selection", () => {
  it("uses cmd.exe from ComSpec", () => {
    const invocation = shellInvocation("echo hi", { platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    expect(shellInvocation("echo hi", { platform: "win32", env: {} }).command).toBe("cmd.exe");
  });

  it("accepts the uppercase COMSPEC spelling", () => {
    expect(shellInvocation("x", { platform: "win32", env: { COMSPEC: "D:\\cmd.exe" } }).command).toBe("D:\\cmd.exe");
  });

  it("uses /bin/sh on POSIX", () => {
    const invocation = shellInvocation("echo hi", { platform: "linux", env: {} });
    expect(invocation.args).toEqual(["-c", "echo hi"]);
    expect(invocation.command).toMatch(/sh$/);
  });
});

describe("Windows argument quoting", () => {
  it("quotes a path containing spaces", () => {
    expect(quoteWindowsArgument("C:\\Program Files\\app")).toBe('"C:\\Program Files\\app"');
  });

  it("leaves a plain argument unquoted", () => {
    expect(quoteWindowsArgument("apply")).toBe("apply");
  });

  it("represents an empty argument", () => {
    expect(quoteWindowsArgument("")).toBe('""');
  });

  it("does not treat a backslash as a metacharacter", () => {
    // Backslash is the Windows path separator; rejecting it would make the
    // shim fallback useless.
    expect(isShellSafeArgument("C:\\Users\\dev\\project")).toBe(true);
  });

  it("rejects arguments that would change a cmd.exe command line", () => {
    for (const argument of ["a&b", "a|b", "a>b", "a<b", "a^b", 'a"b', "a%PATH%b", "a`b", "a$b", "a;b", "a(b", "a)b"]) {
      expect(isShellSafeArgument(argument), argument).toBe(false);
      expect(() => assertShellSafeArguments([argument]), argument).toThrow(UnsafeArgumentError);
    }
  });

  it("refuses the shim fallback rather than building an injectable command line", () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(() => runProcess("ruler", ["apply; rm -rf /"], {
      platform: "win32",
      env: { ComSpec: "cmd.exe" },
      exec: () => { throw missing; }
    })).toThrow(UnsafeArgumentError);
  });
});

describe("Windows .cmd shim fallback", () => {
  it("retries a missing executable through cmd.exe once", () => {
    const attempts = [];
    const result = runProcess("ruler", ["apply", "C:\\Program Files\\app"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      exec: (file, args) => {
        attempts.push({ file, args });
        if (attempts.length === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return "ok";
      }
    });
    expect(result.stdout).toBe("ok");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(attempts[1].args).toEqual(["/d", "/s", "/c", 'ruler apply "C:\\Program Files\\app"']);
  });

  it("does not retry a command that already names a shim", () => {
    const attempts = [];
    expect(() => runProcess("ruler.cmd", [], {
      platform: "win32",
      env: { ComSpec: "cmd.exe" },
      exec: () => { attempts.push(1); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
    })).toThrow(/Required command not found/);
    expect(attempts).toHaveLength(1);
  });

  it("never uses a shell fallback on POSIX", () => {
    const attempts = [];
    expect(() => runProcess("ruler", [], {
      platform: "linux",
      exec: () => { attempts.push(1); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
    })).toThrow(/Required command not found/);
    expect(attempts).toHaveLength(1);
  });

  it("still classifies a Windows failure as an environment error", () => {
    let thrown;
    try {
      runProcess("ruler", [], {
        platform: "win32",
        env: { ComSpec: "cmd.exe" },
        exec: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
      });
    } catch (error) { thrown = error; }
    expect(thrown.name).toBe("EnvironmentError");
    expect(thrown.exitCode).toBe(3);
  });
});

describe("platform naming", () => {
  it("maps each platform to the installer's name for it", () => {
    expect(detectOS("win32")).toBe("windows");
    expect(detectOS("darwin")).toBe("mac");
    expect(detectOS("linux")).toBe("linux");
    expect(detectOS("freebsd")).toBe("linux");
  });
});

describe("path handling is separator-agnostic where findings are produced", () => {
  it("reports analysis paths with forward slashes on every platform", async () => {
    const { default: fs } = await import("node:fs");
    const { default: os } = await import("node:os");
    const { analyzeProject } = await import("../analysis/index.js");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winpaths-"));
    fs.mkdirSync(path.join(dir, "src", "users"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "p", version: "1.0.0",
      dependencies: { "@nestjs/core": "^10.0.0", typeorm: "^0.3.20", pg: "^8.11.0" }
    }));
    fs.writeFileSync(path.join(dir, "src", "users", "svc.ts"), `
      import { Injectable } from "@nestjs/common";
      import { DataSource } from "typeorm";
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        a(q: string) { return this.ds.query(\`SELECT * FROM t WHERE a = '\${q}'\`); }
      }
    `);

    const result = analyzeProject({ cwd: dir });
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.file, finding.file).not.toContain("\\");
      expect(finding.file).toMatch(/^src\/users\/svc\.ts$/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
