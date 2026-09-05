#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , sourceArg = "external-skills", targetArg = "skills"] = process.argv;
const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);
const skip = new Set([".git", ".github", "scripts"]);

if (!fs.existsSync(source)) {
  console.error(`Missing source skills directory: ${source}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });

for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
  if (entry.isDirectory()) fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  else if (entry.isFile() && entry.name !== "README.md") fs.rmSync(path.join(target, entry.name), { force: true });
}

for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (skip.has(entry.name)) continue;
  const from = path.join(source, entry.name);
  const to = path.join(target, entry.name);
  if (entry.isDirectory()) copyDir(from, to);
  else if (entry.isFile() && entry.name === "README.md") fs.copyFileSync(from, to);
}

console.log(`Synced BackendGuard skills from ${source} to ${target}`);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
  }
}
