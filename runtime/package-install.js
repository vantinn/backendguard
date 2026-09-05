import fs from "node:fs";
import path from "node:path";

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      fs.chmodSync(destPath, fs.statSync(srcPath).mode);
    }
  }
}

export function copyPath(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    copyDir(src, dest);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, stat.mode);
  }
}

// Everything an installed copy needs to run standalone: the CLI, every source
// domain, the agent plugin, the shipped skill packs, and node_modules. Kept in
// one place so adding a domain directory cannot silently break installs.
export const PACKAGE_ROOT_ENTRIES = [
  ".agents",
  ".codex",
  "cli",
  "rules",
  "retrieval",
  "analysis",
  "compliance",
  "agent-context",
  "integrations",
  "runtime",
  "evaluation",
  "skills",
  "tooling",
  "plugins",
  "docs",
  "package.json",
  "package-lock.json",
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  "node_modules"
];

export function copyPackageRoot({ rootDir, targetRoot }) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const entry of PACKAGE_ROOT_ENTRIES) {
    const src = path.join(rootDir, entry);
    if (fs.existsSync(src)) copyPath(src, path.join(targetRoot, entry));
  }
  return targetRoot;
}

export function syncPackageRoot({ rootDir, targetRoot }) {
  if (path.resolve(rootDir) === path.resolve(targetRoot)) {
    return { targetRoot, synced: false };
  }
  copyPackageRoot({ rootDir, targetRoot });
  return { targetRoot, synced: true };
}
