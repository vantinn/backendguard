import fs from "node:fs";
import path from "node:path";

import { safeReadText } from "./fs-utils.js";

function findProjectRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function pathChain(root, cwd) {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedRoot, resolvedCwd);
  const parts = relative && !relative.startsWith("..") ? relative.split(path.sep) : [];
  const chain = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of parts) {
    current = path.join(current, part);
    chain.push(current);
  }
  return chain;
}

export function readAgentsChain({ cwd = process.cwd(), home = process.env.HOME } = {}) {
  const files = [];
  if (home) files.push(path.join(home, ".codex", "AGENTS.md"));

  const root = findProjectRoot(cwd);
  for (const directory of pathChain(root, cwd)) {
    files.push(path.join(directory, "AGENTS.md"));
  }

  const sources = [];
  const sections = [];
  const seen = new Set();

  for (const filePath of files) {
    if (seen.has(filePath) || !fs.existsSync(filePath)) continue;
    seen.add(filePath);
    const content = safeReadText(filePath).trim();
    if (!content) continue;
    sources.push(filePath);
    sections.push(`## Source: ${filePath}\n${content}`);
  }

  return {
    root,
    sources,
    content: sections.join("\n\n")
  };
}
