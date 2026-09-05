import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { findExplicitPromptFiles } from "../retrieval/file-retriever.js";

/**
 * The prompt hook runs on every message the user sends to their agent, so any
 * super-linear cost in it is a denial of service against the user's own
 * editor.
 *
 * `findExplicitPromptFiles` matched path-like tokens with
 * `[chars]+(?:\/[chars]+)+`. On a long run of those characters containing no
 * `/` — a base64 blob, a minified line, a stack trace pasted into the prompt —
 * the engine backtracks over every split point, which is quadratic: 100 KB
 * took 8s of CPU and 500 KB took over 200s. The hook's 8.5s deadline could not
 * save it, because a `setTimeout` cannot fire while synchronous work holds the
 * event loop.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = [];
afterAll(() => temp.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function elapsed(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("findExplicitPromptFiles is linear in the size of the prompt", () => {
  const shapes = {
    "one long token with no slash": (n) => "x".repeat(n),
    "long token of path characters": (n) => "a.b-c_d".repeat(Math.ceil(n / 7)).slice(0, n),
    "base64 blob": (n) => "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(Math.ceil(n / 34)).slice(0, n),
    "long token with a trailing slash": (n) => `${"x".repeat(n)}/`,
    "many short tokens": (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n)
  };

  for (const [name, build] of Object.entries(shapes)) {
    it(`handles ${name} without blowing up`, () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "redos-"));
      temp.push(cwd);
      const small = elapsed(() => findExplicitPromptFiles({ cwd, task: build(25_000) }));
      const large = elapsed(() => findExplicitPromptFiles({ cwd, task: build(200_000) }));

      // 8x the input must not cost anything like 64x the time.
      expect(large, `${name}: 200KB took ${large.toFixed(0)}ms`).toBeLessThan(1000);
      expect(small, `${name}: 25KB took ${small.toFixed(0)}ms`).toBeLessThan(250);
    });
  }
});

describe("findExplicitPromptFiles still finds the paths it is for", () => {
  function fixtureWith(files) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
    temp.push(cwd);
    for (const file of files) {
      const full = path.join(cwd, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "export const x = 1;\n");
    }
    return cwd;
  }

  it("finds a path mentioned in the prompt", () => {
    const cwd = fixtureWith(["src/users/user.service.ts"]);
    const found = findExplicitPromptFiles({ cwd, task: "please fix src/users/user.service.ts today" });
    expect(found.map((entry) => entry.path)).toContain("src/users/user.service.ts");
  });

  it("finds a path surrounded by punctuation", () => {
    const cwd = fixtureWith(["src/app.module.ts"]);
    const found = findExplicitPromptFiles({ cwd, task: "see `src/app.module.ts`, then stop." });
    expect(found.map((entry) => entry.path)).toContain("src/app.module.ts");
  });

  it("finds several paths in one prompt", () => {
    const cwd = fixtureWith(["src/a.ts", "src/nested/b.ts"]);
    const found = findExplicitPromptFiles({ cwd, task: "update src/a.ts and src/nested/b.ts" });
    const paths = found.map((entry) => entry.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/nested/b.ts");
  });

  it("returns nothing for a prompt with no paths", () => {
    const cwd = fixtureWith(["src/a.ts"]);
    expect(findExplicitPromptFiles({ cwd, task: "add authentication to the service" })).toEqual([]);
  });

  it("ignores a path that does not exist", () => {
    const cwd = fixtureWith(["src/a.ts"]);
    expect(findExplicitPromptFiles({ cwd, task: "open src/does/not/exist.ts" })).toEqual([]);
  });
});

describe("the prompt hook answers a hostile prompt quickly", () => {
  it("returns within the hook deadline for a 400KB single-token prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hookhome-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hookproj-"));
    temp.push(home, cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"p","version":"1.0.0"}');

    const hook = path.join(repoRoot, "plugins", "backendguard", "bin", "on-prompt.js");
    const payload = JSON.stringify({ prompt: "x".repeat(400_000), cwd });

    const started = Date.now();
    const stdout = execFileSync(process.execPath, [hook], {
      cwd, input: payload, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        BACKENDGUARD_HOME: path.join(home, ".ctx"), CODEX_HOME: path.join(home, ".codex"),
        BACKENDGUARD_SKIP_UPDATE_CHECK: "1" }
    });
    const took = Date.now() - started;

    expect(took, `hook took ${took}ms`).toBeLessThan(30_000);
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  }, 90_000);
});
