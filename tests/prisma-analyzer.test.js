import { describe, expect, it } from "vitest";

import { analyzeSchemaText, prismaAnalyzer } from "../analysis/database/prisma-analyzer.js";
import { parsePrismaSchema } from "../analysis/database/prisma-schema.js";
import { buildSourceIndex } from "../analysis/source-index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

const PRISMA_STACK = { orm: "Prisma", platforms: ["prisma"] };

function analyzeSources(files) {
  const cwd = makeFixture("prisma");
  writeFiles(cwd, files);
  return prismaAnalyzer.analyze({ cwd, index: buildSourceIndex({ cwd }), stack: PRISMA_STACK });
}

function ids(findings, id) {
  return findings.filter((finding) => finding.id === id);
}

describe("prisma schema parser", () => {
  it("parses datasource, models, fields and block attributes with line numbers", () => {
    const schema = parsePrismaSchema(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id      String @id
  userId  String
  total   Float
  @@index([userId])
}
`);
    expect(schema.datasources[0]).toMatchObject({ name: "db", provider: "postgresql", url: 'env("DATABASE_URL")' });
    const order = schema.models.find((model) => model.name === "Order");
    expect(order.fields.map((field) => field.name)).toEqual(["id", "userId", "total"]);
    expect(order.fields[0].attributes).toContain("@id");
    expect(order.attributes[0].text).toBe("@@index([userId])");
    expect(order.fields[1].line).toBeGreaterThan(order.line);
  });

  it("ignores comments", () => {
    const schema = parsePrismaSchema(`
model User {
  // email String
  id String @id
}
`);
    expect(schema.models[0].fields.map((field) => field.name)).toEqual(["id"]);
  });
});

describe("prisma analyzer: applicability", () => {
  it("only runs against a Prisma stack", () => {
    expect(prismaAnalyzer.appliesTo({ stack: PRISMA_STACK })).toBe(true);
    expect(prismaAnalyzer.appliesTo({ stack: { orm: "TypeORM", platforms: ["typeorm"] } })).toBe(false);
  });
});

describe("prisma analyzer: schema checks", () => {
  it("PRISMA-001 flags a relation scalar with no index and not a unique/id field", () => {
    const findings = analyzeSchemaText(`
model Order {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
`, "prisma/schema.prisma");
    expect(ids(findings, "PRISMA-001")).toHaveLength(1);
  });

  it("PRISMA-001 does not flag a relation scalar covered by @@index", () => {
    const findings = analyzeSchemaText(`
model Order {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])

  @@index([userId])
}
`, "prisma/schema.prisma");
    expect(ids(findings, "PRISMA-001")).toHaveLength(0);
  });

  it("PRISMA-002 flags an un-unique email and leaves a @unique sku alone", () => {
    const findings = analyzeSchemaText(`
model User {
  id    String @id
  email String
}

model Product {
  id  String @id
  sku String @unique
}
`, "prisma/schema.prisma");
    const flagged = ids(findings, "PRISMA-002");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].detail).toContain("User.email");
  });

  it("PRISMA-003 flags monetary Float fields only", () => {
    const findings = analyzeSchemaText(`
model Order {
  id       String  @id
  total    Float
  latitude Float
}
`, "prisma/schema.prisma");
    const flagged = ids(findings, "PRISMA-003");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].detail).toContain("total");
  });

  it("PRISMA-005 flags a hardcoded datasource URL and accepts env()", () => {
    const hardcoded = analyzeSchemaText(`
datasource db {
  provider = "postgresql"
  url      = "postgresql://admin:hunter2@db.internal:5432/app"
}
`, "prisma/schema.prisma");
    expect(ids(hardcoded, "PRISMA-005")).toHaveLength(1);

    const fromEnv = analyzeSchemaText(`
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`, "prisma/schema.prisma");
    expect(ids(fromEnv, "PRISMA-005")).toHaveLength(0);
  });
});

describe("prisma analyzer: client call sites", () => {
  it("PRISMA-010 flags findMany with no take/cursor and accepts a paginated call", () => {
    const findings = analyzeSources({
      "src/a.service.ts": `
        export class A {
          constructor(private readonly prisma: PrismaService) {}
          all() { return this.prisma.order.findMany({ where: { status: "open" } }); }
          page(cursor: string) { return this.prisma.order.findMany({ take: 20, cursor: { id: cursor } }); }
        }
      `
    });
    expect(ids(findings, "PRISMA-010")).toHaveLength(1);
  });

  it("PRISMA-011 flags a Prisma read inside a loop and not outside one", () => {
    const findings = analyzeSources({
      "src/b.service.ts": `
        export class B {
          constructor(private readonly prisma: PrismaService) {}
          async loop(ids: string[]) {
            for (const id of ids) { await this.prisma.user.findUnique({ where: { id } }); }
          }
          async single(id: string) { return this.prisma.user.findUnique({ where: { id } }); }
        }
      `
    });
    expect(ids(findings, "PRISMA-011")).toHaveLength(1);
  });

  it("PRISMA-013 flags the unsafe raw API and leaves the tagged-template form alone", () => {
    const findings = analyzeSources({
      "src/c.service.ts": `
        export class C {
          constructor(private readonly prisma: PrismaService) {}
          unsafe(status: string) { return this.prisma.$queryRawUnsafe(\`SELECT 1 WHERE s='\${status}'\`); }
          safe(id: string) { return this.prisma.$queryRaw\`SELECT 1 WHERE id = \${id}\`; }
        }
      `
    });
    expect(ids(findings, "PRISMA-013")).toHaveLength(1);
  });

  it("PRISMA-014 flags two writes with no $transaction and accepts the transactional form", () => {
    const findings = analyzeSources({
      "src/d.service.ts": `
        export class D {
          constructor(private readonly prisma: PrismaService) {}
          async loose(a: string, b: string) {
            await this.prisma.order.update({ where: { id: a }, data: {} });
            await this.prisma.user.update({ where: { id: b }, data: {} });
          }
          async wrapped(a: string, b: string) {
            return this.prisma.$transaction(async (tx) => {
              await tx.order.update({ where: { id: a }, data: {} });
              await tx.user.update({ where: { id: b }, data: {} });
            });
          }
        }
      `
    });
    expect(ids(findings, "PRISMA-014")).toHaveLength(1);
  });

  it("does not report TypeORM-shaped repository calls", () => {
    const findings = analyzeSources({
      "src/e.service.ts": `
        export class E {
          constructor(private readonly ordersRepo: Repository<Order>) {}
          all() { return this.ordersRepo.find(); }
        }
      `
    });
    expect(findings.filter((finding) => finding.id.startsWith("TORM-"))).toHaveLength(0);
    expect(findings).toHaveLength(0);
  });
});
