#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

import { readAgentsChain } from "../plugins/ctx/lib/reader.js";
import { filterActionableRules, parseRules, scoreRules } from "../plugins/ctx/lib/analyzer.js";
import { scheduleContext } from "../plugins/ctx/lib/scheduler.js";
import { buildReport, formatEvidence, formatReport } from "../plugins/ctx/lib/reporter.js";
import { checkCompliance, readGitSnapshot } from "../plugins/ctx/lib/measure.js";
import { structuralComplianceForChangedFiles } from "../plugins/ctx/lib/ast-security-analyzer.js";
import { installGlobalHooks } from "../plugins/ctx/lib/global-hooks.js";
import { formatStats, loadStats } from "../plugins/ctx/lib/stats.js";
import { isModelCacheReady, modelCacheDir, warmRuleEmbeddings } from "../plugins/ctx/lib/embedding-scorer.js";
import { warmFileEmbeddings } from "../plugins/ctx/lib/file-embedding-retriever.js";
import { scoreContext } from "../plugins/ctx/lib/score-context.js";
import { defaultDataRoot, workspaceDataDir, workspaceMarkerPath } from "../plugins/ctx/lib/workspace-data.js";
import { installMcpTelemetryProxies } from "../plugins/ctx/lib/mcp-proxy-install.js";
import { benchmarkWorkspace, formatBenchmark } from "../plugins/ctx/lib/benchmark.js";
import { formatSkillRoutingBenchmark, runSkillRoutingEval } from "../eval/skill-routing/run-eval.js";
import { formatHallucinationLeaderboard, runHallucinationLeaderboard } from "../eval/hallucination/run-leaderboard.js";
import { formatAgentLeaderboard, runAgentLeaderboard } from "../eval/hallucination/run-agent-leaderboard.js";
import { copyDir, copyPackageRoot, syncPackageRoot } from "../plugins/ctx/lib/package-install.js";
import { installClaudeHooks } from "../plugins/ctx/integrations/claude/claude-hooks.js";
import { installClaudeMcp } from "../plugins/ctx/integrations/claude/claude-mcp.js";
import { installAntigravityHooks } from "../plugins/ctx/integrations/antigravity/antigravity-hooks.js";
import { installAntigravityMcp } from "../plugins/ctx/integrations/antigravity/antigravity-mcp.js";
import { installCopilotHooks } from "../plugins/ctx/integrations/copilot/copilot-hooks.js";
import { installCopilotMcp } from "../plugins/ctx/integrations/copilot/copilot-mcp.js";
import { readCodexMcpServers, syncRules } from "../plugins/ctx/lib/ruler-sync.js";
import { detectGraphStrategy, embedCodeReviewGraph, formatCodeReviewGraphEmbedding, formatGraphStrategy } from "../plugins/ctx/lib/graph-strategy.js";
import { writeInnerGitignore, ensureRootGitignore } from "../plugins/ctx/lib/gitignore.js";
import { dedupeAgentVisibleSkills, repairSkillSymlinks, syncSkills, detectExistingSkills } from "../plugins/ctx/lib/skillshare-sync.js";
import { diagnoseSkills, scanSkills, warmSkillEmbeddings } from "../plugins/ctx/lib/skill-discoverer.js";
import { parsePassthroughArgs, runPassthrough } from "../plugins/ctx/lib/passthrough.js";
import { parseAgentList, parseSetupArgs, setupSummaryLines } from "../plugins/ctx/lib/setup-wizard.js";
import { multiSelect } from "../plugins/ctx/lib/multi-select.js";
import { configureOutputSections, enabledOutputSectionsLabel, loadOutputConfig, outputConfigLimits, outputConfigLimitsLabel } from "../plugins/ctx/lib/output-config.js";
import { syncWorkflows, warmWorkflowEmbeddings } from "../plugins/ctx/lib/workflow-discoverer.js";
import { checkForUpdate } from "../plugins/ctx/lib/update-notifier.js";
import { fetchSkillsForAgents, printSkillRecommendations, getAllLibraries, getInstallCommands } from "../plugins/ctx/lib/skill-library.js";
import { callCtxHealth, ctxMcpSocketPath, invalidateCtxMcpSocket } from "../plugins/ctx/lib/ctx-mcp-client.js";
import { runPrefixedCommand } from "../plugins/ctx/lib/shell-runner.js";
import { formatBackendGuardReady, inspectBackendGuardReady } from "../plugins/ctx/lib/certification.js";
import { detectStack, formatProjectContextGeneration, formatStackReport, generateProjectContext } from "../plugins/ctx/lib/project-context-generator.js";
import { retrievalMode } from "../plugins/ctx/lib/prompt-hook.js";

/**
 * Run a shell command with all output lines prefixed by │  
 * Keeps the visual box style consistent during child-process output.
 * stdin is inherited so interactive prompts (e.g. npx "Ok to proceed?") still work.
 */
function runPrefixed(cmd) {
  return runPrefixedCommand(cmd);
}

/**
 * Interactive community skill library installer.
 * Fetches library metadata, shows a multiSelect, and runs install commands.
 * @param {string[]} agents - Agent names to filter libraries for.
 * @returns {Promise<number>} Number of successfully installed sources.
 */
