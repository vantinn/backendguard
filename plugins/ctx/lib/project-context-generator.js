import fs from "node:fs";
import path from "node:path";

import { clearSkillScanCache } from "./skill-discoverer.js";

const STARTER_SKILL_LIMIT = 3;
const SHARED_PROJECT_CONTEXT_DIR = ".agents";

export function generateProjectContext({ cwd = process.cwd(), force = false } = {}) {
  const root = findProjectRoot(cwd);
  const profile = detectProjectProfile(root);
  const skills = selectStarterSkills(profile).slice(0, STARTER_SKILL_LIMIT);
  const created = [];
  const skipped = [];

  for (const skill of skills) {
    const dir = path.join(root, SHARED_PROJECT_CONTEXT_DIR, "skills", skill.id);
    const skillPath = path.join(dir, "SKILL.md");
    const yamlPath = path.join(dir, "skill.yaml");
    fs.mkdirSync(dir, { recursive: true });
    writeFile({ filePath: skillPath, content: renderSkillMarkdown(skill), force, created, skipped });
    writeFile({ filePath: yamlPath, content: renderSkillYaml(skill), force, created, skipped });
  }

  const workflowPath = path.join(root, SHARED_PROJECT_CONTEXT_DIR, "workflows", "primary.md");
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  writeFile({
    filePath: workflowPath,
    content: renderPrimaryWorkflow(profile, skills),
    force,
    created,
    skipped
  });
  clearSkillScanCache();

  return {
    root,
    profile,
    skills: skills.map((skill) => skill.id),
    created,
    skipped
  };
}

export function formatProjectContextGeneration(result) {
  const lines = [
    "Project context generated",
    "",
    `Root: ${result.root}`,
    `Detected: ${result.profile.summary}`,
    `Skills: ${result.skills.join(", ") || "(none)"}`,
    "",
    "Created:"
  ];
  if (result.created.length) {
    for (const filePath of result.created) lines.push(`- ${path.relative(result.root, filePath)}`);
  } else {
    lines.push("- none");
  }
  if (result.skipped.length) {
    lines.push("", "Skipped existing files:");
    for (const filePath of result.skipped) lines.push(`- ${path.relative(result.root, filePath)}`);
  }
  lines.push("", "Next:");
  lines.push("- Review generated shared skills/workflow and edit project-specific wording.");
  lines.push("- Run: backendguard sync --skills && backendguard sync --workflows");
  lines.push("- Run: backendguard doctor");
  lines.push("- Run: backendguard context -- \"your task\"");
  return lines.join("\n");
}

export function detectProjectProfile(root) {
  const packageFiles = findPackageJsonFiles(root);
  const packages = packageFiles.map((filePath) => ({
    filePath,
    json: safeJson(filePath)
  })).filter((item) => item.json);
  const dependencies = new Set();
  const scripts = new Set();
  for (const item of packages) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(item.json[section] || {})) dependencies.add(name);
    }
    for (const name of Object.keys(item.json.scripts || {})) scripts.add(name);
  }
  const files = new Set([
    ...findExisting(root, [
      "eas.json",
      "app.json",
      "app.config.js",
      "app.config.ts",
      "vercel.json",
      "Dockerfile",
      "docker-compose.yml",
      "compose.yml",
      "railway.json",
      "render.yaml",
      "firebase.json",
      "prisma/schema.prisma",
      "tsconfig.json",
      "nest-cli.json",
      "ormconfig.json",
      "ormconfig.js",
      "src/data-source.ts",
      "src/data-source.js",
      "jest.config.js",
      "jest.config.ts",
      "playwright.config.ts",
      ".github/workflows"
    ])
  ]);

  const prismaSchema = readTextFile(path.join(root, "prisma/schema.prisma"));

  const has = (name) => dependencies.has(name);
  const hasFile = (name) => files.has(name);
  const platforms = [];
  if (has("expo") || has("react-native") || hasFile("eas.json")) platforms.push("expo-mobile");
  if (has("next") || hasFile("vercel.json")) platforms.push("next-web");
  if (has("@nestjs/core")) platforms.push("nestjs-backend");
  if (has("express") && !has("@nestjs/core")) platforms.push("express-backend");
  if (has("typescript") || hasFile("tsconfig.json")) platforms.push("typescript");
  if (has("typeorm") || has("@nestjs/typeorm")) platforms.push("typeorm");
  if (has("prisma") || has("@prisma/client") || hasFile("prisma/schema.prisma")) platforms.push("prisma");
  if (
    has("pg") || has("postgres") ||
    /provider\s*=\s*"postgresql"/.test(prismaSchema) ||
    hasFile("ormconfig.json") || hasFile("ormconfig.js")
  ) platforms.push("postgresql");
  if (has("redis") || has("ioredis")) platforms.push("redis");
  if (has("@nestjs/jwt") || has("jsonwebtoken") || has("passport-jwt")) platforms.push("jwt-auth");
  if (has("class-validator") || has("zod") || has("joi")) platforms.push("validation");
  if (has("bullmq") || has("bull") || has("@nestjs/bullmq")) platforms.push("queues");
  if (hasFile("Dockerfile") || hasFile("docker-compose.yml")) platforms.push("docker");
  if (hasFile(".github/workflows")) platforms.push("github-actions");
  if (has("jest") || has("vitest") || hasFile("jest.config.js") || hasFile("playwright.config.ts")) platforms.push("testing");

  const summary = platforms.length
    ? platforms.join(", ")
    : packages.length
      ? `${packages.length} package.json file(s)`
      : "generic repository";

  return {
    root,
    packageFiles,
    dependencies,
    scripts,
    files,
    platforms,
    summary
  };
}

