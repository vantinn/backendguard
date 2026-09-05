import fs from "node:fs";
import path from "node:path";

/**
 * Evidence-based backend stack detection.
 *
 * Every detection carries the concrete evidence that produced it — a dependency
 * name in a specific `package.json`, a file that exists, a matched line in a
 * config file. Nothing is inferred from prose: a README that says "we use
 * Prisma" is not evidence, because a tool that guesses a stack routes the wrong
 * rules and produces findings about technology the project doesn't have.
 *
 * `stack.evidence` exposes that provenance so `backendguard stack --json` and
 * the tests can assert on *why* something was detected, not just that it was.
 */

const MAX_MANIFEST_DEPTH = 4;

/**
 * Directories that are never part of the workspace being described. `fixtures`
 * and test directories are excluded because a fixture `package.json` pinning a
 * different stack must not leak into the top-level report — a bug this tool
 * previously had against its own repository.
 */
const NON_WORKSPACE_DIR_NAMES = new Set([
  "node_modules", ".git", ".backendguard", "dist", "build", "coverage",
  "fixtures", "__fixtures__", "test", "tests", "__tests__", "spec", "specs",
  "e2e", "examples", "example"
]);

const CONFIG_FILES = [
  "eas.json", "app.json", "app.config.js", "app.config.ts", "vercel.json",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml",
  "railway.json", "render.yaml", "firebase.json", "fly.toml",
  "prisma/schema.prisma", "tsconfig.json", "nest-cli.json",
  "ormconfig.json", "ormconfig.js", "ormconfig.ts",
  "src/data-source.ts", "src/data-source.js", "data-source.ts",
  "jest.config.js", "jest.config.ts", "vitest.config.js", "vitest.config.ts",
  "playwright.config.ts", ".github/workflows",
  ".env.example", ".env.sample", "knexfile.js", "kubernetes", "k8s", "helm"
];

/**
 * The project root is the nearest ancestor that declares a package — not the
 * nearest `.git`. Running inside one package of a monorepo (or inside a nested
 * example app) must describe *that* package, not the outermost repository.
 */
export function findProjectRoot(cwd) {
  let current = path.resolve(cwd);
  let gitRoot = null;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    if (!gitRoot && fs.existsSync(path.join(current, ".git"))) gitRoot = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return gitRoot || path.resolve(cwd);
}

