import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execSync } from "node:child_process";
import { runProcess } from "../runtime/process-runner.js";
import { shellInvocation } from "../runtime/shell-runner.js";
import { EnvironmentError, UsageError } from "../runtime/errors.js";

const DEFAULT_AGENTS = ["codex", "claude", "antigravity", "copilot"];
const INSTALL_SH_URL = "https://raw.githubusercontent.com/runkids/skillshare/main/install.sh";
const INSTALL_PS_URL = "https://raw.githubusercontent.com/runkids/skillshare/main/install.ps1";
const AGENT_ALIASES = new Map([
  ["agy", "antigravity"],
  ["antigravity", "antigravity"],
  ["codex", "codex"],
  ["claude", "claude"],
  ["copilot", "copilot"]
]);

function statusLine(label, value) {
  return `[backendguard] ${label.padEnd(38)} ${value}`;
}

function normalizeStdio(stdio) {
  // "pipe" creates a stdin pipe whose write-end is held by Node while
  // execSync/execFileSync blocks on waitpid — if the child reads stdin
  // it deadlocks.  Route stdin to NUL (/dev/null) so the child sees
  // immediate EOF, while still piping stdout/stderr for capture.
  return stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio;
}

function runCommand(command, args = [], { cwd = process.cwd(), stdio = "pipe", dryRun = false } = {}) {
  if (dryRun) return { stdout: "", skipped: true };
  // Arguments are passed to the process directly, never through a shell —
  // agent names and paths reach here from user input.
  return runProcess(command, args, { cwd, stdio: normalizeStdio(stdio) });
}

function runShell(command, { cwd = process.cwd(), stdio = "pipe", dryRun = false } = {}) {
  if (dryRun) return { stdout: "", skipped: true };
  const stdout = execSync(command, { cwd, stdio: normalizeStdio(stdio), encoding: "utf8" });
  return { stdout: stdout || "" };
}

export function parseSyncSkillsArgs(args = []) {
  const agentsFlag = args.indexOf("--agents");
  const agents = agentsFlag >= 0
    ? normalizeAgentList(String(args[agentsFlag + 1] || "").split(","))
    : DEFAULT_AGENTS;
  return {
    skills: args.includes("--skills"),
    agents,
    dryRun: args.includes("--dry-run"),
    noCollect: args.includes("--no-collect"),
    noEmbeddings: args.includes("--no-embeddings"),
    verbose: args.includes("--verbose"),
    yes: args.includes("--yes") || args.includes("-y")
  };
}

function normalizeAgentName(agent) {
  const key = String(agent || "").trim().toLowerCase();
  return AGENT_ALIASES.get(key) || key;
}

function normalizeAgentList(agents = []) {
  return [...new Set(agents.map(normalizeAgentName).filter(Boolean))];
}

export function detectOS(platform = process.platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "linux";
}

export function skillshareConfigDir({ home = os.homedir() } = {}) {
  return path.join(home, ".config", "skillshare");
}

export function skillshareSourceDir({ home = os.homedir() } = {}) {
  return readSkillshareSourceDir({ home }) || path.join(skillshareConfigDir({ home }), "skills");
}

