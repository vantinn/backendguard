import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAME = "@vantin/backendguard";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const REQUEST_TIMEOUT_MS = 3000;

function cacheFilePath(dataDir) {
  return path.join(dataDir, ".update-check.json");
}

function readCache(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(dataDir, data) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cacheFilePath(dataDir), JSON.stringify(data), "utf8");
  } catch {
    // best-effort
  }
}

async function fetchLatestVersion() {
  const https = await import("node:https");
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(current, latest) {
  const parse = (v) => String(v || "").replace(/^v/, "").split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return 1;
    if ((l[i] || 0) < (c[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check for updates in background (non-blocking).
 * Returns a function that, when called, prints the update message if available.
 *
 * Usage:
 *   const notify = checkForUpdate({ currentVersion, dataDir });
 *   // ... run CLI command ...
 *   await notify(); // prints update message at the very end
 */
export function checkForUpdate({ currentVersion, dataDir, env = process.env }) {
  // A CLI that contacts the network on every invocation is a problem in CI, in
  // an air-gapped environment, and for anyone who does not want a registry to
  // learn how often they run it. Honour the de-facto standard opt-outs.
  if (isUpdateCheckDisabled(env)) return async () => {};

  let resultPromise = null;

  // Start background check lazily
  function startCheck() {
    if (resultPromise) return resultPromise;
    resultPromise = (async () => {
      try {
        const cache = readCache(dataDir);
        const isFresh = cache && typeof cache.checkedAt === "number" && (Date.now() - cache.checkedAt < CHECK_INTERVAL_MS);

        if (isFresh) {
          return cache.latestVersion && compareVersions(currentVersion, cache.latestVersion) > 0
            ? cache.latestVersion
            : null;
        }

        const latestVersion = await fetchLatestVersion();
        if (latestVersion) {
          writeCache(dataDir, { checkedAt: Date.now(), latestVersion });
        }

        return latestVersion && compareVersions(currentVersion, latestVersion) > 0
          ? latestVersion
          : null;
      } catch {
        return null;
      }
    })();
    return resultPromise;
  }

  // Start immediately (non-blocking)
  startCheck();

  return async () => {
    const latestVersion = await startCheck();
    if (latestVersion) {
      console.error(formatUpdateBox(currentVersion, latestVersion));
    }
  };
}

export function isUpdateCheckDisabled(env = process.env) {
  return Boolean(
    env.BACKENDGUARD_NO_UPDATE_CHECK
    || env.BACKENDGUARD_SKIP_UPDATE_CHECK
    || env.NO_UPDATE_NOTIFIER
    || env.CI
  );
}

function formatUpdateBox(currentVersion, latestVersion) {
  const lines = [
    `Update available: ${currentVersion} → ${latestVersion}`,
    "",
    `Run: npm install -g ${PACKAGE_NAME}`,
    `Then run: backendguard install --agents codex`,
  ];
  const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const width = maxLen + 4;
  const pad = (text) => `│ ${text.padEnd(width - 4)} │`;
  const top = `╭${"─".repeat(width - 2)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  return ["", top, ...lines.map(pad), bottom, ""].join("\n");
}
