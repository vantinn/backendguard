import { describe, expect, it } from "vitest";

import { analyzeProject } from "../analysis/index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

/**
 * The allow-list map is the documented remedy for a dynamic ORDER BY, which
 * cannot be bound as a parameter. Reporting it as a CRITICAL injection at high
 * confidence flags the correct fix as the bug — the most expensive kind of
 * false positive, because it teaches users to ignore CRITICAL findings.
 *
 * Interpolating anything that is *not* provably a compile-time constant must
 * still be CRITICAL; the tests below pin both directions.
 */

const PKG = JSON.stringify({
  name: "sql-fixture",
  version: "1.0.0",
  dependencies: { "@nestjs/core": "^10.0.0", typeorm: "^0.3.20", pg: "^8.11.0" }
});

function sqlFindings(source) {
  const dir = makeFixture("sql-interp");
  writeFiles(dir, { "package.json": PKG, "src/svc.ts": source });
  return analyzeProject({ cwd: dir }).findings.filter((f) => f.id === "TORM-008");
}

const HEAD = `
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
`;

describe("TORM-008 does not flag compile-time constant interpolation", () => {
  const safe = {
    "allow-list map lookup": `
      const ALLOWED = { name: "name", total: "total" } as const;
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        sorted(c: keyof typeof ALLOWED) { return this.ds.query(\`SELECT * FROM o ORDER BY \${ALLOWED[c]}\`); }
      }`,
    "constant table name": `
      const TABLE = "orders";
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        all() { return this.ds.query(\`SELECT * FROM \${TABLE}\`); }
      }`,
    "constant map property access": `
      const COLS = { a: "col_a" };
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        one() { return this.ds.query(\`SELECT \${COLS.a} FROM o\`); }
      }`,
    "several constants": `
      const TABLE = "orders";
      const ORDER = { asc: "ASC" };
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        all() { return this.ds.query(\`SELECT * FROM \${TABLE} ORDER BY id \${ORDER.asc}\`); }
      }`
  };

  for (const [name, body] of Object.entries(safe)) {
    it(`stays quiet on ${name}`, () => {
      expect(sqlFindings(HEAD + body), name).toEqual([]);
    });
  }
});

describe("TORM-008 still reports interpolation that is not constant", () => {
  const unsafe = {
    "parameter interpolated": `
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        byName(n: string) { return this.ds.query(\`SELECT * FROM o WHERE n = '\${n}'\`); }
      }`,
    "mutable let map": `
      let ALLOWED = { name: "name" };
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        sorted(c: string) { return this.ds.query(\`SELECT * FROM o ORDER BY \${ALLOWED[c]}\`); }
      }`,
    "map with non-literal values": `
      const ALLOWED = { name: process.env.COL };
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        sorted(c: string) { return this.ds.query(\`SELECT * FROM o ORDER BY \${ALLOWED[c]}\`); }
      }`,
    "constant plus a parameter": `
      const TABLE = "orders";
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        byName(n: string) { return this.ds.query(\`SELECT * FROM \${TABLE} WHERE n = '\${n}'\`); }
      }`,
    "string concatenation": `
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        byStatus(s: string) { return this.ds.query("SELECT * FROM o WHERE s = '" + s + "'"); }
      }`,
    "queryBuilder where interpolation": `
      import { Repository } from "typeorm";
      @Injectable() export class S {
        constructor(private readonly repo: Repository<any>) {}
        find(q: string) { return this.repo.createQueryBuilder("o").where(\`o.n = '\${q}'\`).getMany(); }
      }`,
    "function call interpolated": `
      @Injectable() export class S {
        constructor(private readonly ds: DataSource) {}
        go(c: string) { return this.ds.query(\`SELECT * FROM o ORDER BY \${String(c)}\`); }
      }`
  };

  for (const [name, body] of Object.entries(unsafe)) {
    it(`still reports ${name}`, () => {
      const findings = sqlFindings(HEAD + body);
      expect(findings.length, name).toBeGreaterThan(0);
      expect(findings[0].severity, name).toBe("CRITICAL");
    });
  }
});