async function runCommunitySkillInstaller(agents = []) {
  const RESET = "\x1B[0m";
  const DIM = "\x1B[2m";
  const CYAN = "\x1B[36m";
  const GREEN = "\x1B[32m";
  const YELLOW = "\x1B[33m";
  const BOLD = "\x1B[1m";

  console.log("Fetching community skill libraries...\n");
  const libraryResults = await fetchSkillsForAgents(agents, { dataDir: contextOSDataDir() });

  const totalSkills = libraryResults.reduce((sum, r) => sum + r.count, 0);
  if (totalSkills === 0) {
    console.log("No skills found. Check your network connection or try --refresh.");
    return 0;
  }

  // Compact header
  console.log(`${CYAN}◇${RESET} ${BOLD}Community skill libraries available:${RESET}`);
  console.log(`${DIM}│${RESET}  Browse and install curated skills from the community.`);
  console.log(`${DIM}│${RESET}`);

  const allLibs = getAllLibraries();
  const availableLibs = allLibs.filter((lib) => {
    const result = libraryResults.find((r) => r.library.id === lib.id);
    return result && result.count > 0;
  });

  if (availableLibs.length === 0) {
    console.log("No installable libraries available.");
    return 0;
  }

  const selectedSources = await multiSelect({
    message: "Select skill sources to install:",
    options: availableLibs.map((lib) => {
      const result = libraryResults.find((r) => r.library.id === lib.id);
      return {
        label: `${lib.name} (${result?.count || 0} skills)`,
        value: lib.id,
        hint: lib.url,
        selected: false
      };
    })
  });

  if (!selectedSources || selectedSources.length === 0) {
    console.log(`\n${DIM}No sources selected.${RESET}`);
    return 0;
  }

  // Install each selected source
  let successCount = 0;
  for (const libId of selectedSources) {
    const lib = allLibs.find((l) => l.id === libId);
    if (!lib) continue;

    const installInfo = getInstallCommands(libId);
    if (!installInfo) {
      console.log(`No install info for ${lib.name}. Visit: ${lib.url}`);
      continue;
    }

    console.log("");
    console.log(`${CYAN}◇${RESET} ${BOLD}Installing from ${lib.name}${RESET}`);

    if (installInfo.type === "manual") {
      console.log(`${DIM}│${RESET}  ${installInfo.instructions}`);
      console.log(`${DIM}│${RESET}  ${DIM}URL: ${lib.url}${RESET}`);
      continue;
    }

    const installCmd = installInfo.fullInstall;
    if (installCmd) {
      console.log(`${DIM}│${RESET}  ${GREEN}$ ${installCmd}${RESET}`);
      console.log(`${DIM}│${RESET}`);

      try {
        const beforeRepair = repairSkillSymlinks({ cwd: process.cwd(), home: os.homedir() });
        if (beforeRepair.repaired.length || beforeRepair.removedBroken.length) {
          console.log(`${DIM}│${RESET}  Repaired ${beforeRepair.repaired.length} skill links before install.`);
        }
        await runPrefixed(installCmd);
        const afterRepair = repairSkillSymlinks({ cwd: process.cwd(), home: os.homedir() });
        if (afterRepair.repaired.length || afterRepair.removedBroken.length) {
          console.log(`${DIM}│${RESET}  Repaired ${afterRepair.repaired.length} skill links after install.`);
        }
        const deduped = dedupeAgentVisibleSkills({ cwd: process.cwd(), home: os.homedir(), agents });
        if (deduped.removed.length) {
          console.log(`${DIM}│${RESET}  Removed ${deduped.removed.length} duplicate agent-visible skills.`);
        }
        successCount++;

        if (installInfo.verify) {
          try { await runPrefixed(installInfo.verify); } catch { /* best-effort */ }
        }
        console.log(`${DIM}│${RESET}`);
        console.log(`${lib.name} installed successfully.`);
      } catch (err) {
        console.error(`Install failed for ${lib.name}.`);
        console.error(`${DIM}│${RESET}  ${DIM}${err.message}${RESET}`);
        console.error(`${DIM}│${RESET}  BackendGuard will continue setup; rerun \`backendguard skills\` after fixing the environment.`);
      }
    }
  }

  // Summary
  console.log("");
  if (successCount > 0) {
    console.log(`${BOLD}${successCount} source${successCount > 1 ? "s" : ""} installed.${RESET}`);
    console.log(`${DIM}│${RESET}  Restart your agent to pick up new skills.`);
  }
  return successCount;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pluginSourceDir = path.join(rootDir, "plugins", "ctx");

function usage() {
  return `BackendGuard — AI backend engineering guardrails (NestJS · PostgreSQL · TypeORM · Prisma)

Usage:
  backendguard install                                Interactive multi-select agent installer
  backendguard install --agent <name>                 Install a specific agent (codex|claude|antigravity|copilot)
  backendguard install --copy                         Legacy: copy plugin folder only (no hooks/mcp)
  backendguard setup                                  Interactive full setup wizard
  backendguard setup --yes                            Auto-confirm all setup prompts
  backendguard setup --agents <names>                 Pre-select agents to install
  backendguard setup --generate-project-context       Generate starter project skills/workflow
  backendguard setup --no-rules                       Skip AGENTS.md rule sync
  backendguard setup --no-skills                      Skip skill sync
  backendguard setup --quiet                          Quiet mode (minimal output)
  backendguard stack                                  Detect and print the backend stack (framework/db/orm/cache)
  backendguard context -- "task"                      Retrieve task-aware backend engineering context (alias: debug)
  backendguard health                                 Show backend-mcp bridge/model/index health
  backendguard doctor                                 Score repository production-readiness
  backendguard doctor --fix                           Generate starter project skills/workflow
  backendguard doctor --fix --force                   Regenerate starter project context files
  backendguard check                                  Analyze uncommitted changes for compliance risk
  backendguard report                                 Show last compliance report
  backendguard evidence                               Show evidence from last report
  backendguard stats                                  Show workspace statistics
  backendguard benchmark -- "task"                    Benchmark workspace for a task
  backendguard benchmark --skills                     Run skill routing eval benchmark
  backendguard leaderboard --hallucination             Run offline deterministic hallucination benchmark
  backendguard leaderboard --hallucination --live --agent codex
                                                    Run hallucination benchmark through one live CLI
  backendguard leaderboard --agents codex,gemini      Run live CLI leaderboard for installed agents
  backendguard sync --rules                           Sync AGENTS.md rules to all agents
  backendguard sync --rules --agents <names>          Sync rules to specific agents only
  backendguard sync --rules --dry-run                 Preview rule sync without writing
  backendguard sync --rules --no-import-codex-mcp     Skip importing Codex MCP servers
  backendguard sync --skills                          Sync skills across agents
  backendguard sync --skills --agents <names>         Sync skills to specific agents only
  backendguard sync --skills --dry-run                Preview skill sync without writing
  backendguard sync --skills --no-collect             Skip collecting new skills
  backendguard sync --skills --no-embeddings          Skip embedding generation
  backendguard sync --skills --verbose                Verbose skill sync output
  backendguard sync --workflows                       Sync workflows across agents
  backendguard sync --workflows --agents <names>      Sync workflows to specific agents
  backendguard sync --workflows --dry-run             Preview workflow sync without writing
  backendguard rules                                  Browse the backend engineering rule library (alias: skills)
  backendguard rules doctor -- "task"                 Explain rule routing for a task
  backendguard rules --agents <names>                 Filter rules for specific agents
  backendguard rules --refresh                        Force refresh rule library cache
  backendguard --config                               Choose prompt context sections to show
  backendguard refresh                                Sync active Codex marketplace and rebuild indexes
  backendguard embeddings warm -- "task"               Pre-warm embedding caches for a task
  backendguard ruler -- <ruler args>                  Passthrough to ruler CLI
  backendguard skillshare -- <skillshare args>        Passthrough to skillshare CLI
  backendguard --help                                 Show this help message
  backendguard --version                              Show installed version
`;
}

const SUPPORTED_AGENTS = [
  { label: "Codex",              value: "codex",   selected: false },
  { label: "Claude Code",       value: "claude",  selected: false },
  { label: "Antigravity",         value: "agy",     selected: false },
  { label: "GitHub Copilot",     value: "copilot", selected: false }
];

function normalizeInstallAgent(agent) {
  const normalized = String(agent || "").trim().toLowerCase();
  if (/[|/]/.test(normalized)) {
    throw new Error([
      `Invalid agent '${agent}'.`,
      "Install one agent per command:",
      "  backendguard install --agent codex",
      "  backendguard install --agent claude",
      "  backendguard install --agent antigravity",
      "  backendguard install --agent copilot",
      "",
      "Do not run `backendguard install --agent codex|claude|antigravity|copilot`: `|` is a shell pipe."
    ].join("\n"));
  }
  if (normalized === "antigravity") return "agy";
  return normalized;
}

function leaderboardAgentsFromArgs(args) {
  const agentIndex = args.indexOf("--agent");
  const agentsIndex = args.indexOf("--agents");
  const index = agentIndex >= 0 ? agentIndex : agentsIndex;
  if (index < 0) return [];
  return String(args[index + 1] || "")
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);
}

