import fs from "node:fs";
import path from "node:path";

/**
 * Bounded, deterministic collection of the source files analyzers work on.
 *
 * Every bound exists for a reason and is documented rather than tuned by feel:
 * an analysis run has to stay usable on a large monorepo, and it must never
 * follow a path out of the project it was pointed at.
 */

export const DEFAULT_LIMITS = {
  // A 500-file NestJS service parses in well under a second; beyond a few
  // thousand the TypeScript parser dominates the CLI's runtime, so the scan is
  // capped and the cap is reported rather than silently applied.
  maxFiles: 2000,
  // Anything larger than this in a backend project is generated (bundles,
  // lockfile-like data, seeded SQL dumps) and parsing it is wasted work.
  maxFileBytes: 512_000,
  maxDepth: 12
};

export const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
export const SCHEMA_EXTENSIONS = new Set([".prisma"]);
export const SQL_EXTENSIONS = new Set([".sql"]);

/**
 * Directories that never contain first-party application source. `test`/`spec`/
 * `fixtures` are excluded because a fixture that deliberately contains an
 * insecure pattern is not a finding about the project.
 */
export const EXCLUDED_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "coverage", "tmp", "vendor",
  "test", "tests", "__tests__", "spec", "specs", "e2e",
  "fixtures", "__fixtures__", "__mocks__", "mocks",
  "generated", "migrations-lock"
]);

/**
 * @param {string} root Absolute project root.
 * @param {{include?: Set<string>, limits?: object, includeTests?: boolean}} options
 * @returns {{files: string[], truncated: boolean, scanned: number}}
 *   `files` are project-relative and sorted, so two runs over the same tree
 *   produce identical output.
 */
export function collectSourceFiles(root, {
  include = SOURCE_EXTENSIONS,
  limits = DEFAULT_LIMITS,
  includeTests = false
} = {}) {
  const files = [];
  const state = { scanned: 0, truncated: false, skippedForSize: [] };
  walk(root, root, files, state, { include, limits, includeTests }, 0);
  files.sort();
  return { files, truncated: state.truncated, scanned: state.scanned, skippedForSize: state.skippedForSize };
}

/**
 * Every path this module hands out uses forward slashes, on every platform.
 *
 * `path.relative()` yields `src\users\x.ts` on Windows, while git — the other
 * source of file paths in this system — always reports `src/users/x.ts`. The
 * two were joined by a `Set.has()` in `analyzeChangedFiles`, so on Windows the
 * filter matched nothing and `backendguard check` reported **no structural
 * findings at all**, silently. Normalising at this boundary is the fix; every
 * consumer downstream can then compare paths as plain strings.
 */
export function toPosix(filePath) {
  return String(filePath).split(path.sep).join("/");
}

export function collectTypeScriptFiles(root, options = {}) {
  return collectSourceFiles(root, { ...options, include: SOURCE_EXTENSIONS });
}

export function collectPrismaSchemas(root, options = {}) {
  return collectSourceFiles(root, { ...options, include: SCHEMA_EXTENSIONS });
}

export function collectSqlFiles(root, options = {}) {
  return collectSourceFiles(root, { ...options, include: SQL_EXTENSIONS });
}

function walk(root, dir, files, state, options, depth) {
  if (state.truncated || depth > options.limits.maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sorted traversal keeps the file list stable across filesystems.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= options.limits.maxFiles) {
      state.truncated = true;
      return;
    }
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a link out of the project
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) && !(options.includeTests && isTestDirName(entry.name))) continue;
      walk(root, fullPath, files, state, options, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!options.include.has(path.extname(entry.name))) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    let size = 0;
    try {
      size = fs.statSync(fullPath).size;
    } catch {
      continue;
    }
    state.scanned += 1;
    if (size > options.limits.maxFileBytes) {
      state.skippedForSize.push(toPosix(path.relative(root, fullPath)));
      continue;
    }
    files.push(toPosix(path.relative(root, fullPath)));
  }
}

function isTestDirName(name) {
  return ["test", "tests", "__tests__", "spec", "specs", "e2e"].includes(name);
}

export function readSource(root, relativePath, limits = DEFAULT_LIMITS) {
  const absolute = path.resolve(root, ...String(relativePath).split("/"));
  // Defence in depth: a caller could pass a path from an untrusted manifest.
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    if (fs.statSync(absolute).size > limits.maxFileBytes) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}
