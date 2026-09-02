import fs from "node:fs";
import path from "node:path";

/**
 * Entries to exclude inside the installed backendguard directory.
 * Keeps node_modules, bin, lib, and mcp out of version control.
 */
const INNER_GITIGNORE_ENTRIES = [
  "node_modules/",
  "bin/",
  "lib/",
  "mcp/",
];

/**
 * Entries that ctx install should add to the project root .gitignore.
 *
 * .codex/marketplaces/backendguard/ — Codex agent install dir
 * .claude/settings.json          — Claude hooks written by ctx install
 * .gemini/                       — Antigravity hooks/config
 */
const ROOT_GITIGNORE_ENTRIES = [
  ".codex/marketplaces/backendguard/",
  ".claude/settings.json",
  ".gemini/",
];

/**
 * Write a .gitignore inside `dir` that excludes build/runtime artefacts.
 * Creates the directory if it does not exist yet.
 */
export function writeInnerGitignore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gitignorePath = path.join(dir, ".gitignore");
  const content = INNER_GITIGNORE_ENTRIES.join("\n") + "\n";
  fs.writeFileSync(gitignorePath, content, "utf8");
  return gitignorePath;
}

/**
 * Ensure the project root .gitignore exists and contains the entries
 * needed to keep ctx install artefacts out of version control.
 *
 * Only appends entries that are not already present.
 * Creates the file if it does not exist.
 */
export function ensureRootGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = existing.split("\n");
  const missing = ROOT_GITIGNORE_ENTRIES.filter(
    (entry) => !lines.some((line) => line.trim() === entry)
  );

  if (missing.length === 0) return gitignorePath;

  const block = [
    "",
    "# BackendGuard install artefacts",
    ...missing,
  ].join("\n") + "\n";

  fs.writeFileSync(gitignorePath, existing.trimEnd() + "\n" + block, "utf8");
  return gitignorePath;
}