function readSkillshareSourceDir({ home = os.homedir() } = {}) {
  const configPath = path.join(skillshareConfigDir({ home }), "config.yaml");
  if (!fs.existsSync(configPath)) return null;
  const content = fs.readFileSync(configPath, "utf8");
  const match = content.match(/^\s{2}skills:\s*(.+?)\s*$/m);
  if (!match) return null;
  return expandHome(match[1].replace(/^["']|["']$/g, ""), home);
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function checkSkillshareInstalled({ run = runCommand } = {}) {
  try {
    const result = run("skillshare", ["--version"]);
    return { installed: true, version: result.stdout.trim() || "installed" };
  } catch {
    return { installed: false, version: "" };
  }
}

async function shouldInstallSkillshare({ yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("[backendguard] skillshare is not installed. Install now? [Y/n] ");
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function installSkillshare({
  run = runCommand,
  runShellCommand = runShell,
  yes = false,
  dryRun = false,
  platform = process.platform
} = {}) {
  const accepted = dryRun || await shouldInstallSkillshare({ yes });
  if (!accepted) {
    throw new EnvironmentError("skillshare is required for `backendguard sync --skills`.", {
      hint: "Install it from https://github.com/runkids/skillshare, or rerun with --yes to install it automatically."
    });
  }

  const osName = detectOS(platform);

  if (dryRun) {
    // dry-run keeps the old sync path
    if (osName === "windows") {
      runShellCommand(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${INSTALL_PS_URL} | iex"`, { stdio: "pipe", dryRun });
    } else {
      runShellCommand(`curl -fsSL ${INSTALL_SH_URL} | sh`, { stdio: "pipe", dryRun });
    }
  } else {
    console.log("Installing skillshare...");
    if (osName === "windows") {
      await spawnShellStreaming("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS_URL} | iex`]);
    } else {
      const shell = shellInvocation(`curl -fsSL ${INSTALL_SH_URL} | sh`, { platform: process.platform });
      await spawnShellStreaming(shell.command, shell.args);
    }
  }

  // The installer adds to the system PATH, but the current Node process
  // still has the old PATH. Inject the known install dir so subsequent
  // skillshare calls in this session can resolve the binary.
  if (!dryRun && osName === "windows") {
    const winInstallDir = path.join(os.homedir(), "AppData", "Local", "Programs", "skillshare");
    if (!process.env.PATH.includes(winInstallDir)) {
      process.env.PATH = `${winInstallDir}${path.delimiter}${process.env.PATH}`;
    }
  }

  const check = checkSkillshareInstalled({ run });
  if (!dryRun && !check.installed) {
    throw new EnvironmentError("skillshare installed but `skillshare --version` still fails.", {
      hint: "Check that the install location is on PATH, or install skillshare manually."
    });
  }
  return check;
}

/**
 * Spawn a child process and stream its stdout/stderr line-by-line in real time
 * via console.log (which will be intercepted by streamSetupOutput for │ prefix).
 * stdin is closed immediately to prevent deadlocks.
 */
function spawnShellStreaming(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    const streamLines = (stream) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) console.log(line);
        }
      });
      stream.on("end", () => {
        if (buffer.trim()) console.log(buffer.trim());
      });
    };

    if (child.stdout) streamLines(child.stdout);
    if (child.stderr) streamLines(child.stderr);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export function detectExistingSkills({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return skillRoots({ cwd, home })
    .map((root) => ({ path: root, count: countSkillFiles(root) }))
    .filter((entry) => entry.count > 0);
}

export function repairSkillSymlinks({
  cwd = process.cwd(),
  home = os.homedir(),
  roots = skillRoots({ cwd, home }),
  dryRun = false
} = {}) {
  const repaired = [];
  const removedBroken = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const linkPath = path.join(root, entry.name);
      const real = safeRealpath(linkPath);
      if (!real) {
        if (!dryRun) fs.rmSync(linkPath, { force: true, recursive: true });
        removedBroken.push(linkPath);
        continue;
      }
      if (!dryRun) {
        fs.rmSync(linkPath, { force: true, recursive: true });
        const stat = fs.statSync(real);
        if (stat.isDirectory()) copyDirectory(real, linkPath);
        else if (stat.isFile()) fs.copyFileSync(real, linkPath);
      }
      repaired.push(linkPath);
    }
  }
  return { repaired: [...new Set(repaired)], removedBroken: [...new Set(removedBroken)] };
}

export function dedupeAgentVisibleSkills({
  cwd = process.cwd(),
  home = os.homedir(),
  agents = DEFAULT_AGENTS,
  dryRun = false
} = {}) {
  const roots = visibleSkillRootsForAgents({ cwd, home, agents });
  const seen = new Map();
  const kept = [];
  const removed = [];

  for (const root of roots) {
    for (const skill of listSkillsInRoot(root)) {
      const previous = seen.get(skill.key);
      if (!previous) {
        seen.set(skill.key, skill);
        kept.push(skill.path);
        continue;
      }

      const previousReal = safeRealpath(previous.path);
      const currentReal = safeRealpath(skill.path);
      if (previousReal && currentReal && previousReal === currentReal) {
        if (!dryRun) fs.rmSync(skill.path, { force: true, recursive: true });
        removed.push(skill.path);
        continue;
      }

      if (!dryRun) fs.rmSync(skill.path, { force: true, recursive: true });
      removed.push(skill.path);
    }
  }

  return { kept: [...new Set(kept)], removed: [...new Set(removed)], roots };
}

function visibleSkillRootsForAgents({ cwd, home, agents }) {
  const normalizedAgents = normalizeAgentList(agents);
  const roots = [];
  const addShared = () => {
    roots.push(path.join(home, ".agents", "skills"));
    roots.push(path.join(cwd, ".agents", "skills"));
  };

  addShared();
  if (normalizedAgents.includes("codex")) {
    roots.push(path.join(home, ".codex", "skills"));
    roots.push(path.join(cwd, ".codex", "skills"));
  }
  if (normalizedAgents.includes("claude")) {
    roots.push(path.join(home, ".claude", "skills"));
    roots.push(path.join(cwd, ".claude", "skills"));
  }
  if (normalizedAgents.includes("antigravity")) {
    roots.push(path.join(home, ".gemini", "skills"));
    roots.push(path.join(home, ".gemini", "antigravity", "skills"));
    roots.push(path.join(home, ".gemini", "antigravity-cli", "skills"));
    roots.push(path.join(cwd, ".gemini", "skills"));
    roots.push(path.join(cwd, ".gemini", "antigravity", "skills"));
    roots.push(path.join(cwd, ".gemini", "antigravity-cli", "skills"));
  }

  return uniquePaths(roots);
}

function listSkillsInRoot(root) {
  return findSkillFiles(root)
    .map((skillFile) => {
      const skillDir = path.dirname(skillFile);
      const name = readSkillName(skillFile) || path.basename(skillDir);
      return {
        name,
        key: normalizeSkillName(name),
        path: skillDir,
        root
      };
    })
    .filter((skill) => skill.key)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readSkillName(skillFile) {
  try {
    const content = fs.readFileSync(skillFile, "utf8");
    return content.match(/^\s*name:\s*(.+?)\s*$/m)?.[1]
      ?.replace(/^["']|["']$/g, "")
      .trim() || "";
  } catch {
    return "";
  }
}

function normalizeSkillName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function skillRoots({ cwd, home }) {
  return uniquePaths([
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".gemini", "antigravity", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".codex", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".gemini", "antigravity", "skills"),
    path.join(cwd, ".gemini", "antigravity-cli", "skills"),
    ...discoverSkillRoots({ cwd, home })
  ]);
}

function antigravityLegacyRoots({ cwd, home }) {
  return uniquePaths([
    path.join(home, ".gemini", "antigravity", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "skills"),
    path.join(cwd, ".gemini", "antigravity", "skills"),
    path.join(cwd, ".gemini", "antigravity-cli", "skills"),
    ...discoverSkillRoots({ cwd, home })
  ]);
}

export function discoverSkillRoots({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const roots = [];
  for (const base of [
    path.join(home, ".gemini"),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".agents"),
    path.join(cwd, ".gemini"),
    path.join(cwd, ".codex"),
    path.join(cwd, ".claude"),
    path.join(cwd, ".agents")
  ]) {
    findSkillRoots(base, 0, roots);
  }
  return uniquePaths(roots);
}

function findSkillRoots(directory, depth, roots) {
  if (depth > 5) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    roots.push(path.dirname(directory));
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === ".git" || entry.name === ".tmp" || entry.name === "node_modules") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() && !safeStat(fullPath)?.isDirectory()) continue;
    findSkillRoots(fullPath, depth + 1, roots);
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const item of paths) {
    const normalized = path.resolve(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function countSkillFiles(root) {
  return findSkillFiles(root).length;
}

function findSkillFiles(root) {
  const files = [];
  walk(root, 0, files);
  return files;
}

function walk(directory, depth, files) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const stat = safeStat(fullPath);
      if (stat?.isDirectory()) walk(fullPath, depth + 1, files);
    } else if (entry.isDirectory()) {
      walk(fullPath, depth + 1, files);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      // Follow symlinks and copy real content to avoid incompatibility
      // with tools like antigravity-awesome-skills that reject symlinks.
      const real = fs.realpathSync(source);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        copyDirectory(real, target);
      } else if (stat.isFile()) {
        fs.copyFileSync(real, target);
      }
    } else if (entry.isDirectory()) {
      copyDirectory(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

export function collectAntigravityLegacySkills({
  cwd = process.cwd(),
  home = os.homedir(),
  sourceDir = skillshareSourceDir({ home }),
  dryRun = false
} = {}) {
  const sourceReal = safeRealpath(sourceDir);
  const copied = [];
  const skipped = [];
  for (const root of antigravityLegacyRoots({ cwd, home })) {
    const rootReal = safeRealpath(root);
    if (!rootReal || rootReal === sourceReal) continue;
    for (const skillFile of findSkillFiles(root)) {
      const skillDir = path.dirname(skillFile);
      const name = path.basename(skillDir);
      const targetDir = path.join(sourceDir, name);
      if (fs.existsSync(targetDir)) {
        skipped.push(name);
        continue;
      }
      if (!dryRun) copyDirectory(skillDir, targetDir);
      copied.push(name);
    }
  }
  return { copied: [...new Set(copied)], skipped: [...new Set(skipped)], sourceDir };
}

export function isSkillshareInitialized({ home = os.homedir() } = {}) {
  return fs.existsSync(skillshareConfigDir({ home }));
}

export async function syncSkills({
  cwd = process.cwd(),
  home = os.homedir(),
  args = [],
  run = runCommand,
  runShellCommand = runShell,
  logger = console.log,
  rebuildSkillEmbeddings = async () => ({ count: 0, cachePath: null })
} = {}) {
  const options = parseSyncSkillsArgs(args);
  if (!options.skills) {
    throw new UsageError("`backendguard sync --skills` was called without --skills.", {
      hint: "See `backendguard sync --help` for the available targets."
    });
  }

  const installed = checkSkillshareInstalled({ run });
  logger(statusLine("Checking skillshare installation...", installed.installed ? `${installed.version}` : "not found"));
  if (!installed.installed) {
    logger("");
    logger("skillshare is required to sync skills across agents.");
    const postInstall = await installSkillshare({
      run,
      runShellCommand,
      yes: options.yes,
      dryRun: options.dryRun,
      platform: process.platform
    });
    logger(statusLine("Installing skillshare...", options.dryRun ? "dry-run" : `${postInstall.version}`));
  }

  const initialized = isSkillshareInitialized({ home });
  logger(statusLine("Checking skillshare config...", initialized ? "initialized" : "not initialized"));

  if (!initialized) {
    const existing = detectExistingSkills({ cwd, home });
    if (existing.length) {
      logger("[backendguard] Found existing skills:");
      for (const entry of existing) {
        logger(`      ${entry.path.padEnd(44)} ${entry.count} skills`);
      }
    } else {
      logger("[backendguard] No existing skills found.");
    }

    // --no-copy --no-git --no-skill --all-targets: fully non-interactive init.
    // skillshare init is interactive by default; with stdin routed to NUL
    // (deadlock prevention) the Go binary hangs waiting for terminal input.
    run("skillshare", ["init", "--no-copy", "--no-git", "--no-skill", "--all-targets"], { cwd, stdio: "pipe", dryRun: options.dryRun });
    logger(statusLine("Initializing skillshare...", options.dryRun ? "dry-run" : "initialized"));

    if (existing.length && !options.noCollect) {
      run("skillshare", ["backup"], { cwd, stdio: "pipe", dryRun: options.dryRun });
      logger(statusLine("Backing up...", options.dryRun ? "dry-run" : "backup created"));
      run("skillshare", ["collect", "--all"], { cwd, stdio: "pipe", dryRun: options.dryRun });
      const collected = countSkillFiles(skillshareSourceDir({ home }));
      logger(statusLine("Collecting from all agents...", options.dryRun ? "dry-run" : `${collected} skills collected`));
    }
  }

  if (!options.noCollect) {
    const repaired = repairSkillSymlinks({ cwd, home, dryRun: options.dryRun });
    if (repaired.repaired.length || repaired.removedBroken.length) {
      logger(statusLine("Repairing skill symlinks...", options.dryRun
        ? `dry-run (${repaired.repaired.length} would copy, ${repaired.removedBroken.length} broken)`
        : `${repaired.repaired.length} copied, ${repaired.removedBroken.length} broken removed`));
    }

    const legacy = collectAntigravityLegacySkills({ cwd, home, dryRun: options.dryRun });
    if (legacy.copied.length || legacy.skipped.length) {
      const value = options.dryRun
        ? `dry-run (${legacy.copied.length} would copy, ${legacy.skipped.length} already present)`
        : `${legacy.copied.length} copied, ${legacy.skipped.length} already present`;
      logger(statusLine("Collecting Antigravity legacy skills...", value));
    }
  }

  const syncArgs = ["sync"];
  if (options.dryRun) syncArgs.push("--dry-run");
  if (!options.verbose) syncArgs.push("--quiet");
  if (options.agents.length) syncArgs.push("--agents", options.agents.join(","));
  logger(statusLine("Running skillshare sync...", "started"));
  run("skillshare", syncArgs, { cwd, stdio: options.verbose ? "inherit" : "pipe", dryRun: false });
  const syncedCount = countSkillFiles(skillshareSourceDir({ home }));
  logger(statusLine("Running skillshare sync...", options.dryRun ? "dry-run" : `${syncedCount} skills → ${options.agents.join(", ")}`));

  const deduped = dedupeAgentVisibleSkills({
    cwd,
    home,
    agents: options.agents,
    dryRun: options.dryRun
  });
  if (deduped.removed.length) {
    logger(statusLine("Deduping agent-visible skills...", options.dryRun
      ? `dry-run (${deduped.removed.length} duplicates)`
      : `${deduped.removed.length} duplicates removed`));
  }

  let embeddings = { count: 0, cachePath: null, skipped: options.dryRun || options.noEmbeddings };
  if (options.noEmbeddings) {
    logger(statusLine("Rebuilding skill embeddings...", "skipped by --no-embeddings"));
  } else if (!options.dryRun) {
    logger(statusLine("Rebuilding skill embeddings...", `started (${syncedCount} skills)`));
    embeddings = await rebuildSkillEmbeddings({ cwd, home, sourceDir: skillshareSourceDir({ home }) });
    logger(statusLine("Rebuilding skill embeddings...", `${embeddings.count || 0} skills indexed`));
  } else {
    logger(statusLine("Rebuilding skill embeddings...", "skipped in dry-run"));
  }

  logger("");
  logger("Done. Skills are now synced.");
  logger(`Source: ${skillshareSourceDir({ home })}`);
  return { options, initialized, sourceDir: skillshareSourceDir({ home }), syncedCount, embeddings };
}
