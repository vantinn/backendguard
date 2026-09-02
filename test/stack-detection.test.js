import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildStackReport, detectStack, formatStackReport } from "../plugins/ctx/lib/project-context-generator.js";

describe("backend stack detection", () => {
  it("detects a NestJS + PostgreSQL + Prisma + Redis backend from package.json and schema evidence", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "nest-api",
      dependencies: {
        "@nestjs/core": "^11.0.0",
        "@nestjs/jwt": "^11.0.0",
        "@prisma/client": "^6.0.0",
        prisma: "^6.0.0",
        redis: "^5.0.0",
        "class-validator": "^0.14.0"
      },
      devDependencies: {
        typescript: "^5.5.0",
        jest: "^30.0.0"
      }
    }, null, 2));
    fs.mkdirSync(path.join(repo, "prisma"));
    fs.writeFileSync(path.join(repo, "prisma", "schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n');
    fs.writeFileSync(path.join(repo, "Dockerfile"), "FROM node:20\n");

    const stack = buildStackReport(repo);
    expect(stack.framework).toBe("NestJS");
    expect(stack.language).toBe("TypeScript");
    expect(stack.database).toBe("PostgreSQL");
    expect(stack.orm).toBe("Prisma");
    expect(stack.cache).toBe("Redis");
    expect(stack.containerization).toBe("Docker");
    expect(stack.authentication).toBe("JWT");
    expect(stack.testing).toBeTruthy();

    const formatted = formatStackReport(stack);
    expect(formatted).toContain("NestJS");
    expect(formatted).toContain("PostgreSQL");
    expect(formatted).not.toContain("Not detected: Framework");
  });

  it("does not claim technologies with no evidence in the repo", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "empty-repo",
      dependencies: {}
    }, null, 2));

    const stack = detectStack({ cwd: repo });
    expect(stack.framework).toBeNull();
    expect(stack.database).toBeNull();
    expect(stack.orm).toBeNull();

    const formatted = formatStackReport(stack);
    expect(formatted).toContain("Not detected: Framework");
    expect(formatted).toContain("Database");
    expect(formatted).not.toContain("NestJS");
  });

  it("reports no evidence at all for a directory with no package.json", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-stack-empty-"));
    fs.mkdirSync(path.join(repo, ".git"));
    const formatted = formatStackReport(detectStack({ cwd: repo }));
    expect(formatted).toContain("No backend stack evidence detected");
  });

  it("does not leak dependencies from a nested test-fixture package.json into the root report", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "plain-cli-tool",
      dependencies: { commander: "^12.0.0" }
    }, null, 2));
    // This mirrors the real bug reproduced against this repo's own eval/skill-routing/fixtures/:
    // a nested fixture package.json should never leak its dependencies into the root stack report.
    const fixtureDir = path.join(repo, "eval", "fixtures", "nest-prisma-example");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
      name: "unrelated-fixture",
      dependencies: {
        "@nestjs/core": "^11.0.0",
        "@nestjs/jwt": "^11.0.0",
        "@prisma/client": "^6.0.0",
        redis: "^5.0.0"
      }
    }, null, 2));

    const stack = buildStackReport(repo);
    expect(stack.framework).toBeNull();
    expect(stack.orm).toBeNull();
    expect(stack.cache).toBeNull();
    expect(stack.authentication).toBeNull();
  });

  it("detects TypeORM + PostgreSQL from ormconfig and typeorm dependency", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "typeorm-api",
      dependencies: {
        "@nestjs/core": "^11.0.0",
        "@nestjs/typeorm": "^11.0.0",
        typeorm: "^0.3.0",
        pg: "^8.11.0"
      }
    }, null, 2));

    const stack = buildStackReport(repo);
    expect(stack.orm).toBe("TypeORM");
    expect(stack.database).toBe("PostgreSQL");
  });
});

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-stack-"));
  fs.mkdirSync(path.join(repo, ".git"));
  return repo;
}