/**
 * Intercept console.log from an async fn,
 * printing each line immediately with "│  " prefix for real-time feedback.
 * stderr is left untouched so \r-based spinner writes render in-place.
 * Returns the collected lines array (for callers that inspect it).
 */
async function streamSetupOutput(fn) {
  const lines = [];
  const origLog = console.log;
  const emit = (text) => {
    lines.push(text);
    origLog(`│  ${text}`);
  };
  console.log = (...args) => emit(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

function createInstallProgress({ quiet = false } = {}) {
  const isTTY = !quiet && process.stderr.isTTY;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let percent = 0;
  let label = "starting";
  let frame = 0;
  let timer = null;
  // Use the raw stderr binding so streamSetupOutput cannot intercept spinner writes.
  const rawStderrWrite = process.stderr.write.bind(process.stderr);

  function render() {
    if (!isTTY) return;
    const bar = progressBar(percent);
    const text = `  ${frames[frame % frames.length]} ${bar} ${label}`;
    rawStderrWrite(`\r${text.padEnd(72)}`);
    frame += 1;
  }

  return {
    start(initialLabel = "starting") {
      label = initialLabel;
      percent = 0;
      if (isTTY) {
        render();
        timer = setInterval(render, 80);
      } else if (!quiet) {
        console.log(`[ctx] ${label}...`);
      }
    },
    step(nextPercent, nextLabel) {
      percent = Math.max(percent, Math.min(100, nextPercent));
      label = nextLabel;
      if (isTTY) render();
    },
    done(finalLabel = "done") {
      percent = 100;
      label = finalLabel;
      if (timer) clearInterval(timer);
      timer = null;
      if (isTTY) {
        const bar = progressBar(100);
        rawStderrWrite(`\r  ${bar} ${label}`.padEnd(72) + "\n");
      } else if (!quiet) {
        console.log(`[ctx] ${label}`);
      }
    },
    fail(errorLabel = "failed") {
      label = errorLabel;
      if (timer) clearInterval(timer);
      timer = null;
      if (isTTY) {
        rawStderrWrite(`\r  ${errorLabel}`.padEnd(72) + "\n");
      }
    }
  };
}

function progressBar(percent) {
  const width = 20;
  const filled = Math.round(width * percent / 100);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${String(percent).padStart(3)}%`;
}

function packageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function copyInstall() {
  const target = path.join(codexHome(), "plugins", "ctx");
  fs.rmSync(target, { recursive: true, force: true });
  copyDir(pluginSourceDir, target);
  console.log(`Installed BackendGuard plugin to ${target}`);
  console.log("Restart Codex if it was already running, then submit a task to trigger BackendGuard.");
}

function agentInstallRoot(agent) {
  return path.join(contextOSDataDir(), "agents", agent, "backendguard");
}

async function install({ copy = false, agent = "codex" } = {}) {
  const inject = true; // Prompt injection is always enabled
  agent = normalizeInstallAgent(agent);
  if (copy) {
    copyInstall();
    return;
  }
  const progress = createInstallProgress({ quiet: false });
  progress.start(`installing ${agent || "codex"}`);
  const graphStrategy = graphStrategyForInstall();

  try {
    progress.step(5, "syncing active marketplace");
    syncActiveCodexMarketplace();

    if (agent === "claude") {
      progress.step(10, "copying package");
      const installRoot = copyPackageRoot({ rootDir, targetRoot: agentInstallRoot("claude") });
      progress.step(30, "installing hooks");
      const hooksPath = installClaudeHooks({ installRoot, injectPromptContext: inject });
      progress.step(50, "installing mcp");
      const mcpConfigPath = installClaudeMcp({ installRoot });
      progress.step(60, "configuring gitignore");
      writeInnerGitignore(installRoot);
      ensureRootGitignore(process.cwd());
      progress.step(70, "warming embeddings");
      const warmResult = await warmInstallEmbeddings();
      progress.done("claude");
      console.log(`Hooks → ${hooksPath}`);
      console.log(`MCP   → ${mcpConfigPath}`);
      console.log(`Graph → ${graphStrategy}`);
      console.log(`Embeddings: ${warmResult.fileCount || 0} files, ${warmResult.skillCount || 0} skills`);
      console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
      console.log("Restart Claude Code to activate BackendGuard.");
      return;
    }

    if (agent === "agy") {
      progress.step(10, "copying package");
      const installRoot = copyPackageRoot({ rootDir, targetRoot: agentInstallRoot("agy") });
      progress.step(30, "installing hooks");
      const hooksPath = installAntigravityHooks({ installRoot, injectPromptContext: inject });
      progress.step(50, "installing mcp");
      const mcpConfigPaths = installAntigravityMcp({ installRoot });
      progress.step(60, "configuring gitignore");
      writeInnerGitignore(installRoot);
      ensureRootGitignore(process.cwd());
      progress.step(70, "warming embeddings");
      const warmResult = await warmInstallEmbeddings();
      progress.done("antigravity");
      console.log(`Hooks → ${hooksPath}`);
      console.log(`MCP   → ${mcpConfigPaths.join(", ")}`);
      console.log(`Graph → ${graphStrategy}`);
      console.log(`Embeddings: ${warmResult.fileCount || 0} files, ${warmResult.skillCount || 0} skills`);
      console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
      console.log("Restart Antigravity to activate BackendGuard.");
      return;
    }

    if (agent === "copilot") {
      progress.step(10, "copying package");
      const installRoot = copyPackageRoot({ rootDir, targetRoot: agentInstallRoot("copilot") });
      progress.step(30, "installing hooks");
      const hooksPath = installCopilotHooks({ cwd: process.cwd(), installRoot });
      progress.step(50, "installing mcp");
      const mcpConfigPath = installCopilotMcp({ cwd: process.cwd(), installRoot });
      progress.step(60, "configuring gitignore");
      writeInnerGitignore(installRoot);
      ensureRootGitignore(process.cwd());
      progress.step(70, "warming embeddings");
      const warmResult = await warmInstallEmbeddings();
      progress.done("copilot");
      console.log(`Instructions → ${hooksPath}`);
      console.log(`MCP          → ${mcpConfigPath}`);
      console.log(`Graph        → ${graphStrategy}`);
      console.log(`Embeddings: ${warmResult.fileCount || 0} files, ${warmResult.skillCount || 0} skills`);
      console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
      console.log("Restart VS Code to activate BackendGuard.");
      return;
    }

    if (agent !== "codex") {
      throw new Error(`Unknown agent '${agent}'. Expected codex, claude, agy, or copilot.`);
    }

    progress.step(10, "copying marketplace");
    const marketplaceRoot = activeCodexMarketplaceRoot();

    progress.step(25, "refreshing codex plugin");
    tryRunCodex(["plugin", "remove", "ctx@backendguard"]);
    tryRunCodex(["plugin", "marketplace", "remove", "backendguard"]);
    tryRunCodex(["mcp", "remove", "ctx-mcp"]);
    runCodex(["plugin", "marketplace", "add", marketplaceRoot]);
    runCodex(["plugin", "add", "ctx@backendguard"]);
    progress.step(45, "installing mcp");
    runCodex(["mcp", "add", "ctx-mcp", "--", "node", path.join(marketplaceRoot, "plugins", "ctx", "mcp", "server.js")]);
    progress.step(55, "installing telemetry proxies");
    const proxyResult = installMcpTelemetryProxies({ codexHome: codexHome(), marketplaceRoot });
    progress.step(65, "installing hooks");
    const hooksPath = installGlobalHooks({ codexHome: codexHome(), marketplaceRoot, injectPromptContext: inject });

    progress.step(70, "configuring gitignore");
    writeInnerGitignore(marketplaceRoot);
    ensureRootGitignore(process.cwd());

    progress.step(80, "warming embeddings");
    const warmResult = await warmInstallEmbeddings();
    progress.done("codex");
    console.log(`Hooks   → ${hooksPath}`);
    console.log(`MCP     → ctx-mcp installed`);
    console.log(`Proxies → ${proxyResult.wrapped.length ? proxyResult.wrapped.map((item) => item.name).join(", ") : "none changed"}`);
    console.log(`Graph   → ${graphStrategy}`);
    console.log(`Embeddings: ${warmResult.fileCount || 0} files, ${warmResult.skillCount || 0} skills`);
    console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
    console.log("Restart Codex to activate BackendGuard.");
  } catch (error) {
    progress.fail("install failed");
    throw error;
  }
}

function graphStrategyForInstall() {
  let mcpServerNames = [];
  try {
    mcpServerNames = readCodexMcpServers().map((server) => server.name);
  } catch {
    // Graph detection is diagnostic and must not block installation.
  }
  return formatGraphStrategy(detectGraphStrategy({
    cwd: process.cwd(),
    mcpServerNames
  }));
}

async function warmInstallEmbeddings() {
  const dataDir = contextOSDataDir();
  const modelReady = isModelCacheReady(dataDir);
  const allowRemote = shouldAllowRemoteWarm(modelReady);
  const result = await warmRuleEmbeddings({
    rules: [
      { content: "Always use project rules that are semantically relevant to the user prompt." },
      { content: "Find code files by meaning, imports, graph relationships, and task intent." },
      { content: "Use local embeddings to bridge natural language and code vocabulary mismatch." }
    ],
    task: "kiểm duyệt upload moderation semantic code search",
    dataDir,
    sources: [],
    allowRemote
  });
  const fileResult = await warmFileEmbeddings({
    cwd: process.cwd(),
    dataDir,
    allowRemote
  });
  const skillResult = await warmSkillEmbeddings({
    cwd: process.cwd(),
    dataDir,
    allowRemote
  });
  const warmDiscovery = process.env.BACKENDGUARD_INSTALL_WARM_DISCOVERY === "1";
  const workflowResult = warmDiscovery
    ? await warmWorkflowEmbeddings({
      cwd: process.cwd(),
      dataDir,
      allowRemote
    })
    : { count: 0 };
  const graphEmbedding = allowRemote
    ? embedCodeReviewGraph({ cwd: process.cwd() })
    : { status: "skipped", reason: "remote-embedding-disabled" };
  return { ...result, modelAlreadyCached: modelReady, fileCount: fileResult.count, skillCount: skillResult.count, workflowCount: workflowResult.count, graphEmbedding };
}

function activeCodexMarketplaceRoot() {
  return path.join(codexHome(), "marketplaces", "backendguard");
}

function syncActiveCodexMarketplace() {
  const result = syncPackageRoot({
    rootDir,
    targetRoot: activeCodexMarketplaceRoot()
  });
  writeInnerGitignore(result.targetRoot);
  return result;
}

function tryRunCodex(args) {
  try {
    execFileSync("codex", args, { stdio: "ignore", shell: true });
  } catch {
    // Best effort cleanup for repeat installs.
  }
}

function runCodex(args) {
  try {
    execFileSync("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      shell: true
    });
    // Suppress stdout (e.g. "Added marketplace…", "Added global MCP server…")
    // — the progress spinner already provides feedback.
  } catch (error) {
    const status = typeof error.status === "number" ? error.status : 1;
    throw new Error(`codex ${args.join(" ")} failed with exit code ${status}. Make sure Codex CLI is installed and authenticated.`);
  }
}

function loadLastReport() {
  const workspaceDir = contextOSWorkspaceDataDir();
  const candidates = [
    path.join(workspaceDir, "last-report.json"),
    path.join(codexHome(), "backendguard", "last-report.json"),
    path.join(codexHome(), "marketplaces", "backendguard", "plugins", "ctx", ".data", "last-report.json"),
    path.join(codexHome(), "plugins", "ctx", ".data", "last-report.json"),
    path.join(process.cwd(), ".backendguard", "last-report.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
  }
  throw new Error("No BackendGuard report found. Run a Codex task with the BackendGuard plugin enabled first.");
}

function contextOSDataDir() {
  return defaultDataRoot();
}

function contextOSWorkspaceDataDir(cwd = process.cwd()) {
  return workspaceDataDir({ cwd, dataRoot: contextOSDataDir() });
}

async function debug(task) {
  const cwd = process.cwd();
  const limits = outputConfigLimits(loadOutputConfig({ dataRoot: contextOSDataDir() }));
  const scored = await scoreContext({
    cwd,
    prompt: task,
    dataDir: contextOSDataDir(),
    maxFiles: limits.files,
    maxSkills: limits.skills,
    maxWorkflows: limits.workflows,
    embeddingTimeoutMs: Number(process.env.BACKENDGUARD_EMBEDDING_DEBUG_TIMEOUT_MS || 5000)
  });
  const rules = scored.scoredRules;
  const outputConfig = loadOutputConfig({ dataRoot: contextOSDataDir() });
  const scheduled = scheduleContext({
    rules,
    relevantFiles: scored.suggestedFiles || [],
    suggestedSkills: scored.suggestedSkills || [],
    suggestedWorkflows: scored.suggestedWorkflows || [],
    prompt: task,
    outputConfig
  });
  const relevantFiles = scheduled.relevantFiles || [];
  const suggestedSkills = scheduled.suggestedSkills || [];
  const suggestedWorkflows = scheduled.suggestedWorkflows || [];

  console.log("BackendGuard debug");
  console.log(`cwd: ${cwd}`);
  console.log(`workspace data: ${contextOSWorkspaceDataDir(cwd)}`);
  console.log(`workspace marker: ${workspaceMarkerPath(cwd)}`);
  console.log(`rules: ${rules.length}`);
  console.log(`mcp scorer: ${scored.telemetry.modelStatus}${scored.telemetry.model ? ` (${scored.telemetry.model})` : ""}`);
  printRetrievalMode(retrievalMode(scored.telemetry || {}));
  printRuleRetrievalDebug({ telemetry: scored.telemetry || {}, scheduled, outputConfig });
  console.log(`elapsed: ${scored.telemetry.elapsedMs}ms`);
  console.log("");
  for (const rule of rules.slice(0, 20)) {
    console.log(`${rule.score.toFixed(2)}  ${rule.content}`);
    if (rule.reasons.length) console.log(`      reasons: ${rule.reasons.join(", ")}`);
  }
  if (rules.length > 20) console.log(`... ${rules.length - 20} more rules`);
  console.log("");
  console.log("Suggested files:");
  for (const file of relevantFiles) {
    const source = file.source ? ` source:${file.source}` : "";
    const reasons = file.reasons?.length ? ` reasons:${file.reasons.join(", ")}` : "";
    console.log(`${Number(file.score || 0).toFixed(2)}  ${file.path}${source}${reasons}`);
  }
  if (!relevantFiles.length) console.log("(none)");
  console.log("");
  console.log("Suggested skills:");
  for (const skill of suggestedSkills) {
    const score = Number(skill.score || 0).toFixed(2);
    const location = skill.path ? ` path:${skill.path}` : "";
    console.log(`${score}  ${skill.name}${location}`);
  }
  if (!suggestedSkills.length) console.log("(none)");
  console.log("");
  console.log("Suggested workflows:");
  for (const workflow of suggestedWorkflows) {
    const score = Number(workflow.score || 0).toFixed(2);
    const chain = workflow.chain?.length ? ` chain:${workflow.chain.join(" -> ")}` : "";
    const location = workflow.relativePath || workflow.path ? ` path:${workflow.relativePath || workflow.path}` : "";
    console.log(`${score}  ${workflow.title || workflow.name}${chain}${location}`);
  }
  if (!suggestedWorkflows.length) console.log("(none)");
  console.log("");
  console.log("Final additionalContext:");
  console.log(scheduled.additionalContext || "(empty)");
}

// `backendguard check` analyzes uncommitted changes on demand (no agent Stop hook
// required): it scores AGENTS.md rules against a generic backend-review task,
// diffs the working tree, classifies rule compliance, and prints the same
// severity-ranked report `backendguard report` shows after an agent task.
async function checkCommand() {
  const cwd = process.cwd();
  const task = "review uncommitted backend changes for security, architecture, database, and testing compliance";
  const limits = outputConfigLimits(loadOutputConfig({ dataRoot: contextOSDataDir() }));
  const scored = await scoreContext({
    cwd,
    prompt: task,
    dataDir: contextOSDataDir(),
    maxFiles: limits.files,
    maxSkills: limits.skills,
    maxWorkflows: limits.workflows,
    embeddingTimeoutMs: Number(process.env.BACKENDGUARD_EMBEDDING_DEBUG_TIMEOUT_MS || 5000)
  });
  const outputConfig = loadOutputConfig({ dataRoot: contextOSDataDir() });
  const scheduled = scheduleContext({
    rules: scored.scoredRules,
    relevantFiles: scored.suggestedFiles || [],
    suggestedSkills: scored.suggestedSkills || [],
    suggestedWorkflows: scored.suggestedWorkflows || [],
    prompt: task,
    outputConfig
  });
  const scheduledRules = filterActionableRules([...(scheduled.highRules || []), ...(scheduled.midRules || [])]);
  const gitSnapshot = readGitSnapshot({ cwd });
  const compliance = [
    ...checkCompliance({ rules: scheduledRules, addedLines: gitSnapshot.addedLines, runtimeEvidence: {} }),
    ...structuralComplianceForChangedFiles({ cwd, changedFiles: gitSnapshot.changedFiles })
  ];
  const report = buildReport({
    cwd,
    prompt: task,
    relevantFiles: scheduled.relevantFiles || [],
    suggestedSkills: scheduled.suggestedSkills || [],
    suggestedWorkflows: scheduled.suggestedWorkflows || [],
    scheduled,
    gitSnapshot,
    compliance,
    runtimeEvidence: {}
  });

  const workspaceDir = contextOSWorkspaceDataDir(cwd);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "last-report.json"), JSON.stringify(report, null, 2));

  if (gitSnapshot.mode === "none") {
    console.log("No git repository detected; nothing to check.");
    return;
  }
  if (!gitSnapshot.changedFiles.length) {
    console.log("No uncommitted changes detected.");
    return;
  }
  console.log(formatReport(report));
}

function printRuleRetrievalDebug({ telemetry = {}, scheduled = {}, outputConfig = {} } = {}) {
  const parsed = Number(telemetry.rulesParsed || 0);
  const candidates = Array.isArray(scheduled.highRules) || Array.isArray(scheduled.midRules) || Array.isArray(scheduled.droppedRules)
    ? (scheduled.highRules?.length || 0) + (scheduled.midRules?.length || 0) + (scheduled.droppedRules?.length || 0)
    : Number(telemetry.rulesInjected || 0);
  const selected = (scheduled.highRules?.length || 0) + (scheduled.midRules?.length || 0);
  const disabledByConfig = outputConfig?.sections?.rules === false;
  let emptyReason = null;
  if (disabledByConfig) emptyReason = "rules_disabled";
  else if (!parsed) emptyReason = "no_rule_candidates";
  else if (!selected) emptyReason = "score_below_threshold";
  console.log("Rule retrieval:");
  console.log(`  enabled: ${!disabledByConfig}`);
  console.log(`  parsed rules: ${parsed}`);
  console.log(`  candidates: ${candidates}`);
  console.log(`  selected: ${selected}`);
  console.log(`  disabled_by_config: ${disabledByConfig}`);
  console.log(`  empty_reason: ${emptyReason || "none"}`);
}

async function health() {
  const dataDir = contextOSDataDir();
  const socketPath = ctxMcpSocketPath(dataDir);
  const socketPresent = fs.existsSync(socketPath);
  let bridgeConnected = false;
  let bridgeHealth = {};
  let bridgeError = null;
  try {
    bridgeHealth = await callCtxHealth({
      dataDir,
      timeoutMs: Number(process.env.BACKENDGUARD_MCP_HEALTH_TIMEOUT_MS || 500),
      connectTimeoutMs: Number(process.env.BACKENDGUARD_MCP_CONNECT_TIMEOUT_MS || 500)
    });
    bridgeConnected = true;
  } catch (error) {
    bridgeError = error?.message || String(error);
  }

  const indexesReady = fs.existsSync(path.join(dataDir, "embeddings.db"));
  const modelHot = Boolean(bridgeHealth.embedding_pipeline_loaded);
  console.log("BackendGuard health");
  console.log(`ctx-mcp: ${socketPresent ? "running" : "not running"}`);
  console.log(`bridge: ${bridgeConnected ? "connected" : "disconnected"}`);
  console.log(`embedding_pipeline_loaded: ${Boolean(bridgeHealth.embedding_pipeline_loaded)}`);
  console.log(`model_hot: ${modelHot}`);
  console.log(`indexes_ready: ${indexesReady}`);
  if (bridgeHealth.preload_status) console.log(`preload_status: ${bridgeHealth.preload_status}`);
  if (bridgeHealth.loaded_at) console.log(`loaded_at: ${new Date(bridgeHealth.loaded_at).toISOString()}`);
  if (bridgeHealth.error || bridgeError) console.log(`error: ${bridgeHealth.error || bridgeError}`);
}

function printRetrievalMode(mode = {}) {
  console.log("retrieval mode:");
  console.log(`- bridge: ${mode.bridge || "mcp"}${mode.bridgeError ? ` (${mode.bridgeError})` : ""}`);
  console.log(`- embedding: ${mode.embedding || "enabled"}`);
  console.log(`- file fallback: ${mode.fileFallback || "none"}`);
  console.log(`- skill fallback: ${mode.skillFallback || "none"}`);
}

async function skillsDoctor(task) {
  if (!String(task || "").trim()) throw new Error('Usage: backendguard skills doctor -- "task"');
  const result = await diagnoseSkills({
    cwd: process.cwd(),
    prompt: task,
    dataDir: contextOSDataDir(),
    skills: scanSkills({ cwd: process.cwd() }),
    limit: outputConfigLimits(loadOutputConfig({ dataRoot: contextOSDataDir() })).skills,
    timeoutMs: Number(process.env.BACKENDGUARD_SKILL_DOCTOR_TIMEOUT_MS || 3000)
  });

  console.log("BackendGuard skill doctor");
  console.log(`cwd: ${result.cwd}`);
  console.log(`prompt: ${result.prompt}`);
  console.log("");
  console.log("Project evidence:");
  console.log(`dependencies: ${result.projectEvidence.dependencies.slice(0, 30).join(", ") || "(none)"}`);
  console.log(`files: ${result.projectEvidence.files.slice(0, 30).join(", ") || "(none)"}`);
  console.log("");
  console.log("Skills:");
  if (!result.skills.length) {
    console.log("(none)");
    return;
  }
  for (const skill of result.skills) {
    console.log(`${Number(skill.confidence || skill.score || 0).toFixed(2)}  ${skill.confidenceBand || "low"}  ${skill.name}`);
    console.log(`      semantic:${Number(skill.semanticScore || 0).toFixed(2)} prompt:${Number(skill.promptTriggerScore || 0).toFixed(2)} project:${Number(skill.projectEvidenceScore || 0).toFixed(2)} files:${Number(skill.fileConfigScore || 0).toFixed(2)} import:${Number(skill.importGraphScore || 0).toFixed(2)} graph:${Number(skill.externalGraphScore || skill.graphScore || 0).toFixed(2)} memory:${Number(skill.memoryScore || 0).toFixed(2)} negative:${Number(skill.negativePenalty || 0).toFixed(2)}`);
    if (skill.evidence?.length) console.log(`      evidence: ${skill.evidence.join(", ")}`);
    if (skill.negativeEvidence?.length) console.log(`      rejected signals: ${skill.negativeEvidence.join(", ")}`);
  }
}

async function warmEmbeddings(task, { syncMarketplace = true, quiet = false } = {}) {
  const warmResult = await warmWorkspaceIndexes({ task });
  const marketplaceSync = syncMarketplace ? syncActiveCodexMarketplace() : null;
  if (quiet) return { ...warmResult, marketplaceSync };
  console.log(`Warmed ${warmResult.ruleCount} embeddings`);
  console.log(`Warmed ${warmResult.fileCount} file path embeddings`);
  console.log(`Warmed ${warmResult.skillCount} skill embeddings`);
  console.log(`Warmed ${warmResult.workflowCount} workflow embeddings`);
  console.log(`Cache: ${warmResult.cachePath}`);
  console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
  if (marketplaceSync) {
    console.log(`Marketplace: ${marketplaceSync.synced ? "synced" : "already active"} (${marketplaceSync.targetRoot})`);
  }
  return { ...warmResult, marketplaceSync };
}

async function warmWorkspaceIndexes({ task = "project context" } = {}) {
  const cwd = process.cwd();
  const dataDir = contextOSDataDir();
  const modelReady = isModelCacheReady(dataDir);
  const allowRemote = shouldAllowRemoteWarm(modelReady);
  const merged = readAgentsChain({ cwd });
  const rules = scoreRules(filterActionableRules(parseRules(merged.content)), task, []);
  const result = await warmRuleEmbeddings({
    rules,
    task,
    dataDir,
    sources: merged.sources,
    allowRemote
  });
  const fileResult = await warmFileEmbeddings({
    cwd,
    dataDir,
    allowRemote
  });
  const skillResult = await warmSkillEmbeddings({
    cwd,
    dataDir,
    allowRemote
  });
  const workflowResult = await warmWorkflowEmbeddings({
    cwd,
    dataDir,
    allowRemote
  });
  const graphEmbedding = allowRemote
    ? embedCodeReviewGraph({ cwd })
    : { status: "skipped", reason: "remote-embedding-disabled" };
  return {
    ruleCount: result.count,
    fileCount: fileResult.count,
    skillCount: skillResult.count,
    workflowCount: workflowResult.count,
    cachePath: result.cachePath,
    graphEmbedding
  };
}

function shouldAllowRemoteWarm(modelReady) {
  if (modelReady) return false;
  if (process.env.BACKENDGUARD_EMBEDDING_ALLOW_REMOTE !== undefined) {
    return process.env.BACKENDGUARD_EMBEDDING_ALLOW_REMOTE === "1";
  }
  return !isCiEnvironment();
}

function isCiEnvironment() {
  return process.env.CI === "true"
    || process.env.GITHUB_ACTIONS === "true"
    || process.env.CONTINUOUS_INTEGRATION === "true"
    || process.env.BUILD_ID !== undefined
    || process.env.RUN_ID !== undefined;
}

async function refresh() {
  const marketplaceSync = syncActiveCodexMarketplace();
  const invalidatedBridge = invalidateCtxMcpSocket(contextOSDataDir());
  const warmResult = await warmInstallEmbeddings();
  console.log(`Marketplace: ${marketplaceSync.synced ? "synced" : "already active"} (${marketplaceSync.targetRoot})`);
  console.log(`Indexes: ${warmResult.fileCount || 0} file paths rebuilt, ${warmResult.skillCount || 0} skills indexed`);
  console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
  if (invalidatedBridge) console.log("Bridge: stale private socket invalidated");
  console.log("Restart Codex if ctx-mcp was already running.");
}

function printSetupBanner() {
  console.log("");
  console.log("╭─ BackendGuard setup ─────────────────────────────────────────╮");
  console.log("│ Task-aware rules, MCP sync, and skill discovery for agents │");
  console.log("╰───────────────────────────────────────────────────────────╯");
  console.log("");
}

async function askSetupQuestion(rl, question, defaultValue) {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`◇ ${question}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function askSetupYesNo(rl, question, defaultValue = true) {
  const suffix = defaultValue ? "Y/n" : "y/N";
  const answer = await askSetupQuestion(rl, question, suffix);
  if (!answer || answer === suffix) return defaultValue;
  return !/^n(o)?$/i.test(answer.trim());
}

async function askOutputLimit({ option, currentValue }) {
  if (!process.stdin.isTTY) return currentValue;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`◇ ${option.label} limit (auto or 0-${option.cap || option.max}, current ${currentValue}): `);
    const trimmed = answer.trim();
    if (!trimmed) return currentValue;
    if (trimmed.toLowerCase() === "auto") return "auto";
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return currentValue;
    return Math.max(0, Math.min(option.cap || option.max, Math.trunc(value)));
  } finally {
    rl.close();
  }
}

async function setup({ args = [], cwd = process.cwd() } = {}) {
  const options = parseSetupArgs(args);
  const interactive = !options.yes && process.stdin.isTTY;
  let outputConfig = loadOutputConfig({ dataRoot: contextOSDataDir() });

  printSetupBanner();
  console.log(`◇ Installation directory:\n│  ${cwd}`);

  if (interactive) {
    const rl = readline.createInterface({ input, output });
    const proceed = await askSetupYesNo(rl, "Install to this directory?", true);
    if (!proceed) {
      rl.close();
      console.log("Setup cancelled.");
      return;
    }
    if (!options.agentsProvided) {
      rl.close();
      const selected = await multiSelect({
        message: "Select agents to install:",
        options: [
          { label: "Codex",              value: "codex",   selected: options.agents.includes("codex") },
          { label: "Claude",             value: "claude",  selected: options.agents.includes("claude") },
          { label: "Antigravity",         value: "agy",     selected: options.agents.includes("agy") },
          { label: "GitHub Copilot",     value: "copilot", selected: options.agents.includes("copilot") }
        ]
      });
      options.agents = selected;
      const rl2 = readline.createInterface({ input, output });
      try {
        options.syncRules = await askSetupYesNo(rl2, "Sync project rules and MCP servers through Ruler?", options.syncRules);
        options.syncSkills = await askSetupYesNo(rl2, "Sync skills through skillshare?", options.syncSkills);
      } finally {
        rl2.close();
      }
    } else {
      try {
        console.log(`◇ Install for agents:\n│  ${options.agents.join(", ")}`);
        options.syncRules = await askSetupYesNo(rl, "Sync project rules and MCP servers through Ruler?", options.syncRules);
        options.syncSkills = await askSetupYesNo(rl, "Sync skills through skillshare?", options.syncSkills);
      } finally {
        rl.close();
      }
    }

    console.log("");
    console.log("◇ Configure prompt output:");
    outputConfig = await configureOutputSections({
      dataRoot: contextOSDataDir(),
      select: multiSelect,
      askLimit: askOutputLimit
    });
  }

  if (interactive && !options.generateProjectContext) {
    const readiness = inspectBackendGuardReady({ cwd });
    if (readiness.skills.score < 50 || readiness.workflows.score < 50) {
      const rl = readline.createInterface({ input, output });
      try {
        options.generateProjectContext = await askSetupYesNo(
          rl,
          "Generate starter project skills and workflow?",
          true
        );
      } finally {
        rl.close();
      }
    }
  }

  console.log("");
  console.log("◇ Ready to setup:");
  for (const line of setupSummaryLines({
    cwd,
    ...options,
    promptSections: enabledOutputSectionsLabel(outputConfig),
    promptLimits: outputConfigLimitsLabel(outputConfig)
  })) console.log(`│  ${line}`);
  console.log("");

  if (!options.agents.length) throw new Error("No agents selected. Use --agents codex,claude,antigravity,copilot.");

  if (options.generateProjectContext) {
    console.log("◇ Generating starter project context...");
    const generated = generateProjectContext({ cwd });
    for (const line of formatProjectContextGeneration(generated).split("\n")) console.log(`│  ${line}`);
    console.log("");
  }

  for (const agent of options.agents) {
    console.log(`◇ Setting up ${agent}...`);
    await streamSetupOutput(() => install({ agent, copy: false }));
  }

  if (options.syncRules) {
    console.log("◇ Syncing project rules and MCP servers...");
    const syncAgents = options.agents.map((agent) => agent === "agy" ? "antigravity" : agent).join(",");
    const syncArgs = ["--rules", "--agents", syncAgents];
    if (options.yes) syncArgs.push("--yes");
    await streamSetupOutput(() => syncRules({ cwd, rootDir, args: syncArgs }));
  }

  if (options.syncSkills) {
    console.log("◇ Syncing skills...");
    const skillAgents = options.agents.map((agent) => agent === "agy" ? "antigravity" : agent).join(",");
    const syncArgs = ["--skills", "--agents", skillAgents];
    if (options.yes) syncArgs.push("--yes");

    const doSyncSkills = async () => streamSetupOutput(() => syncSkills({
      cwd,
      args: syncArgs,
      rebuildSkillEmbeddings: async ({ cwd: skillCwd, sourceDir }) => warmSkillEmbeddings({
        cwd: skillCwd,
        dataDir: contextOSDataDir(),
        allowRemote: !isModelCacheReady(contextOSDataDir()),
        skills: scanSkills({ cwd: skillCwd, roots: [sourceDir] })
      })
    }));

    await doSyncSkills();

    // Fallback: if no skills were found, offer community library installer
    const existing = detectExistingSkills({ cwd });
    const totalExisting = existing.reduce((sum, e) => sum + e.count, 0);
    if (totalExisting === 0) {
      console.log("");
      console.log("No skills found on this machine.");
      console.log("│  Install community skills to get started.");
      console.log("");

      if (options.yes || !process.stdin.isTTY) {
        console.log("│  Skipping community skill installer in non-interactive setup.");
        console.log("│  Run: backendguard skills");
        console.log("");
      } else {
        const installed = await runCommunitySkillInstaller(options.agents);
        if (installed > 0) {
          console.log("");
          console.log("◇ Re-syncing skills after install...");
          await doSyncSkills();
        }
      }
    }
  }

  console.log("");
  console.log("◇ BackendGuard is ready");
  console.log("│  Next: restart/open your agent from this project directory.");
  console.log("│  Try: backendguard debug -- \"Recheck authen flow\"");
  console.log("");
}

const args = process.argv.slice(2);
// `context` and `rules` are the primary backend-engineering command names;
// they dispatch through the existing `debug`/`skills` handlers so the
// underlying task-aware retrieval logic isn't duplicated.
const COMMAND_ALIASES = { context: "debug", rules: "skills" };
const command = COMMAND_ALIASES[args[0]] || args[0];

function installAgentsFromArgs(args) {
  const agentFlag = Math.max(args.indexOf("--agent"), args.indexOf("--agents"));
  if (agentFlag >= 0) {
    const value = args[agentFlag + 1] || "";
    return parseAgentList(value).map(normalizeInstallAgent).filter(Boolean);
  }
  return null; // no flag → interactive selection
}

const notifyUpdate = checkForUpdate({ currentVersion: packageVersion(), dataDir: contextOSDataDir() });

try {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
  } else if (command === "--version" || command === "-v") {
    console.log(packageVersion());
  } else if (command === "--config" || command === "config") {
    await configureOutputSections({
      dataRoot: contextOSDataDir(),
      select: multiSelect,
      askLimit: askOutputLimit
    });
  } else if (command === "install") {
    const copy = args.includes("--copy");
    const explicitAgents = installAgentsFromArgs(args);

    if (explicitAgents && explicitAgents.length) {
      // Direct mode: backendguard install --agents antigravity,codex
      for (const agent of explicitAgents) {
        console.log(`◇ Installing ${agent}...`);
        await streamSetupOutput(() => install({ copy, agent }));
        console.log("");
      }
    } else if (explicitAgents && !explicitAgents.length) {
      console.log("No valid agents specified. Use --agents codex,claude,antigravity,copilot.");
    } else {
      // Interactive mode: backendguard install
      const selected = await multiSelect({
        message: "Select agents to install:",
        options: SUPPORTED_AGENTS
      });
      if (!selected.length) {
        console.log("No agents selected. Nothing to install.");
      } else {
        for (const agent of selected) {
          console.log(`◇ Installing ${agent}...`);
          await streamSetupOutput(() => install({ copy, agent }));
          console.log("");
        }
        // Recommend community skills based on selected agents
        try {
          const libraryResults = await fetchSkillsForAgents(selected, { dataDir: contextOSDataDir() });
          printSkillRecommendations(libraryResults);
        } catch { /* skill library is best-effort */ }
      }
    }
  } else if (command === "setup") {
    await setup({ args: args.slice(1), cwd: process.cwd() });
  } else if (command === "debug") {
    const marker = args.indexOf("--");
    const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(1).join(" ");
    if (!task.trim()) throw new Error('Usage: backendguard debug -- "task"');
    await debug(task);
  } else if (command === "health") {
    await health();
  } else if (command === "doctor") {
    if (args.includes("--fix")) {
      const generated = generateProjectContext({ cwd: process.cwd(), force: args.includes("--force") });
      console.log(formatProjectContextGeneration(generated));
      console.log("");
      console.log(formatBackendGuardReady(inspectBackendGuardReady({ cwd: process.cwd() })));
    } else {
      console.log(formatBackendGuardReady(inspectBackendGuardReady({ cwd: process.cwd() })));
    }
  } else if (command === "stack") {
    console.log(formatStackReport(detectStack({ cwd: process.cwd() })));
  } else if (command === "check") {
    await checkCommand();
  } else if (command === "refresh") {
    await refresh();
  } else if (command === "autowarm") {
    const marker = args.indexOf("--");
    const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(1).join(" ");
    await warmEmbeddings(task || "project context", { syncMarketplace: false, quiet: true });
  } else if (command === "embeddings") {
    if (args[1] === "warm") {
      const marker = args.indexOf("--");
      const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(2).join(" ");
      await warmEmbeddings(task);
    } else {
      throw new Error(`Unknown embeddings command: ${args[1] || ""}\n\n${usage()}`);
    }
  } else if (command === "report") {
    console.log(formatReport(loadLastReport()));
  } else if (command === "evidence") {
    console.log(formatEvidence(loadLastReport()));
  } else if (command === "stats") {
    console.log(formatStats(loadStats(contextOSWorkspaceDataDir())));
  } else if (command === "benchmark") {
    if (args.includes("--skills")) {
      console.log(formatSkillRoutingBenchmark(await runSkillRoutingEval({ rootDir })));
    } else {
    const marker = args.indexOf("--");
    const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(1).join(" ");
    if (!task.trim()) throw new Error('Usage: backendguard benchmark -- "task"');
    console.log(formatBenchmark(benchmarkWorkspace({ cwd: process.cwd(), task })));
    }
  } else if (command === "leaderboard") {
    if (args.includes("--hallucination") && args.includes("--live")) {
      const agents = leaderboardAgentsFromArgs(args);
      const limitIndex = args.indexOf("--limit");
      const timeoutIndex = args.indexOf("--timeout-ms");
      console.log(formatAgentLeaderboard(runAgentLeaderboard({
        rootDir,
        agents: agents.length ? agents : undefined,
        caseLimit: limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined,
        timeoutMs: timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : undefined
      })));
    } else if (args.includes("--hallucination")) {
      console.log(formatHallucinationLeaderboard(await runHallucinationLeaderboard({ rootDir })));
    } else if (args.includes("--agents")) {
      const index = args.indexOf("--agents");
      const agents = String(args[index + 1] || "").split(",").map((agent) => agent.trim()).filter(Boolean);
      const limitIndex = args.indexOf("--limit");
      const timeoutIndex = args.indexOf("--timeout-ms");
      console.log(formatAgentLeaderboard(runAgentLeaderboard({
        rootDir,
        agents: agents.length ? agents : undefined,
        caseLimit: limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined,
        timeoutMs: timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : undefined
      })));
    } else {
      throw new Error("Usage: backendguard leaderboard --hallucination OR backendguard leaderboard --hallucination --live --agent codex OR backendguard leaderboard --agents codex,gemini");
    }
  } else if (command === "skills") {
    if (args[1] === "doctor") {
      const marker = args.indexOf("--");
      const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(2).join(" ");
      await skillsDoctor(task);
      process.exitCode = 0;
    } else {
    // Interactive community skill library selector + installer
    const agentsFlag = args.indexOf("--agents");
    const forceRefresh = args.includes("--refresh");
    let agents;
    if (agentsFlag >= 0 && args[agentsFlag + 1]) {
      agents = args[agentsFlag + 1].split(",").map((a) => a.trim()).filter(Boolean);
    } else {
      agents = ["codex", "claude", "agy", "copilot"];
    }

    const DIM = "\x1B[2m";
    const RESET = "\x1B[0m";
    const CYAN = "\x1B[36m";
    const GREEN = "\x1B[32m";
    const YELLOW = "\x1B[33m";
    const BOLD = "\x1B[1m";

    const installed = await runCommunitySkillInstaller(agents);
    if (installed === 0) {
      console.log(`\n${DIM}No installations were completed.${RESET}`);
    } else {
      console.log(`${CYAN}◇${RESET} ${BOLD}Syncing installed skills${RESET}`);
      await streamSetupOutput(() => syncSkills({
        cwd: process.cwd(),
        args: ["--skills", "--agents", agents.map((agent) => agent === "agy" ? "antigravity" : agent).join(","), "--yes"],
        rebuildSkillEmbeddings: async ({ cwd, sourceDir }) => warmSkillEmbeddings({
          cwd,
          dataDir: contextOSDataDir(),
          allowRemote: !isModelCacheReady(contextOSDataDir()),
          skills: scanSkills({ cwd, roots: [sourceDir] })
        })
      }));
    }
    console.log("");
    }
  } else if (command === "sync") {
    if (args.includes("--workflows")) {
      await syncWorkflows({
        cwd: process.cwd(),
        dataDir: contextOSDataDir(),
        allowRemote: !isModelCacheReady(contextOSDataDir()),
        args: args.slice(1)
      });
    } else if (args.includes("--skills")) {
      await syncSkills({
        cwd: process.cwd(),
        args: args.slice(1),
        rebuildSkillEmbeddings: async ({ cwd, sourceDir }) => warmSkillEmbeddings({
          cwd,
          dataDir: contextOSDataDir(),
          allowRemote: !isModelCacheReady(contextOSDataDir()),
          skills: scanSkills({ cwd, roots: [sourceDir] })
        })
      });
    } else {
      await syncRules({ cwd: process.cwd(), rootDir, args: args.slice(1) });
    }
  } else if (command === "ruler" || command === "skillshare") {
    const passthrough = parsePassthroughArgs(args);
    const result = runPassthrough(passthrough);
    if (result.signal) {
      console.error(`${passthrough.command} terminated by signal ${result.signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status;
    }
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await notifyUpdate();
}
