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

export function copyPackageRoot({ rootDir, targetRoot }) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const entry of [".agents", "bin", "plugins", "eval", "docs", "package.json", "package-lock.json", "README.md", "CHANGELOG.md", "DEMO.md", "LAUNCH.md", "LICENSE", "node_modules"]) {
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
