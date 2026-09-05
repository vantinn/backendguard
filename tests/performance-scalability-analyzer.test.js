import { describe, expect, it } from "vitest";

import { performanceAnalyzer } from "../analysis/performance/performance-analyzer.js";
import { scalabilityAnalyzer } from "../analysis/scalability/scalability-analyzer.js";
import { buildSourceIndex } from "../analysis/source-index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

function analyze(analyzer, files) {
  const cwd = makeFixture("perf");
  writeFiles(cwd, files);
  return analyzer.analyze({ cwd, index: buildSourceIndex({ cwd }), stack: {} });
}

function ids(findings, id) {
  return findings.filter((finding) => finding.id === id);
}

describe("performance analyzer", () => {
  it("PERF-001 flags an outbound call in a loop and accepts a batched call", () => {
    const flagged = analyze(performanceAnalyzer, {
      "src/a.ts": `
        export async function send(users: string[]) {
          for (const user of users) { await fetch("https://api.example.com/notify", { body: user }); }
        }
      `
    });
    expect(ids(flagged, "PERF-001")).toHaveLength(1);

    const clean = analyze(performanceAnalyzer, {
      "src/a.ts": `
        export async function send(users: string[]) {
          await fetch("https://api.example.com/notify-batch", { body: JSON.stringify(users) });
        }
      `
    });
    expect(ids(clean, "PERF-001")).toHaveLength(0);
  });

  it("PERF-002 flags synchronous filesystem and crypto calls on a request path", () => {
    const findings = analyze(performanceAnalyzer, {
      "src/a.controller.ts": `
        @Controller("a")
        export class AController {
          @Get()
          read() { return readFileSync("/etc/config"); }

          @Post()
          hash(@Body() dto: any) { return bcrypt.hashSync(dto.password, 12); }
        }
      `
    });
    expect(ids(findings, "PERF-002")).toHaveLength(2);
    expect(findings.some((finding) => finding.severity === "HIGH")).toBe(true);
  });

  it("PERF-002 does not flag async filesystem work on a request path", () => {
    const findings = analyze(performanceAnalyzer, {
      "src/a.controller.ts": `
        @Controller("a")
        export class AController {
          @Get()
          async read() { return fs.readFile("/etc/config", "utf8"); }
        }
      `
    });
    expect(ids(findings, "PERF-002")).toHaveLength(0);
  });

  it("PERF-004 flags an unbounded Promise.all fan-out and accepts a chunked one", () => {
    const flagged = analyze(performanceAnalyzer, {
      "src/a.ts": `
        export async function load(ids: string[]) {
          return Promise.all(ids.map(async (id) => fetch(\`/x/\${id}\`)));
        }
      `
    });
    expect(ids(flagged, "PERF-004")).toHaveLength(1);

    const clean = analyze(performanceAnalyzer, {
      "src/a.ts": `
        export async function load(ids: string[]) {
          const batch = ids.slice(0, 20);
          return Promise.all(batch.map(async (id) => fetch(\`/x/\${id}\`)));
        }
      `
    });
    expect(ids(clean, "PERF-004")).toHaveLength(0);
  });
});

describe("scalability analyzer", () => {
  it("SCALE-001 flags a mutable cache on a singleton service", () => {
    const findings = analyze(scalabilityAnalyzer, {
      "src/a.service.ts": `
        @Injectable()
        export class AService {
          private readonly sessionCache = new Map<string, string>();
        }
      `
    });
    expect(ids(findings, "SCALE-001")).toHaveLength(1);
  });

  it("SCALE-001 does not flag an injected Redis-backed client", () => {
    const findings = analyze(scalabilityAnalyzer, {
      "src/a.service.ts": `
        @Injectable()
        export class AService {
          constructor(private readonly cache: RedisClient) {}
          get(key: string) { return this.cache.get(key); }
        }
      `
    });
    expect(ids(findings, "SCALE-001")).toHaveLength(0);
  });

  it("SCALE-002 flags throttling with no shared storage and accepts a Redis-backed store", () => {
    const flagged = analyze(scalabilityAnalyzer, {
      "src/app.module.ts": `
        @Module({ imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])] })
        export class AppModule {}
      `
    });
    expect(ids(flagged, "SCALE-002")).toHaveLength(1);

    const clean = analyze(scalabilityAnalyzer, {
      "src/app.module.ts": `
        @Module({ imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 10 }], storage: new ThrottlerStorageRedisService(redis) })] })
        export class AppModule {}
      `
    });
    expect(ids(clean, "SCALE-002")).toHaveLength(0);
  });

  it("SCALE-004 flags an uncoordinated cron and accepts one guarded by a lock", () => {
    const flagged = analyze(scalabilityAnalyzer, {
      "src/a.service.ts": `
        @Injectable()
        export class AService {
          @Cron("0 * * * *")
          async sweep() { return 1; }
        }
      `
    });
    expect(ids(flagged, "SCALE-004")).toHaveLength(1);

    const clean = analyze(scalabilityAnalyzer, {
      "src/a.service.ts": `
        @Injectable()
        export class AService {
          @Cron("0 * * * *")
          async sweep() {
            const acquired = await this.advisoryLock("sweep");
            if (!acquired) return;
          }
        }
      `
    });
    expect(ids(clean, "SCALE-004")).toHaveLength(0);
  });

  it("SCALE-005 flags express-session with no store", () => {
    const flagged = analyze(scalabilityAnalyzer, {
      "src/main.ts": `app.use(session({ secret: process.env.SESSION_SECRET }));`
    });
    expect(ids(flagged, "SCALE-005")).toHaveLength(1);

    const clean = analyze(scalabilityAnalyzer, {
      "src/main.ts": `app.use(session({ secret: process.env.SESSION_SECRET, store: new RedisStore({ client }) }));`
    });
    expect(ids(clean, "SCALE-005")).toHaveLength(0);
  });

  it("SCALE-006/007 only apply to a containerised project", () => {
    const notContainerised = analyze(scalabilityAnalyzer, {
      "src/main.ts": `export async function bootstrap() { await app.listen(3000); }`
    });
    expect(ids(notContainerised, "SCALE-006")).toHaveLength(0);
    expect(ids(notContainerised, "SCALE-007")).toHaveLength(0);

    const containerised = analyze(scalabilityAnalyzer, {
      "Dockerfile": "FROM node:20-alpine\n",
      "src/main.ts": `export async function bootstrap() { await app.listen(3000); }`
    });
    expect(ids(containerised, "SCALE-006")).toHaveLength(1);
    expect(ids(containerised, "SCALE-007")).toHaveLength(1);
  });

  it("SCALE-006/007 are satisfied by shutdown hooks and a health route", () => {
    const findings = analyze(scalabilityAnalyzer, {
      "Dockerfile": "FROM node:20-alpine\n",
      "src/main.ts": `
        export async function bootstrap() {
          app.enableShutdownHooks();
          await app.listen(3000);
        }
      `,
      "src/health.controller.ts": `
        @Controller("health")
        export class HealthController {
          @Get() liveness() { return { status: "ok" }; }
        }
      `
    });
    expect(ids(findings, "SCALE-006")).toHaveLength(0);
    expect(ids(findings, "SCALE-007")).toHaveLength(0);
  });
});
