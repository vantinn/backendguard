import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkCompliance, parseGitDiff, readGitSnapshot } from "../plugins/ctx/lib/measure.js";

describe("measure", () => {
  it("parses changed files and added lines from git diff", () => {
    const snapshot = parseGitDiff(`diff --git a/src/user.ts b/src/user.ts
--- a/src/user.ts
+++ b/src/user.ts
@@ -1 +1,2 @@
+import { z } from "zod";
+console.log("debug");
`);

    expect(snapshot.changedFiles).toEqual(["src/user.ts"]);
    expect(snapshot.addedLines.map((line) => line.content)).toContain('import { z } from "zod";');
    expect(snapshot.addedLines[0]).toMatchObject({ file: "src/user.ts", line: 1 });
  });

  it("marks positive and negative compliance with simple keyword evidence", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always use `zod` validation.", score: 1 },
        { content: "Never use `console.log` in committed code.", score: 1 }
      ],
      addedLines: [
        { file: "src/user.ts", content: 'import { z } from "zod";' },
        { file: "src/user.ts", content: "console.log('debug');" }
      ]
    });

    expect(results[0]).toMatchObject({ status: "followed" });
    expect(results[1]).toMatchObject({ status: "ignored" });
    expect(results[0].evidence).toContain("src/user.ts");
    expect(results[1].matchedLines[0].content).toContain("console.log");
  });

  it("does not treat generic prose words as compliance evidence", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always use code-review-graph before reading files." }
      ],
      addedLines: [
        { file: "src/user.ts", content: "this file changed" }
      ]
    });

    expect(results[0]).toMatchObject({ status: "unmeasurable" });
    expect(results[0].evidence).not.toContain("this");
  });

  it("marks runtime-only workflow rules unmeasurable without telemetry source", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always use `code-review-graph` before reading files.", score: 1 }
      ],
      addedLines: [
        { file: "src/user.ts", line: 10, content: "const user = await repo.findUser();" }
      ]
    });

    expect(results[0]).toMatchObject({
      status: "unmeasurable",
      kind: "runtime"
    });
    expect(results[0].evidence).toContain("runtime/tool-call telemetry");
  });

  it("marks runtime-only workflow rules unknown when telemetry exists but does not match", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always use `code-review-graph` before reading files.", score: 1 }
      ],
      addedLines: [
        { file: "src/user.ts", line: 10, content: "const user = await repo.findUser();" }
      ],
      runtimeEvidence: {
        sources: [{ event: "McpToolCall" }],
        toolSignals: ["agentmemory.memory_recall"],
        commandSignals: [],
        signals: ["agentmemory"]
      }
    });

    expect(results[0]).toMatchObject({
      status: "unknown",
      kind: "runtime"
    });
    expect(results[0].evidence).toContain("no matching runtime signal");
  });

  it("marks runtime-only workflow rules followed when telemetry has tool signals", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always use `code-review-graph` before reading files.", score: 1 }
      ],
      addedLines: [
        { file: "src/user.ts", line: 10, content: "const user = await repo.findUser();" }
      ],
      runtimeEvidence: {
        toolSignals: ["code-review-graph.semantic_search_nodes"],
        commandSignals: [],
        signals: ["code-review-graph", "semantic_search_nodes"]
      }
    });

    expect(results[0]).toMatchObject({
      status: "followed",
      kind: "runtime"
    });
    expect(results[0].evidence).toContain("runtime telemetry observed code-review-graph");
  });

  it("does not flag a required clause's own keyword as a forbidden violation in a compound rule (Gap 1)", () => {
    const results = checkCompliance({
      rules: [
        { content: "Hash passwords with bcrypt or argon2 with an adequate cost factor. Never store plaintext or reversible-encrypted passwords." }
      ],
      addedLines: [
        { file: "src/auth/auth.service.ts", line: 34, content: "const passwordHash = await bcrypt.hash(password, 10);" }
      ]
    });

    expect(results[0].status).not.toBe("ignored");
  });

  it("still catches a real violation of the forbidden clause in a compound rule (Gap 1)", () => {
    const results = checkCompliance({
      rules: [
        { content: "Hash passwords with bcrypt or argon2 with an adequate cost factor. Never store plaintext or reversible-encrypted passwords." }
      ],
      addedLines: [
        { file: "src/auth/auth.service.ts", line: 34, content: "user.password = plaintext;" }
      ]
    });

    expect(results[0]).toMatchObject({ status: "ignored", kind: "forbidden" });
  });

  it("does not match a keyword as a substring inside an unrelated identifier (Gap 2)", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always apply rate limiting to public authentication endpoints." }
      ],
      addedLines: [
        // "rate" is a substring of "Generated" here but must not count as evidence.
        { file: "src/users/user.entity.ts", line: 1, content: "@PrimaryGeneratedColumn() id: string;" }
      ]
    });

    expect(results[0].status).not.toBe("followed");
  });

  it("still matches a keyword that genuinely appears as its own word (Gap 2 regression guard)", () => {
    const results = checkCompliance({
      rules: [
        { content: "Always apply rate limiting to public authentication endpoints." }
      ],
      addedLines: [
        { file: "src/auth/auth.controller.ts", line: 5, content: "// apply rate limiting via a decorator" }
      ]
    });

    expect(results[0]).toMatchObject({ status: "followed" });
  });

  it("uses readable file content when git diff HEAD is unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-status-snapshot-"));
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" } }, null, 2));

    const snapshot = readGitSnapshot({ cwd: tmp });

    expect(snapshot.mode).toBe("status");
    expect(snapshot.changedFiles).toContain("package.json");
    expect(snapshot.addedLines.some((line) => line.content.includes("zod"))).toBe(true);
  });
});
