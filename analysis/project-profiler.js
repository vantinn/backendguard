import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE_CACHE_FILE = "project-profile.json";
const MAX_DEPENDENCIES = 80;
const MAX_SCRIPTS = 30;
const MAX_RECENT_FILES = 20;
const MAX_FUSED_PROFILE_CHARS = 500;

export function projectProfile({ cwd = process.cwd(), dataDir } = {}) {
  const fingerprint = projectFingerprint(cwd);
  const cachePath = dataDir ? path.join(dataDir, PROFILE_CACHE_FILE) : null;
  const cached = cachePath ? readCachedProfile(cachePath, fingerprint) : null;
  if (cached) return cached;

  const packagePaths = workspacePackagePaths(cwd);
  const packageTexts = packagePaths.map((packagePath) => packageSignal(cwd, packagePath)).filter(Boolean);
  const recentFiles = recentGitFiles(cwd, MAX_RECENT_FILES);
  const languages = languageSignal({ cwd, packagePaths, recentFiles });
  const embeddableString = [
    packageTexts.length ? `[project packages: ${packageTexts.join(" | ")}]` : "",
    languages.length ? `[project languages: ${languages.join(" ")}]` : "",
    recentFiles.length ? `[recent files: ${recentFiles.join(", ")}]` : ""
  ].filter(Boolean).join(" ");

  const profile = { fingerprint, embeddableString };
  if (cachePath) writeCachedProfile(cachePath, profile);
  return profile;
}

export function fusedProjectQuery({ prompt = "", cwd = process.cwd(), dataDir } = {}) {
  const profile = projectProfile({ cwd, dataDir });
  const profileSignal = profile.embeddableString
    ? profile.embeddableString.slice(0, MAX_FUSED_PROFILE_CHARS)
    : "";
  return [String(prompt || "").trim(), profileSignal].filter(Boolean).join("\n");
}

function readCachedProfile(cachePath, fingerprint) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached?.fingerprint === fingerprint && typeof cached.embeddableString === "string") return cached;
  } catch {
    // Cache miss.
  }
  return null;
}

function writeCachedProfile(cachePath, profile) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(profile, null, 2));
  } catch {
    // The profile is an optimization; prompt scoring can continue without a cache write.
  }
}

function projectFingerprint(cwd) {
  const parts = [];
  for (const packagePath of workspacePackagePaths(cwd)) {
    try {
      const stat = fs.statSync(packagePath);
      parts.push(`${path.relative(cwd, packagePath)}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${path.relative(cwd, packagePath)}:missing`);
    }
  }
  parts.push(`git:${gitHead(cwd)}`);
  return parts.join("|");
}

function packageSignal(cwd, packagePath) {
  const packageJson = readJson(packagePath);
  if (!packageJson) return "";
  const packageDir = path.dirname(packagePath);
  const dependencies = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {})
  ].slice(0, MAX_DEPENDENCIES);
  const scripts = Object.keys(packageJson.scripts || {}).slice(0, MAX_SCRIPTS);
  const configFiles = ["app.json", "app.config.js", "app.config.ts", "eas.json", "tsconfig.json", "Dockerfile"]
    .filter((fileName) => fs.existsSync(path.join(packageDir, fileName)));
  return [
    path.relative(cwd, packagePath) || "package.json",
    packageJson.name,
    packageJson.description,
    Array.isArray(packageJson.keywords) ? packageJson.keywords.join(" ") : "",
    dependencies.join(" "),
    scripts.length ? `scripts ${scripts.join(" ")}` : "",
    configFiles.join(" ")
  ].filter(Boolean).join(" ");
}

function languageSignal({ cwd, packagePaths, recentFiles }) {
  const values = new Set();
  for (const packagePath of packagePaths) {
    const packageDir = path.dirname(packagePath);
    const packageJson = readJson(packagePath);
    const deps = normalize(Object.keys({
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {})
    }).join(" "));
    if (deps.includes("typescript") || fs.existsSync(path.join(packageDir, "tsconfig.json"))) values.add("TypeScript");
    if (deps.includes("python")) values.add("Python");
    if (deps.includes("go")) values.add("Go");
    if (deps.includes("react")) values.add("React");
    if (deps.includes("next")) values.add("Next.js");
    if (deps.includes("expo") || deps.includes("react native")) values.add("React Native");
  }
  for (const file of recentFiles) {
    const ext = path.extname(file);
    if ([".ts", ".tsx"].includes(ext)) values.add("TypeScript");
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) values.add("JavaScript");
    if (ext === ".py") values.add("Python");
    if (ext === ".go") values.add("Go");
    if (ext === ".rs") values.add("Rust");
    if (ext === ".java") values.add("Java");
  }
  if (!values.size && fs.existsSync(path.join(cwd, "package.json"))) values.add("JavaScript");
  return [...values];
}

function recentGitFiles(cwd, limit) {
  try {
    const output = execFileSync("git", ["log", "--name-only", "--pretty=format:", "-n", "30"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 300
    });
    const seen = new Set();
    for (const line of output.split(/\r?\n/)) {
      const file = line.trim();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (seen.size >= limit) break;
    }
    return [...seen];
  } catch {
    return [];
  }
}

function gitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 300
    }).trim();
  } catch {
    return "nogit";
  }
}

export function workspacePackagePaths(cwd) {
  const rootPackagePath = path.join(cwd, "package.json");
  const rootPackage = readJson(rootPackagePath);
  const paths = new Set(fs.existsSync(rootPackagePath) ? [rootPackagePath] : []);
  for (const workspace of workspacePatterns(rootPackage?.workspaces)) {
    for (const packagePath of expandWorkspacePattern({ cwd, pattern: workspace })) {
      paths.add(packagePath);
    }
  }
  return [...paths];
}

function workspacePatterns(workspaces) {
  if (Array.isArray(workspaces)) return workspaces.filter((item) => typeof item === "string");
  if (Array.isArray(workspaces?.packages)) return workspaces.packages.filter((item) => typeof item === "string");
  return [];
}

function expandWorkspacePattern({ cwd, pattern }) {
  const normalizedPattern = String(pattern || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalizedPattern || normalizedPattern.startsWith("..") || path.isAbsolute(normalizedPattern)) return [];
  if (!normalizedPattern.includes("*")) {
    const packagePath = path.join(cwd, normalizedPattern, "package.json");
    return fs.existsSync(packagePath) ? [packagePath] : [];
  }
  const parts = normalizedPattern.split("/");
  const starIndex = parts.indexOf("*");
  if (starIndex < 0 || parts.includes("**")) return [];
  const baseDir = path.join(cwd, ...parts.slice(0, starIndex));
  const suffix = parts.slice(starIndex + 1);
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(baseDir, entry.name, ...suffix, "package.json"))
    .filter((packagePath) => fs.existsSync(packagePath));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
