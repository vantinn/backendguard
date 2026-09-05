import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates an isolated temp directory for a fixture project. */
export function makeFixture(label = "fixture") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `backendguard-${label}-`));
}

/** Writes `{ relativePath: content }` into a fixture directory. */
export function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return root;
}
