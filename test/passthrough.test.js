import { describe, expect, it } from "vitest";

import { parsePassthroughArgs, runPassthrough } from "../plugins/ctx/lib/passthrough.js";

describe("passthrough", () => {
  it("parses ruler and skillshare args after separator", () => {
    expect(parsePassthroughArgs(["ruler", "--", "apply", "--agents", "codex"])).toEqual({
      command: "ruler",
      args: ["apply", "--agents", "codex"]
    });
    expect(parsePassthroughArgs(["skillshare", "--", "target", "list"])).toEqual({
      command: "skillshare",
      args: ["target", "list"]
    });
  });

  it("requires an explicit separator", () => {
    expect(() => parsePassthroughArgs(["ruler", "apply"])).toThrow("Usage: backendguard ruler -- <ruler args>");
  });

  it("forwards command args and returns upstream status", () => {
    const calls = [];
    const result = runPassthrough({
      command: "ruler",
      args: ["apply", "--dry-run"],
      cwd: "/tmp/project",
      env: { PATH: "/bin" },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 7, signal: null };
      }
    });

    expect(result.status).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ruler");
    expect(calls[0].args).toEqual(["apply", "--dry-run"]);
    expect(calls[0].options.stdio).toBe("inherit");
    expect(calls[0].options.cwd).toBe("/tmp/project");
  });

  it("prints install hints when upstream binary is missing", () => {
    expect(() => runPassthrough({
      command: "skillshare",
      spawn: () => ({ error: new Error("ENOENT") })
    })).toThrow("Install it with `curl -fsSL");
  });
});
