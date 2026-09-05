import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildStackReport, detectStack, findProjectRoot, formatStackReport } from "../analysis/stack-detector.js";

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

describe("backend stack detection: evidence", () => {
  it("records the dependency or file each detection is based on", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "evidence-api",
      dependencies: { "@nestjs/core": "^11.0.0", typeorm: "^0.3.0", pg: "^8.11.0" }
    }));
    fs.writeFileSync(path.join(repo, "Dockerfile"), "FROM node:20\n");

    const stack = buildStackReport(repo);
    expect(stack.evidence.framework).toEqual([
      { kind: "dependency", value: "@nestjs/core", source: "package.json" }
    ]);
    expect(stack.evidence.orm.map((item) => item.value)).toContain("typeorm");
    expect(stack.evidence.containerization).toEqual([
      { kind: "file", value: "Dockerfile", source: "Dockerfile" }
    ]);

    const formatted = formatStackReport(stack, { showEvidence: true });
    expect(formatted).toContain('dependency "@nestjs/core" in package.json');
    expect(formatted).toContain("file Dockerfile");
  });

  it("detects PostgreSQL from a docker-compose image when no pg dependency is declared", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "compose-api", dependencies: {} }));
    fs.writeFileSync(path.join(repo, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n");

    const stack = buildStackReport(repo);
    expect(stack.database).toBe("PostgreSQL");
    expect(stack.cache).toBe("Redis");
    expect(stack.evidence.database[0].kind).toBe("content");
  });

  it("does not detect a technology that is only mentioned in prose", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "docs-only", dependencies: {} }));
    fs.writeFileSync(path.join(repo, "README.md"), "# Docs\n\nWe use NestJS, Prisma, PostgreSQL, TypeORM and Redis here.\n");

    const stack = buildStackReport(repo);
    expect(stack.framework).toBeNull();
    expect(stack.orm).toBeNull();
    expect(stack.database).toBeNull();
    expect(stack.cache).toBeNull();
  });

  it("describes the nested package a command is run inside, not the outer repository", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "monorepo-root", dependencies: {} }));
    const service = path.join(repo, "services", "billing");
    fs.mkdirSync(service, { recursive: true });
    fs.writeFileSync(path.join(service, "package.json"), JSON.stringify({
      name: "billing", dependencies: { "@nestjs/core": "^11.0.0", typeorm: "^0.3.0", pg: "^8.11.0" }
    }));

    // The root is resolved to the nested package, not to the .git directory
    // above it, so `backendguard stack` inside one service of a monorepo
    // describes that service.
    const nested = detectStack({ cwd: service });
    expect(nested.root).toBe(service);
    expect(nested.framework).toBe("NestJS");
    expect(nested.evidence.framework[0].source).toBe("package.json");
  });

  it("distinguishes Prisma from TypeORM rather than reporting both", () => {
    const prismaRepo = makeRepo();
    fs.writeFileSync(path.join(prismaRepo, "package.json"), JSON.stringify({
      name: "prisma-api", dependencies: { "@prisma/client": "^6.0.0" }
    }));
    expect(buildStackReport(prismaRepo).orm).toBe("Prisma");

    const typeormRepo = makeRepo();
    fs.writeFileSync(path.join(typeormRepo, "package.json"), JSON.stringify({
      name: "typeorm-api", dependencies: { typeorm: "^0.3.0" }
    }));
    expect(buildStackReport(typeormRepo).orm).toBe("TypeORM");
  });
});

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-stack-"));
  fs.mkdirSync(path.join(repo, ".git"));
  return repo;
}