export function detectProjectProfile(root) {
  const packageFiles = findPackageJsonFiles(root);
  const packages = packageFiles
    .map((filePath) => ({ filePath, json: safeJson(path.join(root, filePath)) }))
    .filter((entry) => entry.json);

  // dependency name -> the manifest that declares it (the evidence).
  const dependencySources = new Map();
  const dependencies = new Set();
  const scripts = new Set();
  for (const entry of packages) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry.json[section] || {})) {
        dependencies.add(name);
        if (!dependencySources.has(name)) dependencySources.set(name, entry.filePath);
      }
    }
    for (const name of Object.keys(entry.json.scripts || {})) scripts.add(name);
  }

  const files = new Set(findExisting(root, CONFIG_FILES));
  const contents = {
    prismaSchema: readTextFile(path.join(root, "prisma/schema.prisma")) || findNestedPrismaSchema(root),
    compose: readTextFile(path.join(root, "docker-compose.yml")) || readTextFile(path.join(root, "docker-compose.yaml")) || readTextFile(path.join(root, "compose.yml")),
    dataSource: readTextFile(path.join(root, "src/data-source.ts")) || readTextFile(path.join(root, "data-source.ts")) || readTextFile(path.join(root, "ormconfig.json")),
    envExample: readTextFile(path.join(root, ".env.example")) || readTextFile(path.join(root, ".env.sample"))
  };

  const detector = createDetector({ dependencies, dependencySources, files, contents });
  const platforms = [];
  const evidence = {};

  const record = (platform, hits) => {
    if (!hits.length) return;
    platforms.push(platform);
    evidence[platform] = hits;
  };

  record("expo-mobile", detector.any([["dep", "expo"], ["dep", "react-native"], ["file", "eas.json"]]));
  record("next-web", detector.any([["dep", "next"], ["file", "vercel.json"]]));
  record("nestjs-backend", detector.any([["dep", "@nestjs/core"], ["file", "nest-cli.json"]]));
  if (!platforms.includes("nestjs-backend")) {
    record("express-backend", detector.any([["dep", "express"], ["dep", "fastify"], ["dep", "koa"]]));
  }
  record("typescript", detector.any([["dep", "typescript"], ["file", "tsconfig.json"]]));
  record("typeorm", detector.any([
    ["dep", "typeorm"], ["dep", "@nestjs/typeorm"],
    ["file", "ormconfig.json"], ["file", "ormconfig.js"], ["file", "ormconfig.ts"],
    ["file", "src/data-source.ts"], ["file", "data-source.ts"]
  ]));
  record("prisma", detector.any([
    ["dep", "prisma"], ["dep", "@prisma/client"], ["dep", "@nestjs/prisma"],
    ["file", "prisma/schema.prisma"],
    ["content", "prismaSchema", /^\s*(datasource|generator|model)\s+\w+/m, "schema.prisma declares a Prisma block"]
  ]));
  record("postgresql", detector.any([
    ["dep", "pg"], ["dep", "postgres"], ["dep", "@vercel/postgres"], ["dep", "postgres.js"],
    ["content", "prismaSchema", /provider\s*=\s*"postgresql"/, 'prisma datasource provider = "postgresql"'],
    ["content", "dataSource", /["']?type["']?\s*:\s*["']postgres["']/, 'TypeORM data source type = "postgres"'],
    ["content", "compose", /image:\s*["']?(postgres|postgis|timescale)/i, "docker-compose declares a Postgres image"],
    ["content", "envExample", /postgres(ql)?:\/\//i, ".env example contains a postgres:// URL"]
  ]));
  record("mysql", detector.any([["dep", "mysql"], ["dep", "mysql2"]]));
  record("mongodb", detector.any([["dep", "mongodb"], ["dep", "mongoose"], ["dep", "@nestjs/mongoose"]]));
  record("redis", detector.any([
    ["dep", "redis"], ["dep", "ioredis"], ["dep", "@nestjs/cache-manager"],
    ["content", "compose", /image:\s*["']?redis/i, "docker-compose declares a Redis image"]
  ]));
  record("jwt-auth", detector.any([["dep", "@nestjs/jwt"], ["dep", "jsonwebtoken"], ["dep", "passport-jwt"], ["dep", "jose"]]));
  record("validation", detector.any([["dep", "class-validator"], ["dep", "zod"], ["dep", "joi"], ["dep", "yup"]]));
  record("queues", detector.any([["dep", "bullmq"], ["dep", "bull"], ["dep", "@nestjs/bullmq"], ["dep", "@nestjs/bull"], ["dep", "kafkajs"], ["dep", "amqplib"]]));
  record("docker", detector.any([["file", "Dockerfile"], ["file", "docker-compose.yml"], ["file", "docker-compose.yaml"], ["file", "compose.yml"]]));
  record("kubernetes", detector.any([["file", "kubernetes"], ["file", "k8s"], ["file", "helm"]]));
  record("github-actions", detector.any([["file", ".github/workflows"]]));
  record("testing", detector.any([
    ["dep", "jest"], ["dep", "vitest"], ["dep", "@playwright/test"],
    ["file", "jest.config.js"], ["file", "jest.config.ts"], ["file", "vitest.config.js"], ["file", "playwright.config.ts"]
  ]));
  record("observability", detector.any([["dep", "@opentelemetry/api"], ["dep", "pino"], ["dep", "winston"], ["dep", "@sentry/node"]]));

  const summary = platforms.length
    ? platforms.join(", ")
    : packages.length
      ? `${packages.length} package.json file(s)`
      : "generic repository";

  return { root, packageFiles, dependencies, scripts, files, platforms, evidence, summary };
}

function createDetector({ dependencies, dependencySources, files, contents }) {
  return {
    any(checks) {
      const hits = [];
      for (const [kind, key, pattern, description] of checks) {
        if (kind === "dep" && dependencies.has(key)) {
          hits.push({ kind: "dependency", value: key, source: dependencySources.get(key) || "package.json" });
        } else if (kind === "file" && files.has(key)) {
          hits.push({ kind: "file", value: key, source: key });
        } else if (kind === "content" && contents[key] && pattern.test(contents[key])) {
          hits.push({ kind: "content", value: description, source: key });
        }
      }
      return hits;
    }
  };
}

export function detectStack({ cwd = process.cwd() } = {}) {
  return buildStackReport(findProjectRoot(cwd));
}

/**
 * Reduces detected platforms to the labelled fields `backendguard stack`
 * prints. Every field is either a concrete detection backed by evidence, or
 * `null` — the report never claims a technology the repository doesn't show.
 */
export function buildStackReport(root) {
  const profile = detectProjectProfile(root);
  const has = (platform) => profile.platforms.includes(platform);
  const pick = (...platforms) => platforms.filter(has).flatMap((platform) => profile.evidence[platform] || []);

  return {
    root,
    framework: has("nestjs-backend") ? "NestJS" : has("express-backend") ? "Express" : null,
    language: has("typescript") ? "TypeScript" : (profile.packageFiles.length ? "JavaScript" : null),
    database: has("postgresql") ? "PostgreSQL" : has("mysql") ? "MySQL" : has("mongodb") ? "MongoDB" : null,
    orm: has("prisma") ? "Prisma" : has("typeorm") ? "TypeORM" : null,
    cache: has("redis") ? "Redis" : null,
    queue: has("queues") ? "Queue (BullMQ/Kafka/AMQP)" : null,
    containerization: has("kubernetes") ? "Docker + Kubernetes" : has("docker") ? "Docker" : null,
    authentication: has("jwt-auth") ? "JWT" : null,
    validation: has("validation") ? "class-validator/zod" : null,
    ci: has("github-actions") ? "GitHub Actions" : null,
    testing: has("testing") ? "Jest/Vitest/Playwright" : null,
    observability: has("observability") ? "OpenTelemetry/structured logging" : null,
    platforms: profile.platforms,
    evidence: {
      framework: pick("nestjs-backend", "express-backend"),
      language: pick("typescript"),
      database: pick("postgresql", "mysql", "mongodb"),
      orm: pick("prisma", "typeorm"),
      cache: pick("redis"),
      queue: pick("queues"),
      containerization: pick("kubernetes", "docker"),
      authentication: pick("jwt-auth"),
      validation: pick("validation"),
      ci: pick("github-actions"),
      testing: pick("testing"),
      observability: pick("observability")
    }
  };
}

const STACK_ROWS = [
  ["Framework", "framework"],
  ["Language", "language"],
  ["Database", "database"],
  ["ORM", "orm"],
  ["Cache", "cache"],
  ["Queue", "queue"],
  ["Container", "containerization"],
  ["Authentication", "authentication"],
  ["Validation", "validation"],
  ["CI", "ci"],
  ["Testing", "testing"],
  ["Observability", "observability"]
];

export function formatStackReport(stack, { showEvidence = false } = {}) {
  const rows = STACK_ROWS.map(([label, key]) => [label, stack[key], key]);
  const detected = rows.filter(([, value]) => value);
  const lines = ["Backend Stack", ""];
  if (!detected.length) {
    lines.push("No backend stack evidence detected in this repository.");
    lines.push("(no package.json dependencies or config files matched a known framework/database/ORM)");
    return lines.join("\n");
  }
  const width = Math.max(...detected.map(([label]) => label.length)) + 2;
  for (const [label, value, key] of detected) {
    lines.push(`${label.padEnd(width)}${value}`);
    if (showEvidence) {
      for (const item of stack.evidence?.[key] || []) {
        lines.push(`${" ".repeat(width)}  ← ${formatEvidenceItem(item)}`);
      }
    }
  }
  const undetected = rows.filter(([, value]) => !value).map(([label]) => label);
  if (undetected.length) lines.push("", `Not detected: ${undetected.join(", ")}`);
  if (!showEvidence) lines.push("", "Run with --evidence to see what each detection is based on.");
  return lines.join("\n");
}

function formatEvidenceItem(item) {
  if (item.kind === "dependency") return `dependency "${item.value}" in ${item.source}`;
  if (item.kind === "file") return `file ${item.value}`;
  return `${item.value} (${item.source})`;
}

// ---------------------------------------------------------------------------

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function findNestedPrismaSchema(root) {
  const schemas = [];
  walk(root, schemas, (filePath) => path.basename(filePath) === "schema.prisma", 0);
  return schemas.length ? readTextFile(schemas[0]) : "";
}

function findPackageJsonFiles(root) {
  const files = [];
  walk(root, files, (filePath) => path.basename(filePath) === "package.json", 0);
  return files.map((filePath) => path.relative(root, filePath) || "package.json").sort();
}

function findExisting(root, relativePaths) {
  return relativePaths.filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
}

function walk(directory, files, predicate, depth) {
  if (depth > MAX_MANIFEST_DEPTH) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (NON_WORKSPACE_DIR_NAMES.has(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(filePath, files, predicate, depth + 1);
    else if (entry.isFile() && predicate(filePath)) files.push(filePath);
  }
}

function safeJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
