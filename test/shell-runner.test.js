import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { runPrefixedCommand, shellInvocation } from "../plugins/ctx/lib/shell-runner.js";

describe("shell runner", () => {
  it("uses ComSpec on Windows instead of spawning sh", () => {
    expect(shellInvocation("npx antigravity-awesome-skills", {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npx antigravity-awesome-skills"]
    });
  });

  it("reports shell ENOENT without crashing the process", async () => {
    const child = fakeChild();
    const promise = runPrefixedCommand("npx antigravity-awesome-skills", {
      platform: "win32",
      env: { ComSpec: "missing-cmd.exe" },
      spawnFn: () => child,
      stdout: sink(),
      stderr: sink()
    });
    const error = new Error("spawn missing-cmd.exe ENOENT");
    error.code = "ENOENT";
    child.emit("error", error);

    await expect(promise).rejects.toThrow("Unable to start shell 'missing-cmd.exe'");
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function sink() {
  return { write() {} };
}
