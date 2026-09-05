import fs from "node:fs";
import path from "node:path";

import { ConfigurationError } from "./errors.js";

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
export function readJsonConfig(filePath, fallback = {}, { label = "configuration file" } = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new ConfigurationError(`Cannot read ${label}: permission denied for ${filePath}.`, {
        hint: "Check the file's permissions, or run from an account that can read it.",
        path: filePath
      });
    }
    throw error;
  }
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError(`${filePath} is not valid JSON, so BackendGuard will not rewrite it.`, {
      hint: `Fix the JSON (${error.message}), or move the file aside and re-run — BackendGuard will create a fresh one.`,
      path: filePath
    });
  }
}