// Reduces the detected platform tags to the labeled fields backendguard stack prints.
// Every field is either a concrete detection (backed by a dependency or file) or
// null — never a guess, so the CLI never claims a technology the repo doesn't show.
export function detectStack({ cwd = process.cwd() } = {}) {
  return buildStackReport(findProjectRoot(cwd));
}

export function buildStackReport(root) {
  const profile = detectProjectProfile(root);
  const has = (platform) => profile.platforms.includes(platform);
  return {
    root,
    framework: has("nestjs-backend") ? "NestJS" : has("express-backend") ? "Express" : null,
    language: has("typescript") ? "TypeScript" : (profile.packageFiles.length ? "JavaScript" : null),
    database: has("postgresql") ? "PostgreSQL" : null,
    orm: has("prisma") ? "Prisma" : has("typeorm") ? "TypeORM" : null,
    cache: has("redis") ? "Redis" : null,
    queue: has("queues") ? "BullMQ" : null,
    containerization: has("docker") ? "Docker" : null,
    authentication: has("jwt-auth") ? "JWT" : null,
    validation: has("validation") ? "class-validator/zod" : null,
    ci: has("github-actions") ? "GitHub Actions" : null,
    testing: has("testing") ? "Jest/Vitest/Playwright" : null,
    platforms: profile.platforms
  };
}

