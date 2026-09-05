import fs from "node:fs";
import path from "node:path";

import { ConfigurationError, EnvironmentError } from "./errors.js";

export function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeJsonFile(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonLine(filePath, value) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Reads a JSON config file that BackendGuard is about to merge into and rewrite.
 *
 * A file that exists but does not parse is the user's, and it holds their data:
 * `~/.claude.json` carries every project Claude Code knows about. The install
 * paths used to handle this two ways, both wrong — one parsed with no guard and
 * crashed with "This is a bug in BackendGuard", the rest warned and then
 * **overwrote the file with defaults**, discarding whatever the user had.
 *
 * Neither is acceptable for a file BackendGuard does not own, so a corrupt
 * config is now a `ConfigurationError`: it names the file, says what to do, and
 * leaves the bytes alone.
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Guards a config value BackendGuard is about to merge a key into.
 *
 * `typeof [] === "object"`, so an array passed every previous shape check.
 * Adding a named property to an array is silently dropped by
 * `JSON.stringify`, so a `~/.claude.json` holding `[]` — or an `mcpServers`
 * holding `["a"]` — produced an install that reported success and registered
 * no MCP server at all.
 */
export function assertMergeableConfig(value, { path: filePath, key = null } = {}) {
  if (value === undefined || value === null) return {};
  if (isPlainObject(value)) return value;
  const what = key ? `The "${key}" value in ${filePath || "the configuration"}` : `${filePath || "The configuration"}`;
  const found = Array.isArray(value) ? "an array" : `a ${typeof value}`;
  throw new ConfigurationError(`${what} is ${found}, not an object, so BackendGuard cannot merge into it.`, {
    hint: "Fix the file by hand, or move it aside and re-run — BackendGuard will create a fresh one. It has not been modified.",
    path: filePath
  });
}

export function readJsonConfig(filePath, fallback = {}, { label = "configuration file" } = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    // Every reason a config path cannot be read — permissions, a directory
    // where a file was expected, a symlink loop — is the environment's, not a
    // fault in BackendGuard. `EISDIR` used to reach the user as exit code 70.
    throw classifyReadError(error, filePath, label);
  }
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(`${filePath} is not valid JSON, so BackendGuard will not rewrite it.`, {
      hint: `Fix the JSON (${error.message}), or move the file aside and re-run — BackendGuard will create a fresh one.`,
      path: filePath
    });
  }
  // Valid JSON of the wrong shape is still unmergeable, and is still the
  // user's file. `null` is treated as "empty", which is what it means here.
  if (parsed === null) return fallback;
  return assertMergeableConfig(parsed, { path: filePath });
}

/**
 * Writes a config file BackendGuard owns a key inside, atomically.
 *
 * Two problems this solves:
 *
 * 1. A plain `writeFileSync` to a read-only or root-owned config raised a raw
 *    `EACCES`, which reached the user as exit code 70 and "This is a bug in
 *    BackendGuard" — a file-permission problem on their machine.
 * 2. A direct write truncates the file before it writes. Interrupting the
 *    process at that moment left a zero-length or half-written config, which
 *    the next run then refused to parse. Writing to a sibling temp file and
 *    renaming makes the replacement atomic, so an interrupted run leaves the
 *    previous config intact.
 *
 * A symlinked config (a dotfiles repo, commonly) is resolved first, so the
 * rename replaces the *target* and the symlink itself survives.
 */
export function writeJsonConfig(filePath, value) {
  const target = resolveSymlink(filePath);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.bg-${process.pid}-${Date.now()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, contents, "utf8");
    // Keep the original file's permissions rather than the temp file's.
    try {
      fs.chmodSync(temporary, fs.statSync(target).mode & 0o777);
    } catch { /* the file may not exist yet; the default mode is correct then */ }
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch { /* best effort */ }
    throw classifyWriteError(error, target);
  }
  return filePath;
}

function resolveSymlink(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return fs.realpathSync(filePath);
  } catch { /* missing file, or a broken symlink: write where we were asked */ }
  return filePath;
}

/**
 * A filesystem that will not accept the write is the environment's problem,
 * not a defect in BackendGuard.
 */
export function classifyWriteError(error, filePath) {
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new ConfigurationError(`Cannot write ${filePath}: permission denied.`, {
      hint: "Check the file's owner and permissions, then re-run. BackendGuard has not modified it.",
      path: filePath
    });
  }
  if (error?.code === "EROFS") {
    return new EnvironmentError(`Cannot write ${filePath}: the filesystem is read-only.`, {
      hint: "Re-run against a writable location."
    });
  }
  if (error?.code === "ENOSPC") {
    return new EnvironmentError(`Cannot write ${filePath}: no space left on device.`, {
      hint: "Free some disk space and re-run."
    });
  }
  if (error?.code === "EISDIR") {
    return new ConfigurationError(`Cannot write ${filePath}: it is a directory, not a file.`, {
      hint: "Move or remove that directory, then re-run.",
      path: filePath
    });
  }
  if (error?.code === "ENAMETOOLONG" || error?.code === "ELOOP") {
    return new ConfigurationError(`Cannot write ${filePath}: ${error.code === "ELOOP" ? "too many symbolic links" : "the path is too long"}.`, {
      hint: "Point the configuration path at a normal file.",
      path: filePath
    });
  }
  return error;
}

/** Read-side counterpart of `classifyWriteError`. */
export function classifyReadError(error, filePath, label = "configuration file") {
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new ConfigurationError(`Cannot read ${label}: permission denied for ${filePath}.`, {
      hint: "Check the file's permissions, or run from an account that can read it.",
      path: filePath
    });
  }
  if (error?.code === "EISDIR") {
    return new ConfigurationError(`${filePath} is a directory, but BackendGuard expected a ${label}.`, {
      hint: "Point the configuration path at a file, or move that directory aside.",
      path: filePath
    });
  }
  if (error?.code === "ELOOP") {
    return new ConfigurationError(`${filePath} is a symbolic link that points at itself.`, {
      hint: "Repair the link, or move it aside and re-run.",
      path: filePath
    });
  }
  if (error?.code === "ENAMETOOLONG") {
    return new ConfigurationError(`${filePath} is too long a path to read.`, {
      hint: "Point the configuration path at a shorter path.",
      path: filePath
    });
  }
  return error;
}
