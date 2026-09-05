import { describe, expect, it } from "vitest";

import { createRegistry } from "../analysis/analyzer-registry.js";
import { analyzeProject, defaultAnalyzers } from "../analysis/index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

const noop = { id: "noop", analyze: () => [] };

describe("analyzer registry", () => {
  it("rejects an analyzer with no id or no analyze()", () => {
    expect(() => createRegistry([{ analyze: () => [] }])).toThrow(/non-empty string id/);
    expect(() => createRegistry([{ id: "x" }])).toThrow(/must implement analyze/);
  });

  it("rejects a duplicate id so two analyzers cannot silently shadow each other", () => {
    expect(() => createRegistry([noop, { id: "noop", analyze: () => [] }])).toThrow(/already registered/);
  });

  it("skips analyzers whose appliesTo rejects the project", () => {
    const registry = createRegistry([
      { id: "always", analyze: () => [{ id: "A", file: "a.ts", line: 1, severity: "LOW", confidence: "low" }] },
      { id: "never", appliesTo: () => false, analyze: () => [{ id: "B", file: "b.ts", line: 1, severity: "LOW", confidence: "low" }] }
    ]);
    const result = registry.run({ stack: {} });
    expect(result.ran).toEqual(["always"]);
    expect(result.findings.map((finding) => finding.id)).toEqual(["A"]);
  });

  it("stamps the analyzer id onto findings that do not carry one", () => {
    const registry = createRegistry([
      { id: "tagger", analyze: () => [{ id: "A", file: "a.ts", line: 1, severity: "LOW", confidence: "low" }] }
    ]);
    expect(registry.run({}).findings[0].analyzer).toBe("tagger");
  });

  it("keeps other analyzers' findings when one throws, and reports the failure", () => {
    const registry = createRegistry([
      { id: "broken", analyze: () => { throw new Error("parser exploded"); } },
      { id: "healthy", analyze: () => [{ id: "A", file: "a.ts", line: 1, severity: "HIGH", confidence: "high" }] }
    ]);
    const result = registry.run({});
    expect(result.findings).toHaveLength(1);
    expect(result.ran).toEqual(["healthy"]);
    expect(result.errors).toEqual([{ analyzer: "broken", message: "parser exploded" }]);
  });

  it("treats an appliesTo that throws as not applicable rather than crashing the run", () => {
    const registry = createRegistry([
      { id: "unstable", appliesTo: () => { throw new Error("bad stack"); }, analyze: () => [] }
    ]);
    expect(registry.run({}).ran).toEqual([]);
  });

  it("orders findings by severity then confidence, deterministically", () => {
    const registry = createRegistry([{
      id: "many",
      analyze: () => [
        { id: "C", file: "c.ts", line: 1, severity: "LOW", confidence: "high" },
        { id: "A", file: "a.ts", line: 1, severity: "CRITICAL", confidence: "low" },
        { id: "B", file: "b.ts", line: 1, severity: "HIGH", confidence: "certain" }
      ]
    }]);
    expect(registry.run({}).findings.map((finding) => finding.id)).toEqual(["A", "B", "C"]);
  });
});

describe("analysis pipeline", () => {
  it("registers one analyzer per id with no duplicates", () => {
    const seen = new Set();
    for (const analyzer of defaultAnalyzers) {
      expect(seen.has(analyzer.id)).toBe(false);
      seen.add(analyzer.id);
      expect(typeof analyzer.analyze).toBe("function");
      expect(Array.isArray(analyzer.categories)).toBe(true);
    }
  });

  it("routes ORM analyzers by detected stack, not by guesswork", () => {
    const prismaRepo = writeFiles(makeFixture("pipeline-prisma"), {
      "package.json": JSON.stringify({ name: "p", dependencies: { "@prisma/client": "^5.0.0", "@nestjs/core": "^10.0.0" } }),
      "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "src/a.service.ts": "export class A {}"
    });
    const prismaResult = analyzeProject({ cwd: prismaRepo });
    expect(prismaResult.ran).toContain("prisma");
    expect(prismaResult.ran).not.toContain("typeorm");

    const typeormRepo = writeFiles(makeFixture("pipeline-typeorm"), {
      "package.json": JSON.stringify({ name: "t", dependencies: { typeorm: "^0.3.0", pg: "^8.0.0" } }),
      "src/a.service.ts": "export class A {}"
    });
    const typeormResult = analyzeProject({ cwd: typeormRepo });
    expect(typeormResult.ran).toContain("typeorm");
    expect(typeormResult.ran).not.toContain("prisma");
  });

  it("returns no findings for a project with no source files", () => {
    const empty = writeFiles(makeFixture("pipeline-empty"), { "package.json": "{}" });
    const result = analyzeProject({ cwd: empty });
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("converts findings into renderable compliance items with evidence", async () => {
    const { toComplianceItems } = await import("../analysis/index.js");
    const items = toComplianceItems([{
      id: "SEC-003",
      analyzer: "nestjs-security",
      category: "Security",
      severity: "HIGH",
      confidence: "certain",
      title: "Hardcoded secret literal",
      detail: "detail",
      evidence: "secret: \"abc\"",
      remediation: "fix",
      file: "src/a.ts",
      line: 12
    }]);
    expect(items[0]).toMatchObject({
      status: "ignored",
      kind: "structural",
      evidence: "src/a.ts:12"
    });
    expect(items[0].rule).toMatchObject({ id: "SEC-003", severity: "HIGH", confidence: "certain" });
  });
});