export function formatStackReport(stack) {
  const rows = [
    ["Framework", stack.framework],
    ["Language", stack.language],
    ["Database", stack.database],
    ["ORM", stack.orm],
    ["Cache", stack.cache],
    ["Queue", stack.queue],
    ["Container", stack.containerization],
    ["Authentication", stack.authentication],
    ["Validation", stack.validation],
    ["CI", stack.ci],
    ["Testing", stack.testing]
  ];
  const detected = rows.filter(([, value]) => value);
  const lines = ["Backend Stack", ""];
  if (!detected.length) {
    lines.push("No backend stack evidence detected in this repository.");
    lines.push("(no package.json dependencies or config files matched a known framework/database/ORM)");
    return lines.join("\n");
  }
  const width = Math.max(...detected.map(([label]) => label.length)) + 2;
  for (const [label, value] of detected) {
    lines.push(`${label.padEnd(width)}${value}`);
  }
  const undetected = rows.filter(([, value]) => !value).map(([label]) => label);
  if (undetected.length) {
    lines.push("", `Not detected: ${undetected.join(", ")}`);
  }
  return lines.join("\n");
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function selectStarterSkills(profile) {
  const skills = [];
  const hasPlatform = (platform) => profile.platforms.includes(platform);
  if (hasPlatform("expo-mobile")) {
    skills.push(skill({
      id: "mobile-deployment",
      name: "Mobile Deployment",
      description: "Use for Expo, React Native, EAS build, QR/dev-client, Android/iOS preview, and mobile release tasks.",
      prompts: ["expo", "react native", "eas", "mobile", "qr", "android", "ios", "preview", "production", "deploy"],
      files: ["eas.json", "app.json", "app.config.ts", ".github/workflows/*"],
      dependencies: ["expo", "react-native", "eas-cli"],
      negatives: ["vercel", "serverless web deployment"]
    }));
  }
  if (hasPlatform("next-web")) {
    skills.push(skill({
      id: "nextjs-web",
      name: "Next.js Web",
      description: "Use for Next.js routes, App Router, server/client component boundaries, Vercel deploys, and web UI tasks.",
      prompts: ["next", "nextjs", "app router", "route", "page", "component", "vercel", "webapp"],
      files: ["app/**", "pages/**", "next.config.*", "vercel.json"],
      dependencies: ["next", "react"],
      negatives: ["expo", "eas", "android", "ios"]
    }));
  }
  if (hasPlatform("nestjs-backend") || hasPlatform("express-backend")) {
    skills.push(skill({
      id: "backend-api",
      name: "Backend API",
      description: "Use for backend services, API endpoints, validation, auth, controllers/routes, and service-layer changes.",
      prompts: ["api", "backend", "service", "controller", "route", "auth", "validation", "fastify", "express", "nestjs"],
      files: ["services/**", "src/**", "apps/**", "libs/**"],
      dependencies: ["@nestjs/core", "express", "fastify", "zod", "class-validator"],
      negatives: ["pure css", "static copy"]
    }));
  }
  if (hasPlatform("prisma")) {
    skills.push(skill({
      id: "database-prisma",
      name: "Database Prisma",
      description: "Use for Prisma schema, migrations, query performance, repositories, and database-backed tests.",
      prompts: ["prisma", "database", "migration", "query", "schema", "seed", "transaction"],
      files: ["prisma/schema.prisma", "prisma/**", "src/**/repository*", "services/**/repository*"],
      dependencies: ["prisma", "@prisma/client"],
      negatives: ["frontend-only", "css-only"]
    }));
  }
  if (hasPlatform("typeorm")) {
    skills.push(skill({
      id: "database-typeorm",
      name: "Database TypeORM",
      description: "Use for TypeORM entities, relations, repositories, QueryBuilder, transactions, and migrations.",
      prompts: ["typeorm", "entity", "repository", "querybuilder", "migration", "transaction", "relation"],
      files: ["src/**/*.entity.ts", "src/migrations/**", "ormconfig.*", "src/data-source.ts"],
      dependencies: ["typeorm", "@nestjs/typeorm"],
      negatives: ["frontend-only", "css-only"]
    }));
  }
  if (hasPlatform("postgresql")) {
    skills.push(skill({
      id: "database-postgresql",
      name: "Database PostgreSQL",
      description: "Use for schema design, indexing, query performance, transactions, and migration safety on PostgreSQL.",
      prompts: ["postgres", "postgresql", "index", "query performance", "n+1", "constraint", "migration"],
      files: ["prisma/schema.prisma", "src/migrations/**", "src/**/*.entity.ts"],
      dependencies: ["pg"],
      negatives: ["frontend-only", "mongodb"]
    }));
  }
  if (hasPlatform("redis")) {
    skills.push(skill({
      id: "redis-cache",
      name: "Redis Cache",
      description: "Use for cache, queues, sessions, rate limits, Redis clients, and invalidation behavior.",
      prompts: ["redis", "cache", "queue", "session", "rate limit", "invalidation"],
      files: ["src/**/cache*", "services/**/cache*", "libs/**/cache*"],
      dependencies: ["redis", "ioredis", "bullmq"],
      negatives: ["static page"]
    }));
  }
  if (hasPlatform("docker") || hasPlatform("github-actions")) {
    skills.push(skill({
      id: "ci-deployment",
      name: "CI Deployment",
      description: "Use for Docker, GitHub Actions, build logs, deploy failures, environment variables, and release pipelines.",
      prompts: ["ci", "github actions", "docker", "deploy", "build failed", "pipeline", "environment", "secret"],
      files: [".github/workflows/*", "Dockerfile", "docker-compose.yml", "railway.json", "render.yaml"],
      dependencies: [],
      negatives: ["local ui styling only"]
    }));
  }
  if (hasPlatform("testing")) {
    skills.push(skill({
      id: "project-testing",
      name: "Project Testing",
      description: "Use for unit, integration, e2e, Jest, Vitest, Playwright, and focused verification tasks.",
      prompts: ["test", "jest", "vitest", "playwright", "e2e", "coverage", "failing test"],
      files: ["test/**", "__tests__/**", "*.spec.*", "*.test.*", "playwright.config.ts"],
      dependencies: ["jest", "vitest", "@playwright/test"],
      negatives: ["docs-only"]
    }));
  }
  while (skills.length < STARTER_SKILL_LIMIT) {
    const fallback = [
      skill({
        id: "project-implementation",
        name: "Project Implementation",
        description: "Use for normal feature work, bug fixes, and scoped implementation tasks in this repository.",
        prompts: ["implement", "fix", "add", "update", "refactor", "bug"],
        files: ["src/**", "apps/**", "services/**", "libs/**"],
        dependencies: [],
        negatives: ["release notes only"]
      }),
      skill({
        id: "project-debugging",
        name: "Project Debugging",
        description: "Use for runtime errors, failed commands, logs, CI failures, and root-cause analysis.",
        prompts: ["error", "failed", "timeout", "debug", "logs", "cannot", "fix"],
        files: ["package.json", ".github/workflows/*", "src/**", "services/**"],
        dependencies: [],
        negatives: ["new feature with no failure"]
      }),
      skill({
        id: "project-documentation",
        name: "Project Documentation",
        description: "Use for README, changelog, architecture notes, specs, and project documentation updates.",
        prompts: ["readme", "docs", "documentation", "changelog", "spec", "guide"],
        files: ["README.md", "docs/**", "CHANGELOG.md", "AGENTS.md"],
        dependencies: [],
        negatives: ["runtime bug"]
      })
    ].find((item) => !skills.some((existing) => existing.id === item.id));
    if (!fallback) break;
    skills.push(fallback);
  }
  return dedupeById(skills);
}

function skill({ id, name, description, prompts, files, dependencies, negatives }) {
  return { id, name, description, prompts, files, dependencies, negatives };
}

function renderSkillMarkdown(skill) {
  return [
    "---",
    `name: ${skill.id}`,
    `description: ${skill.description}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    "Use this skill when the prompt and project evidence match the metadata in `skill.yaml`.",
    "",
    "Before editing:",
    "",
    "1. Read the relevant project rules.",
    "2. Inspect the suggested files and nearby tests.",
    "3. Keep the change scoped to the task.",
    "4. Run the focused verification command before final response.",
    ""
  ].join("\n");
}

function renderSkillYaml(skill) {
  return [
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "positive_triggers:",
    "  prompts:",
    ...skill.prompts.map((item) => `    - ${quoteYaml(item)}`),
    "  files:",
    ...skill.files.map((item) => `    - ${quoteYaml(item)}`),
    "  dependencies:",
    ...(skill.dependencies.length ? skill.dependencies.map((item) => `    - ${quoteYaml(item)}`) : ["    - package.json"]),
    "evidence:",
    "  files:",
    ...skill.files.slice(0, 4).map((item) => `    - ${quoteYaml(item)}`),
    "  dependencies:",
    ...(skill.dependencies.length ? skill.dependencies.map((item) => `    - ${quoteYaml(item)}`) : ["    - package.json"]),
    "negative_triggers:",
    "  prompts:",
    ...skill.negatives.map((item) => `    - ${quoteYaml(item)}`),
    "workflow:",
    "  - Inspect repo evidence before choosing an implementation path.",
    "  - Read the suggested files and nearest tests.",
    "  - Implement the smallest scoped change.",
    "  - Run focused verification and summarize evidence.",
    ""
  ].join("\n");
}

function renderPrimaryWorkflow(profile, skills) {
  return [
    "# Primary Workflow",
    "",
    `Use this workflow for common tasks in this repository. Detected project context: ${profile.summary}.`,
    "",
    "planner -> tester -> code-reviewer -> docs-manager",
    "",
    "1. Read the task and relevant AGENTS.md rules.",
    "2. Check BackendGuard suggested files and skills.",
    "3. Inspect project config before choosing a deployment/framework path.",
    "4. Implement the smallest scoped change.",
    "5. Run focused tests or the closest available verification.",
    "6. Summarize files changed, verification, and any remaining risk.",
    "",
    "Starter skills:",
    ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
    ""
  ].join("\n");
}

function writeFile({ filePath, content, force, created, skipped }) {
  if (fs.existsSync(filePath) && !force) {
    skipped.push(filePath);
    return;
  }
  fs.writeFileSync(filePath, content, "utf8");
  created.push(filePath);
}

function findPackageJsonFiles(root) {
  const files = [];
  walk(root, files, (filePath) => path.basename(filePath) === "package.json", 0);
  return files.slice(0, 20);
}

function findExisting(root, relativePaths) {
  return relativePaths.filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
}

// Directories that legitimately hold OTHER projects' package.json files (test
// fixtures, example apps, eval harnesses) rather than the current repo's own
// workspace packages. Walking into these caused stack detection to merge
// unrelated dependencies into the top-level report (e.g. this repo's own
// eval/skill-routing/fixtures/*/package.json files leaking NestJS/Prisma/Redis
// into `backendguard stack` run on backendguard's own, unrelated, repo).
const NON_WORKSPACE_DIR_NAMES = new Set([
  "node_modules", ".git", ".ctx",
  "fixtures", "__fixtures__", "test", "tests", "__tests__", "spec", "specs",
  "e2e", "examples", "example"
]);

function walk(directory, files, predicate, depth) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (NON_WORKSPACE_DIR_NAMES.has(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
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

function findProjectRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function dedupeById(skills) {
  const seen = new Set();
  const result = [];
  for (const skill of skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    result.push(skill);
  }
  return result;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}
