import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeProject } from "../analysis/index.js";
import { analyzeSqlText, splitSqlStatements } from "../analysis/database/postgresql-analyzer.js";
import { classifySecretLiteral } from "../analysis/security/secret-detection.js";
import { toPosix } from "../analysis/project-scanner.js";
import { buildSourceIndex } from "../analysis/source-index.js";
import { typeormAnalyzer } from "../analysis/database/typeorm-analyzer.js";
import { prismaAnalyzer } from "../analysis/database/prisma-analyzer.js";
import { nestjsSecurityAnalyzer } from "../analysis/security/nestjs-security-analyzer.js";
import { LEGACY_TOOL_ALIASES, resolveToolName } from "../integrations/mcp/tools.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

/**
 * Regressions from the adversarial audit.
 *
 * Every case here comes from a fixture written as ordinary backend code and
 * only then run through the tool — not from reading the analyzers. Each one
 * failed before the fix it accompanies.
 */

const TYPEORM_STACK = { orm: "TypeORM", platforms: ["typeorm"] };
const PRISMA_STACK = { orm: "Prisma", platforms: ["prisma"] };

function analyze(analyzer, files, stack) {
  const cwd = writeFiles(makeFixture("adversarial"), files);
  return analyzer.analyze({ cwd, index: buildSourceIndex({ cwd }), stack });
}

const ids = (findings, id) => findings.filter((finding) => finding.id === id);

// ---------------------------------------------------------------------------
// A-1 — ORM analyzers must not depend on what the developer named the field
// ---------------------------------------------------------------------------

