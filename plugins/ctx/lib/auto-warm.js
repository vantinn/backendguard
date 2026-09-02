import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

export function maybeAutoWarmWorkspace({
  cwd = process.cwd(),
  prompt = "",
  dataDir,
  reason,
  now = Date.now(),
  spawnProcess = spawn,
  cooldownMs = Number(process.env.BACKENDGUARD_AUTO_WARM_COOLDOWN_MS || DEFAULT_COOLDOWN_MS)
} = {}) {
  if (process.env.BACKENDGUARD_AUTO_WARM === "0") return { status: "disabled" };
  if (!dataDir) return { status: "skipped", reason: "missing-data-dir" };
  if (!String(prompt || "").trim()) return { status: "skipped", reason: "missing-prompt" };
  if (!shouldAutoWarm(reason)) return { status: "skipped", reason: "not-actionable" };

  const markerPath = path.join(dataDir, "auto-warm.json");
  const existing = readJson(markerPath);
  if (existing?.startedAt) {
    const ageMs = now - Date.parse(existing.startedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      return { status: "cooldown", markerPath, ageMs };
    }
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      startedAt: new Date(now).toISOString(),
      cwd,
      reason,
      prompt: String(prompt).slice(0, 300)
    }, null, 2)}\n`, "utf8");
  } catch {
    return { status: "skipped", reason: "marker-write-failed" };
  }

  const child = spawnProcess(process.execPath, [ctxBinPath(), "autowarm", "--", prompt], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      BACKENDGUARD_AUTO_WARM_CHILD: "1"
    }
  });
  child.on?.("error", () => {});
  child.unref?.();
  return { status: "started", pid: child.pid, markerPath };
}

function shouldAutoWarm(reason) {
  if (reason === "no-context-candidates") return true;
  if (reason === "enabled-sections-empty-after-formatting") return true;
  if (String(reason || "").startsWith("enabled-sections-missing-candidates:")) return true;
  return false;
}

function ctxBinPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../bin/ctx.js");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
