import { describe, expect, it } from "vitest";

import { analyzeSqlText, postgresqlAnalyzer } from "../analysis/database/postgresql-analyzer.js";
import { buildSourceIndex } from "../analysis/source-index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

const PG_STACK = { database: "PostgreSQL", platforms: ["postgresql"] };

function analyzeSources(files) {
  const cwd = makeFixture("postgres");
  writeFiles(cwd, files);
  return postgresqlAnalyzer.analyze({ cwd, index: buildSourceIndex({ cwd }), stack: PG_STACK });
}

function ids(findings, id) {
  return findings.filter((finding) => finding.id === id);
}

describe("postgresql analyzer: applicability", () => {
  it("only runs against a PostgreSQL stack", () => {
    expect(postgresqlAnalyzer.appliesTo({ stack: PG_STACK })).toBe(true);
    expect(postgresqlAnalyzer.appliesTo({ stack: { database: "MongoDB", platforms: ["mongodb"] } })).toBe(false);
  });
});

describe("postgresql analyzer: migration safety", () => {
  it("PG-001 flags ADD COLUMN NOT NULL with no default", () => {
    const findings = analyzeSqlText(`ALTER TABLE "user" ADD COLUMN "status" varchar NOT NULL;`, "migrations/001.sql");
    expect(ids(findings, "PG-001")).toHaveLength(1);
  });

  it("PG-001 accepts the same column added with a default", () => {
    const findings = analyzeSqlText(`ALTER TABLE "user" ADD COLUMN "status" varchar NOT NULL DEFAULT 'active';`, "migrations/001.sql");
    expect(ids(findings, "PG-001")).toHaveLength(0);
  });

  it("PG-001 accepts a constraint added NOT VALID", () => {
    const invalid = `ALTER TABLE "order" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "user"("id");`;
    const staged = `ALTER TABLE "order" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "user"("id") NOT VALID;`;
    expect(ids(analyzeSqlText(invalid, "migrations/002.sql"), "PG-001")).toHaveLength(1);
    expect(ids(analyzeSqlText(staged, "migrations/002.sql"), "PG-001")).toHaveLength(0);
  });

  it("PG-002 flags CREATE INDEX and accepts CONCURRENTLY", () => {
    expect(ids(analyzeSqlText(`CREATE INDEX "i" ON "user" ("email");`, "migrations/003.sql"), "PG-002")).toHaveLength(1);
    expect(ids(analyzeSqlText(`CREATE INDEX CONCURRENTLY "i" ON "user" ("email");`, "migrations/003.sql"), "PG-002")).toHaveLength(0);
  });

  it("PG-003 flags an UPDATE with no WHERE and accepts a scoped one", () => {
    expect(ids(analyzeSqlText(`UPDATE "user" SET "status" = 'x';`, "migrations/004.sql"), "PG-003")).toHaveLength(1);
    expect(ids(analyzeSqlText(`UPDATE "user" SET "status" = 'x' WHERE "id" = 1;`, "migrations/004.sql"), "PG-003")).toHaveLength(0);
  });

  it("ignores comment lines", () => {
    const findings = analyzeSqlText(`-- CREATE INDEX "i" ON "user" ("email");`, "migrations/005.sql");
    expect(findings).toHaveLength(0);
  });

  it("does not apply migration-only checks to a non-migration SQL file", () => {
    const findings = analyzeSqlText(`CREATE INDEX "i" ON "user" ("email");`, "sql/report.sql");
    expect(ids(findings, "PG-002")).toHaveLength(0);
  });
});

describe("postgresql analyzer: connection pool", () => {
  it("PG-010 flags a pool with no max and accepts a sized pool", () => {
    const unbounded = analyzeSources({
      "src/db.ts": `import { Pool } from "pg";\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL });`
    });
    expect(ids(unbounded, "PG-010")).toHaveLength(1);

    const sized = analyzeSources({
      "src/db.ts": `import { Pool } from "pg";\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });`
    });
    expect(ids(sized, "PG-010")).toHaveLength(0);
    expect(ids(sized, "PG-011")).toHaveLength(0);
  });

  it("PG-011 flags a sized pool with no idle timeout", () => {
    const findings = analyzeSources({
      "src/db.ts": `import { Pool } from "pg";\nexport const pool = new Pool({ max: 10 });`
    });
    expect(ids(findings, "PG-011")).toHaveLength(1);
  });
});

describe("postgresql analyzer: inline SQL", () => {
  it("PG-012 flags an interpolated statement and leaves a tagged template alone", () => {
    const findings = analyzeSources({
      "src/report.ts": `
        export function build(status: string, id: string) {
          const bad = \`SELECT * FROM orders WHERE status = '\${status}'\`;
          const good = sql\`SELECT * FROM orders WHERE id = \${id}\`;
          return [bad, good];
        }
      `
    });
    expect(ids(findings, "PG-012")).toHaveLength(1);
  });

  it("does not flag a template literal that is not SQL", () => {
    const findings = analyzeSources({
      "src/log.ts": `export const message = (user: string) => \`updated profile for \${user} where possible\`;`
    });
    expect(ids(findings, "PG-012")).toHaveLength(0);
  });
});
