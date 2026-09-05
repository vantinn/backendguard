import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { typeormAnalyzer } from "../analysis/database/typeorm-analyzer.js";
import { buildSourceIndex } from "../analysis/source-index.js";

const TYPEORM_STACK = { orm: "TypeORM", platforms: ["typeorm"] };

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-typeorm-"));
}

function writeFiles(repo, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function analyze(cwd) {
  return typeormAnalyzer.analyze({ cwd, index: buildSourceIndex({ cwd }), stack: TYPEORM_STACK });
}

// Kept as the historic entrypoint name used across these tests.
function analyzeProjectSource({ cwd }) {
  return analyze(cwd);
}

function findingsOf(findings, id) {
  return findings.filter((finding) => finding.id === id);
}

describe("typeorm analyzer: applicability", () => {
  it("does not run against a project that has no TypeORM in its stack", () => {
    expect(typeormAnalyzer.appliesTo({ stack: { orm: "Prisma", platforms: ["prisma"] } })).toBe(false);
    expect(typeormAnalyzer.appliesTo({ stack: TYPEORM_STACK })).toBe(true);
  });
});

describe("typeorm analyzer: TORM-001 unbounded read", () => {
  it("flags repo.find() with no pagination options", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/products.service.ts": `
        @Injectable()
        export class ProductsService {
          constructor(private readonly productsRepo: Repository<Product>) {}
          async findAll() { return this.productsRepo.find(); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-001")).toHaveLength(1);
  });

  it("does not flag repo.find({ take, skip })", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/products.service.ts": `
        @Injectable()
        export class ProductsService {
          constructor(private readonly productsRepo: Repository<Product>) {}
          async findAll(page: number) { return this.productsRepo.find({ take: 20, skip: page * 20 }); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-001")).toHaveLength(0);
  });

  it("does not flag Array.prototype.find with a predicate function", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/products.service.ts": `
        @Injectable()
        export class ProductsService {
          pickFirstActive(items) { return items.find((item) => item.active); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-001")).toHaveLength(0);
  });
});

describe("typeorm analyzer: TORM-002 N+1", () => {
  it("flags a repository read call inside a for-of loop", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/orders/orders.service.ts": `
        @Injectable()
        export class OrdersService {
          constructor(private readonly productsRepo: Repository<Product>) {}
          async summarize(items) {
            for (const item of items) {
              const product = await this.productsRepo.findOne({ where: { id: item.productId } });
            }
          }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-002")).toHaveLength(1);
  });

  it("does not flag a repository read call outside any loop", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/orders/orders.service.ts": `
        @Injectable()
        export class OrdersService {
          constructor(private readonly ordersRepo: Repository<Order>) {}
          async findById(id: string) { return this.ordersRepo.findOne({ where: { id } }); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-002")).toHaveLength(0);
  });
});

describe("typeorm analyzer: TORM-003 missing transaction", () => {
  it("flags 2+ repository writes in one function with no transaction wrapper", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/payments/payments.service.ts": `
        @Injectable()
        export class PaymentsService {
          constructor(
            private readonly usersRepo: Repository<User>,
            private readonly ordersRepo: Repository<Order>,
          ) {}
          async pay(userId, orderId) {
            const user = await this.usersRepo.findOne({ where: { id: userId } });
            user.balance -= 100;
            await this.usersRepo.save(user);
            const order = await this.ordersRepo.findOne({ where: { id: orderId } });
            order.status = 'paid';
            await this.ordersRepo.save(order);
          }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-003")).toHaveLength(1);
  });

  it("does not flag writes wrapped in a dataSource.transaction(...) call", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/payments/payments.service.ts": `
        @Injectable()
        export class PaymentsService {
          constructor(private readonly dataSource: DataSource) {}
          async pay(userId, orderId) {
            await this.dataSource.transaction(async (manager) => {
              const user = await manager.findOne(User, { where: { id: userId } });
              await manager.save(user);
              const order = await manager.findOne(Order, { where: { id: orderId } });
              await manager.save(order);
            });
          }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-003")).toHaveLength(0);
  });

  it("does not flag a single write call", () => {
    const repo = makeRepo();
    writeFiles(repo, {
      "src/products/products.service.ts": `
        @Injectable()
        export class ProductsService {
          constructor(private readonly productsRepo: Repository<Product>) {}
          async create(dto) { return this.productsRepo.save(this.productsRepo.create(dto)); }
        }
      `
    });
    expect(findingsOf(analyzeProjectSource({ cwd: repo }), "TORM-003")).toHaveLength(0);
  });
});
