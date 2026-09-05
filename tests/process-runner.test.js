import { describe, expect, it } from "vitest";

import {
  UnsafeArgumentError,
  assertShellSafeArguments,
  isShellSafeArgument,
  quoteWindowsArgument,
  runProcess,
  spawnProcess
} from "../runtime/process-runner.js";
import { runPassthrough } from "../runtime/passthrough.js";

describe("process runner", () => {
  it("never passes shell: true when running a command with arguments", () => {
    const calls = [];
    runProcess("git", ["diff", "HEAD"], {
      exec: (file, args, options) => {
        calls.push({ file, args, options });
        return "";
      }
    });
    expect(calls[0].file).toBe("git");
    expect(calls[0].args).toEqual(["diff", "HEAD"]);
    expect(calls[0].options.shell).toBeUndefined();
  });

  it("passes a metacharacter-laden argument through untouched instead of to a shell", () => {
    // The whole point: `; rm -rf ~` must arrive as one literal argv entry.
    const evil = "; rm -rf ~";
    let received = null;
    runProcess("git", ["log", evil], {
      exec: (file, args) => {
        received = args;
        return "";
      }
    });
    expect(received).toEqual(["log", evil]);
  });

  it("surfaces a missing executable rather than falling back to a shell on POSIX", () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(() => runProcess("nope", ["x"], {
      platform: "linux",
      exec: () => { throw missing; }
    })).toThrow(/ENOENT/);
  });

  it("retries a missing Windows executable through cmd.exe with quoted arguments", () => {
    const attempts = [];
    const result = runProcess("ruler", ["apply", "C:\\Program Files\\app"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      exec: (file, args) => {
        attempts.push({ file, args });
        if (attempts.length === 1) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        return "done";
      }
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1].file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(attempts[1].args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(attempts[1].args[3]).toBe('ruler apply "C:\\Program Files\\app"');
    expect(result.stdout).toBe("done");
  });

  it("refuses the Windows shell fallback for an argument containing metacharacters", () => {
    expect(() => runProcess("ruler", ["apply", "a && calc.exe"], {
      platform: "win32",
      env: {},
      exec: () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); }
    })).toThrow(UnsafeArgumentError);
  });

  it("classifies shell metacharacters", () => {
    expect(isShellSafeArgument("plain-value_1.2")).toBe(true);
    expect(isShellSafeArgument("/usr/local/bin/x")).toBe(true);
    // Backslash is a Windows path separator, not a metacharacter.
    expect(isShellSafeArgument("C:\\Program Files\\app")).toBe(true);
    for (const bad of ["a;b", "a|b", "a&b", "a`b`", "a$(b)", "a>b", "a\nb", "a%PATH%b", "a^b", 'a"b']) {
      expect(isShellSafeArgument(bad)).toBe(false);
    }
    expect(() => assertShellSafeArguments(["ok", "no;no"])).toThrow(UnsafeArgumentError);
  });

  it("quotes Windows arguments that contain spaces or quotes", () => {
    expect(quoteWindowsArgument("simple")).toBe("simple");
    expect(quoteWindowsArgument("with space")).toBe('"with space"');
    expect(quoteWindowsArgument("")).toBe('""');
  });

  it("spawnProcess passes argv directly on POSIX", () => {
    let seen = null;
    spawnProcess("node", ["-e", "1;2"], {
      platform: "linux",
      spawnFn: (file, args, options) => {
        seen = { file, args, options };
        return {};
      }
    });
    expect(seen.file).toBe("node");
    expect(seen.args).toEqual(["-e", "1;2"]);
    expect(seen.options.shell).toBeUndefined();
  });
});

describe("passthrough", () => {
  it("forwards user arguments to the third-party CLI without a shell", () => {
    let seen = null;
    runPassthrough({
      command: "ruler",
      args: ["apply", "; touch /tmp/pwned"],
      spawn: (command, args, options) => {
        seen = { command, args, options };
        return { status: 0 };
      }
    });
    expect(seen.options.shell).toBeUndefined();
    expect(seen.args).toEqual(["apply", "; touch /tmp/pwned"]);
  });
});
