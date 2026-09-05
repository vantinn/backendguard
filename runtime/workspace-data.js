import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER_DIR = ".backendguard";
const MARKER_FILE = "workspace.json";
const IGNORE_ENTRY = ".backendguard/";

// Historic location used before 0.9.0, when the tool was still named `ctx`.
// Existing installs keep their warmed embedding model and caches: if the new
// root does not exist yet but the legacy one does, the legacy one is used until
// the user removes it. Nothing is copied or deleted automatically.
const LEGACY_DATA_ROOT_SEGMENTS = [".ctx", "backendguard"];

export function defaultDataRoot({ home = os.homedir(), exists = fs.existsSync } = {}) {
  const configured = process.env.PLUGIN_DATA || process.env.BACKENDGUARD_HOME;
  if (configured) return configured;
  const current = path.join(home, ".backendguard");
  if (exists(current)) return current;
  const legacy = path.join(home, ...LEGACY_DATA_ROOT_SEGMENTS);
  if (exists(legacy)) return legacy;
  return current;
}

export function legacyDataRoot(home = os.homedir()) {
  return path.join(home, ...LEGACY_DATA_ROOT_SEGMENTS);
}

export function workspaceDataDir({ cwd = process.cwd(), dataRoot = defaultDataRoot(), createMarker = true } = {}) {
  const id = workspaceId({ cwd, createMarker });
  const dir = path.join(dataRoot, "workspaces", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspaceId({ cwd = process.cwd(), createMarker = true } = {}) {
  const root = resolveWorkspaceRoot(cwd);
  const markerPath = path.join(root, MARKER_DIR, MARKER_FILE);
  const existing = readMarker(markerPath);
  if (existing?.id) return existing.id;

  const id = deterministicWorkspaceId(root);
  if (createMarker) writeMarker({ root, markerPath, id });
  return id;
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function workspaceMarkerPath(cwd = process.cwd()) {
  return path.join(resolveWorkspaceRoot(cwd), MARKER_DIR, MARKER_FILE);
}

function deterministicWorkspaceId(root) {
  const base = path.basename(root) || "workspace";
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

function readMarker(markerPath) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker({ root, markerPath, id }) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({ id, root }, null, 2)}\n`, "utf8");
    ensureGitignore(root);
  } catch {
    // Marker files are only for stable local identity; deterministic ids still work.
  }
}

function ensureGitignore(root) {
  const gitignorePath = path.join(root, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    // Missing .gitignore is fine; create one below.
  }
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(IGNORE_ENTRY)) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}${IGNORE_ENTRY}\n`, "utf8");
}