describe("A-1: ORM detection by declared type, not field name", () => {
  it("finds TypeORM defects when the field is not named *Repo", () => {
    const findings = analyze(typeormAnalyzer, {
      "src/catalog.service.ts": `
        @Injectable()
        export class CatalogService {
          constructor(
            @InjectRepository(Product) private readonly products: Repository<Product>,
            @InjectRepository(Vendor) private readonly vendors: Repository<Vendor>
          ) {}
          async listAll() { return this.products.find(); }
          async withVendors(skus: string[]) {
            for (const sku of skus) { await this.products.findOne({ where: { sku } }); }
          }
          async replaceVendor(a: string, b: string) {
            await this.products.update(a, {});
            await this.vendors.update(b, {});
          }
        }
      `
    }, TYPEORM_STACK);
    expect(ids(findings, "TORM-001")).toHaveLength(1);
    expect(ids(findings, "TORM-002")).toHaveLength(1);
    expect(ids(findings, "TORM-003")).toHaveLength(1);
  });

  it("finds defects inside a class extending Repository<T> via bare this.find()", () => {
    const findings = analyze(typeormAnalyzer, {
      "src/invoice.repository.ts": `
        @Injectable()
        export class InvoiceRepository extends Repository<Invoice> {
          constructor(private readonly dataSource: DataSource) {
            super(Invoice, dataSource.createEntityManager());
          }
          async findOverdue() { return this.find({ where: { status: "overdue" } }); }
        }
      `
    }, TYPEORM_STACK);
    expect(ids(findings, "TORM-001")).toHaveLength(1);
  });

  it("finds Prisma defects when the client field is not named prisma", () => {
    const findings = analyze(prismaAnalyzer, {
      "src/orders.service.ts": `
        @Injectable()
        export class OrdersService {
          constructor(private readonly db: PrismaService) {}
          async listForCustomer(customerId: string) {
            return this.db.order.findMany({ where: { customerId } });
          }
          async hydrate(ids: string[]) {
            for (const id of ids) { await this.db.order.findUnique({ where: { id } }); }
          }
          async cancel(orderId: string, customerId: string) {
            await this.db.order.update({ where: { id: orderId }, data: {} });
            await this.db.orderLine.deleteMany({ where: { orderId } });
          }
        }
      `
    }, PRISMA_STACK);
    expect(ids(findings, "PRISMA-010")).toHaveLength(1);
    expect(ids(findings, "PRISMA-011")).toHaveLength(1);
    expect(ids(findings, "PRISMA-014")).toHaveLength(1);
  });

  it("still accepts correct code under the same non-standard naming", () => {
    const findings = analyze(prismaAnalyzer, {
      "src/orders.service.ts": `
        @Injectable()
        export class OrdersService {
          constructor(private readonly db: PrismaService) {}
          async page(cursor?: string) { return this.db.order.findMany({ take: 25, cursor: { id: cursor } }); }
          async settle(orderId: string) {
            return this.db.$transaction([
              this.db.order.update({ where: { id: orderId }, data: {} }),
              this.db.orderLine.updateMany({ where: { orderId }, data: {} })
            ]);
          }
        }
      `
    }, PRISMA_STACK);
    expect(findings).toHaveLength(0);
  });

  it("does not treat a non-repository field as a repository", () => {
    const findings = analyze(typeormAnalyzer, {
      "src/selectors.ts": `
        @Injectable()
        export class Selectors {
          constructor(private readonly products: ProductCatalogClient) {}
          async listAll() { return this.products.find(); }
        }
      `
    }, TYPEORM_STACK);
    expect(ids(findings, "TORM-001")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A-2 — a secret-shaped property name is not evidence of a secret
// ---------------------------------------------------------------------------

describe("A-2: credential detection requires credential-shaped evidence", () => {
  it("does not report environment-variable names, header names or config keys", () => {
    for (const value of ["JWT_SIGNING_SECRET", "PARTNER_API_KEY", "DB_PASSWORD", "X-Auth-Password", "content-type", "config.jwt.secret", "my-app-name"]) {
      expect(classifySecretLiteral(value, { propertyName: "secret" }).isCredential, value).toBe(false);
    }
  });

  it("reports recognised credential formats at certain confidence", () => {
    for (const value of ["sk_test_51H8xQ2KpL9mN3vR7wT4yU6iO", "AKIAIOSFODNN7EXAMPLE", "postgres://app:s3cr3t@db:5432/x"]) {
      const verdict = classifySecretLiteral(value, { propertyName: "secret" });
      expect(verdict.isCredential, value).toBe(true);
      expect(verdict.confidence).toBe("certain");
    }
  });

  it("reports a hand-written high-entropy secret at high, not certain, confidence", () => {
    const verdict = classifySecretLiteral("super-secret-jwt-signing-key-2024", { propertyName: "secret" });
    expect(verdict.isCredential).toBe(true);
    expect(verdict.confidence).toBe("high");
  });

  it("still reports any literal in a slot consumed directly as key material", () => {
    // `secretOrKey` is passed straight to a signing call; nobody puts an env var
    // name there, so shape evidence is not required.
    expect(classifySecretLiteral("supersecret123", { propertyName: "secretOrKey" }).isCredential).toBe(true);
    expect(classifySecretLiteral("supersecret123", { propertyName: "secret" }).isCredential).toBe(false);
  });

  it("produces exactly one finding for a config map holding one real leak", () => {
    const findings = analyze(nestjsSecurityAnalyzer, {
      "src/config.ts": `
        export const registry = { secret: "APP_SECRET", apiKey: "STRIPE_API_KEY", password: "X-Auth-Password" };
        export const leak = { secret: "sk_test_51H8xQ2KpL9mN3vR7wT4yU6iO" };
      `
    }, {});
    const secrets = ids(findings, "SEC-003");
    expect(secrets).toHaveLength(1);
    expect(secrets[0].evidence).toContain("sk_test");
  });
});

// ---------------------------------------------------------------------------
// A-3 / A-4 — route composition and serializer awareness
// ---------------------------------------------------------------------------

describe("A-3: the controller path prefix is part of the route", () => {
  it("treats a webhook/health/login route declared on the controller as public", () => {
    const findings = analyze(nestjsSecurityAnalyzer, {
      "src/routes.ts": `
        @Controller("webhooks/stripe")
        export class StripeWebhookController {
          @Post() async receive(@Body() body: unknown) { return body; }
        }
        @Controller("auth/login")
        export class LoginController {
          @Post() async submit(@Body() dto: LoginDto) { return dto; }
        }
        @Controller("v1/health")
        export class HealthController {
          @Post() async ping() { return { ok: true }; }
        }
      `
    }, {});
    expect(ids(findings, "SEC-002")).toHaveLength(0);
  });

  it("still flags a genuinely unguarded state-changing route", () => {
    const findings = analyze(nestjsSecurityAnalyzer, {
      "src/routes.ts": `
        @Controller("payments")
        export class PaymentsController {
          @Post("capture") async capture(@Body() dto: CaptureDto) { return dto; }
        }
      `
    }, {});
    expect(ids(findings, "SEC-002")).toHaveLength(1);
  });
});

describe("A-4: @Exclude() plus ClassSerializerInterceptor is not an exposure", () => {
  it("does not flag an entity whose sensitive columns are excluded and serialized", () => {
    const findings = analyze(nestjsSecurityAnalyzer, {
      "src/credential.entity.ts": `
        @Entity()
        export class Credential {
          @Column() email: string;
          @Exclude() @Column() passwordHash: string;
          @Exclude() @Column() refreshTokenHash: string;
        }
      `,
      "src/auth.service.ts": `
        @Injectable()
        export class AuthService {
          constructor(@InjectRepository(Credential) private readonly credentialsRepo: Repository<Credential>) {}
          async findCredential(id: string) { return this.credentialsRepo.findOne({ where: { id } }); }
        }
      `,
      "src/auth.controller.ts": `
        @Controller("credentials")
        @UseGuards(AuthGuard("jwt"))
        @UseInterceptors(ClassSerializerInterceptor)
        export class AuthController {
          constructor(private readonly auth: AuthService) {}
          @Get(":id") async findOne(@Param("id") id: string) { return this.auth.findCredential(id); }
        }
      `
    }, {});
    expect(ids(findings, "SEC-001")).toHaveLength(0);
  });

  it("still flags the same shape without the serializer", () => {
    const findings = analyze(nestjsSecurityAnalyzer, {
      "src/credential.entity.ts": `
        @Entity()
        export class Credential {
          @Column() email: string;
          @Column() passwordHash: string;
        }
      `,
      "src/auth.service.ts": `
        @Injectable()
        export class AuthService {
          constructor(@InjectRepository(Credential) private readonly credentialsRepo: Repository<Credential>) {}
          async findCredential(id: string) { return this.credentialsRepo.findOne({ where: { id } }); }
        }
      `,
      "src/auth.controller.ts": `
        @Controller("credentials")
        @UseGuards(AuthGuard("jwt"))
        export class AuthController {
          constructor(private readonly auth: AuthService) {}
          @Get(":id") async findOne(@Param("id") id: string) { return this.auth.findCredential(id); }
        }
      `
    }, {});
    expect(ids(findings, "SEC-001")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A-5 — path separators must be platform-independent
// ---------------------------------------------------------------------------

describe("A-5: analysis file paths are POSIX on every platform", () => {
  it("normalises the native separator so git-reported paths match", () => {
    const native = ["src", "users", "users.controller.ts"].join(path.sep);
    expect(toPosix(native)).toBe("src/users/users.controller.ts");
    // The join that silently returned zero findings on Windows.
    expect(new Set(["src/users/users.controller.ts"]).has(toPosix(native))).toBe(true);
  });

  it("emits forward slashes for nested files regardless of host platform", () => {
    const cwd = writeFiles(makeFixture("posix-paths"), {
      "package.json": JSON.stringify({ name: "p", dependencies: { typeorm: "^0.3.20", pg: "^8.13.0" } }),
      "src/deep/nested/thing.service.ts": `
        @Injectable()
        export class ThingService {
          constructor(@InjectRepository(Thing) private readonly things: Repository<Thing>) {}
          all() { return this.things.find(); }
        }
      `
    });
    const result = analyzeProject({ cwd });
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.file).not.toContain("\\");
      expect(finding.location).not.toContain("\\");
    }
    expect(result.findings.some((finding) => finding.file === "src/deep/nested/thing.service.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A-7 — MCP tool names are a public interface
// ---------------------------------------------------------------------------

describe("A-7: MCP tool names", () => {
  it("maps every pre-0.9.0 tool id to its replacement", () => {
    expect(LEGACY_TOOL_ALIASES.size).toBeGreaterThanOrEqual(10);
    for (const [legacy, current] of LEGACY_TOOL_ALIASES) {
      expect(legacy.startsWith("ctx_")).toBe(true);
      expect(current.startsWith("backendguard_")).toBe(true);
      expect(resolveToolName(legacy)).toBe(current);
    }
  });

  it("leaves an unknown name untouched", () => {
    expect(resolveToolName("something_else")).toBe("something_else");
  });
});

// ---------------------------------------------------------------------------
// A-8 / A-9 — SQL statements span lines, and concatenation is injection
// ---------------------------------------------------------------------------

describe("A-8: SQL is analyzed per statement, not per line", () => {
  it("splits multi-line statements and keeps their starting line", () => {
    const statements = splitSqlStatements(`-- comment\nALTER TABLE orders\n  ADD COLUMN region varchar(8) NOT NULL;\n\nUPDATE orders\n  SET region = 'us';\n`);
    expect(statements).toHaveLength(2);
    expect(statements[0].line).toBe(2);
    expect(statements[0].text).toBe("ALTER TABLE orders ADD COLUMN region varchar(8) NOT NULL;");
    expect(statements[1].line).toBe(5);
  });

  it("flags a multi-line blocking migration and an unscoped multi-line UPDATE", () => {
    const findings = analyzeSqlText(
      `ALTER TABLE orders\n  ADD COLUMN region varchar(8) NOT NULL;\n\nUPDATE orders\n  SET region = 0;\n`,
      "migrations/003_add_region.sql"
    );
    expect(ids(findings, "PG-001")).toHaveLength(1);
    expect(ids(findings, "PG-003")).toHaveLength(1);
    expect(ids(findings, "PG-001")[0].line).toBe(1);
  });

  it("does not flag the safe multi-line equivalents", () => {
    const findings = analyzeSqlText(
      `ALTER TABLE orders\n  ADD COLUMN region varchar(8) DEFAULT 'us';\n\nUPDATE orders\n  SET region = 'us'\n  WHERE region IS NULL;\n`,
      "migrations/004.sql"
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores a commented-out statement spanning lines", () => {
    const findings = analyzeSqlText(`-- ALTER TABLE orders\n-- ADD COLUMN region varchar(8) NOT NULL;\n`, "migrations/005.sql");
    expect(findings).toHaveLength(0);
  });
});

describe("A-9: SQL built by string concatenation", () => {
  const PG_STACK = { database: "PostgreSQL", platforms: ["postgresql"] };

  it("flags a concatenated statement and leaves a parameterised one alone", () => {
    const cwd = writeFiles(makeFixture("concat-sql"), {
      "src/reports.ts": `
        export async function unsafe(status: string) {
          return pool.query("SELECT * FROM orders WHERE status = '" + status + "'");
        }
        export async function safe(id: string) {
          return pool.query("SELECT id FROM orders WHERE customer_id = $1 LIMIT 100", [id]);
        }
      `
    });
    const findings = analyzeProject({ cwd, stack: PG_STACK }).findings;
    const injections = ids(findings, "PG-012");
    expect(injections).toHaveLength(1);
    expect(injections[0].title).toContain("concatenation");
  });

  it("does not flag a constant-only concatenation", () => {
    const cwd = writeFiles(makeFixture("const-sql"), {
      "src/q.ts": `export const QUERY = "SELECT id FROM orders " + "WHERE status = $1";`
    });
    expect(ids(analyzeProject({ cwd, stack: PG_STACK }).findings, "PG-012")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Project-scope findings must not masquerade as file findings
// ---------------------------------------------------------------------------

describe("project-scope findings are anchored honestly", () => {
  it("says so explicitly when there is no entrypoint to anchor to", () => {
    const cwd = writeFiles(makeFixture("no-entrypoint"), {
      "package.json": JSON.stringify({ name: "p", dependencies: { "@nestjs/core": "^10.4.4" } }),
      "Dockerfile": "FROM node:20-alpine\n",
      "src/some.controller.ts": `@Controller("a") export class AController { @Get() list() { return []; } }`
    });
    const finding = analyzeProject({ cwd }).findings.find((entry) => entry.id === "SCALE-006");
    expect(finding.file).toBe("(project)");
    expect(finding.evidence).toContain("project-wide observation");
  });
});
