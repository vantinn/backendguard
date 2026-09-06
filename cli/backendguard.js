#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { runProcess } from "../runtime/process-runner.js";

import { readAgentsChain } from "../rules/agents-file-reader.js";
import { filterActionableRules, parseRules, scoreRules } from "../rules/rule-engine.js";
import { scheduleContext } from "../rules/context-scheduler.js";
import { buildReport, formatEvidence, formatReport } from "../compliance/compliance-reporter.js";
import { checkCompliance, readGitSnapshot } from "../compliance/rule-compliance.js";
import { structuralComplianceForChangedFiles } from "../analysis/index.js";
import { installGlobalHooks } from "../integrations/codex/codex-hooks.js";
import { formatStats, loadStats } from "../runtime/stats.js";
import { isModelCacheReady, modelCacheDir, warmRuleEmbeddings } from "../retrieval/embedding-scorer.js";
import { warmFileEmbeddings } from "../retrieval/file-embedding-retriever.js";
import { scoreContext } from "../retrieval/context-retriever.js";
import { defaultDataRoot, workspaceDataDir, workspaceMarkerPath } from "../runtime/workspace-data.js";
import { installMcpTelemetryProxies } from "../integrations/mcp/mcp-proxy-install.js";
import { benchmarkWorkspace, formatBenchmark } from "../runtime/benchmark.js";
import { formatSkillRoutingBenchmark, runSkillRoutingEval } from "../evaluation/skill-routing/run-eval.js";
import { formatHallucinationLeaderboard, runHallucinationLeaderboard } from "../evaluation/hallucination/run-leaderboard.js";
import { formatAgentLeaderboard, runAgentLeaderboard } from "../evaluation/hallucination/run-agent-leaderboard.js";
import { copyPackageRoot, syncPackageRoot } from "../runtime/package-install.js";
import { installClaudeHooks } from "../integrations/claude/claude-hooks.js";
import { installClaudeMcp } from "../integrations/claude/claude-mcp.js";
import { installAntigravityHooks } from "../integrations/antigravity/antigravity-hooks.js";
import { installAntigravityMcp } from "../integrations/antigravity/antigravity-mcp.js";
import { installCopilotHooks } from "../integrations/copilot/copilot-hooks.js";
import { installCopilotMcp } from "../integrations/copilot/copilot-mcp.js";
import { readCodexMcpServers, syncRules } from "../agent-context/rule-sync.js";
import { detectGraphStrategy, embedCodeReviewGraph, formatCodeReviewGraphEmbedding, formatGraphStrategy } from "../retrieval/graph-strategy.js";
import { writeInnerGitignore, ensureRootGitignore } from "../runtime/gitignore.js";
import { dedupeAgentVisibleSkills, repairSkillSymlinks, syncSkills, detectExistingSkills } from "../agent-context/skill-sync.js";
import { diagnoseSkills, scanSkills, warmSkillEmbeddings } from "../agent-context/skill-discoverer.js";
import { parsePassthroughArgs, runPassthrough } from "../runtime/passthrough.js";
import { parseSetupArgs, setupSummaryLines } from "../runtime/setup-wizard.js";
import {
  agentSelectionOptions,
  assertKnownAgent,
  emptyAgentSelectionError,
  externalAgentName,
  parseInstallAgents
} from "../runtime/agents.js";
import { multiSelect } from "../runtime/multi-select.js";
import { configureOutputSections, enabledOutputSectionsLabel, loadOutputConfig, outputConfigLimits, outputConfigLimitsLabel } from "../agent-context/output-config.js";
import { syncWorkflows, warmWorkflowEmbeddings } from "../agent-context/workflow-discoverer.js";
import { checkForUpdate } from "../runtime/update-notifier.js";
import { fetchSkillsForAgents, printSkillRecommendations, getAllLibraries, getInstallCommands } from "../agent-context/skill-library.js";
import { callCtxHealth, ctxMcpSocketPath, invalidateCtxMcpSocket } from "../integrations/mcp/mcp-client.js";
import { runPrefixedCommand } from "../runtime/shell-runner.js";
import { formatBackendGuardReady, inspectBackendGuardReady } from "../compliance/readiness-scorer.js";
import { detectStack, formatStackReport } from "../analysis/stack-detector.js";
import { formatProjectContextGeneration, generateProjectContext } from "../agent-context/starter-context-generator.js";
import { retrievalMode } from "../agent-context/prompt-hook.js";
import { COMMANDS, findCommand, renderCommandHelp, renderUsage, resolveCommandName, wantsHelp } from "./command-registry.js";
import { EXIT, EnvironmentError, IntegrationError, UsageError, exitCodeFor, formatCliError } from "./exit-codes.js";
import { isExpectedError } from "../runtime/errors.js";
import { meetsSeverity, parseSeverity, rejectUnknownFlags, resolveTargetDirectory } from "./options.js";
import { runAnalyzeCommand } from "./analyze-command.js";

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
  const libraryResults = await fetchSkillsForAgents(agents, { dataDir: dataRoot() });

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


function usage() {
  return renderUsage();
}

/**
 * Agent names are validated by `runtime/agents.js`, which raises a `UsageError`
 * — a typo is the user's, so it prints one actionable line and exits 2 instead
 * of claiming BackendGuard has a bug.
 */
function normalizeInstallAgent(agent) {
  return assertKnownAgent(agent);
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
        console.log(`[backendguard] ${label}...`);
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
        console.log(`[backendguard] ${label}`);
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

// `--copy` drops a self-contained copy of the package under $CODEX_HOME without
// touching hook or MCP configuration. The plugin directory alone is not runnable
// (it only holds manifests plus thin entrypoints), so the whole package root is
// copied — otherwise the hook shims would resolve outside the copy.
function copyInstall() {
  const target = path.join(codexHome(), "marketplaces", "backendguard");
  copyPackageRoot({ rootDir, targetRoot: target });
  console.log(`Installed BackendGuard package to ${target}`);
  console.log(`Plugin directory: ${path.join(target, "plugins", "backendguard")}`);
  console.log("Restart Codex if it was already running, then submit a task to trigger BackendGuard.");
}

function agentInstallRoot(agent) {
  return path.join(dataRoot(), "agents", agent, "backendguard");
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
      // Unreachable through the CLI — argument parsing validates names first —
      // but kept so a direct call to install() still fails as a usage problem.
      throw new UsageError(`Unknown agent '${agent}'.`, {
        hint: "Supported agents: codex, claude, agy, antigravity, copilot."
      });
    }

    progress.step(10, "copying marketplace");
    const marketplaceRoot = activeCodexMarketplaceRoot();

    progress.step(25, "refreshing codex plugin");
    tryRunCodex(["plugin", "remove", "backendguard@backendguard"]);
    tryRunCodex(["plugin", "marketplace", "remove", "backendguard"]);
    tryRunCodex(["mcp", "remove", "backendguard-mcp"]);
    runCodex(["plugin", "marketplace", "add", marketplaceRoot]);
    runCodex(["plugin", "add", "backendguard@backendguard"]);
    progress.step(45, "installing mcp");
    runCodex(["mcp", "add", "backendguard-mcp", "--", "node", path.join(marketplaceRoot, "plugins", "backendguard", "mcp", "server.js")]);
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
    console.log(`MCP     → backendguard-mcp installed`);
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
  const dataDir = dataRoot();
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
    runProcess("codex", args, { stdio: "ignore" });
  } catch {
    // Best effort cleanup for repeat installs.
  }
}

function runCodex(args) {
  try {
    runProcess("codex", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    // Suppress stdout (e.g. "Added marketplace…", "Added global MCP server…")
    // — the progress spinner already provides feedback.
  } catch (error) {
    const status = typeof error.status === "number" ? error.status : 1;
    if (error?.code === "ENOENT") {
      throw new EnvironmentError("The Codex CLI was not found on PATH.", {
        hint: "Install Codex and sign in, or install a different agent: backendguard install claude"
      });
    }
    throw new IntegrationError(`\`codex ${args.join(" ")}\` failed with exit code ${status}.`, {
      integration: "codex",
      hint: "Check that the Codex CLI is installed and authenticated (`codex --version`)."
    });
  }
}

function loadLastReport() {
  const reportDir = currentWorkspaceDir();
  const candidates = [
    path.join(reportDir, "last-report.json"),
    path.join(codexHome(), "backendguard", "last-report.json"),
    
    
    path.join(process.cwd(), ".backendguard", "last-report.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
  }
  throw new EnvironmentError("No BackendGuard report found for this workspace.", {
    hint: "Run an agent task with BackendGuard enabled so the Stop hook can write one, "
      + "or run `backendguard check` to analyze uncommitted changes directly."
  });
}

function dataRoot() {
  return defaultDataRoot();
}

function currentWorkspaceDir(cwd = process.cwd()) {
  return workspaceDataDir({ cwd, dataRoot: dataRoot() });
}

async function debug(task) {
  const cwd = process.cwd();
  const limits = outputConfigLimits(loadOutputConfig({ dataRoot: dataRoot() }));
  const scored = await scoreContext({
    cwd,
    prompt: task,
    dataDir: dataRoot(),
    maxFiles: limits.files,
    maxSkills: limits.skills,
    maxWorkflows: limits.workflows,
    embeddingTimeoutMs: Number(process.env.BACKENDGUARD_EMBEDDING_DEBUG_TIMEOUT_MS || 5000)
  });
  const rules = scored.scoredRules;
  const outputConfig = loadOutputConfig({ dataRoot: dataRoot() });
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
  console.log(`workspace data: ${currentWorkspaceDir(cwd)}`);
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
/**
 * @param {{json?: boolean, failOn?: string|null}} options
 * @returns {Promise<number>} the process exit code.
 */
async function checkCommand({ json = false, failOn = null } = {}) {
  const cwd = process.cwd();
  const task = "review uncommitted backend changes for security, architecture, database, and testing compliance";
  const limits = outputConfigLimits(loadOutputConfig({ dataRoot: dataRoot() }));
  const scored = await scoreContext({
    cwd,
    prompt: task,
    dataDir: dataRoot(),
    maxFiles: limits.files,
    maxSkills: limits.skills,
    maxWorkflows: limits.workflows,
    embeddingTimeoutMs: Number(process.env.BACKENDGUARD_EMBEDDING_DEBUG_TIMEOUT_MS || 5000)
  });
  const outputConfig = loadOutputConfig({ dataRoot: dataRoot() });
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

  const reportDir = currentWorkspaceDir(cwd);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "last-report.json"), JSON.stringify(report, null, 2));

  if (gitSnapshot.mode === "none") {
    throw new EnvironmentError("No git repository detected; there is no change to check.", {
      hint: "Run `backendguard check` inside a git repository, or use `backendguard analyze` to scan the whole project."
    });
  }
  if (!gitSnapshot.changedFiles.length) {
    if (json) console.log(JSON.stringify({ ...report, findings: [], changedFiles: [] }, null, 2));
    else console.log("No uncommitted changes detected.");
    return EXIT.OK;
  }

  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));

  if (!failOn) return EXIT.OK;
  // Only structural findings carry a severity that can be compared: a
  // rule-keyword verdict is a relevance guess, not a graded defect, so it must
  // not decide a CI exit code.
  const blocking = compliance.filter((item) =>
    item.kind === "structural" && meetsSeverity({ severity: item.rule.severity }, failOn));
  if (blocking.length) {
    console.log("");
    console.log(`${blocking.length} finding(s) at or above ${failOn}; failing as requested by --fail-on.`);
    return EXIT.FINDINGS;
  }
  return EXIT.OK;
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
  const dataDir = dataRoot();
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
  console.log(`backendguard-mcp: ${socketPresent ? "running" : "not running"}`);
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
  if (!String(task || "").trim()) {
    throw new UsageError("A task description is required for `backendguard rules doctor`.", {
      hint: 'Example: backendguard rules doctor -- "add a paginated orders endpoint"'
    });
  }
  const result = await diagnoseSkills({
    cwd: process.cwd(),
    prompt: task,
    dataDir: dataRoot(),
    skills: scanSkills({ cwd: process.cwd() }),
    limit: outputConfigLimits(loadOutputConfig({ dataRoot: dataRoot() })).skills,
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
  const dataDir = dataRoot();
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
  const invalidatedBridge = invalidateCtxMcpSocket(dataRoot());
  const warmResult = await warmInstallEmbeddings();
  console.log(`Marketplace: ${marketplaceSync.synced ? "synced" : "already active"} (${marketplaceSync.targetRoot})`);
  console.log(`Indexes: ${warmResult.fileCount || 0} file paths rebuilt, ${warmResult.skillCount || 0} skills indexed`);
  console.log(`Graph embeddings: ${formatCodeReviewGraphEmbedding(warmResult.graphEmbedding)}`);
  if (invalidatedBridge) console.log("Bridge: stale private socket invalidated");
  console.log("Restart Codex if backendguard-mcp was already running.");
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
  // Non-interactive runs have no prompt to fill the selection in, so a missing
  // agent is knowable before anything is printed or written.
  if (!interactive && !options.agents.length) {
    throw emptyAgentSelectionError({ command: "backendguard setup" });
  }
  let outputConfig = loadOutputConfig({ dataRoot: dataRoot() });

  /** Optional integrations that failed; reported at the end instead of aborting. */
  const degraded = [];

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
        options: agentSelectionOptions({ cwd })
      });
      options.agents = selected;
      // Validate here, not at the end. The wizard used to ask about Ruler,
      // skillshare, prompt sections and starter context first, then fail with
      // a bare Error that the CLI could only report as an internal bug.
      if (!options.agents.length) throw emptyAgentSelectionError({ command: "backendguard setup" });
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
      dataRoot: dataRoot(),
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

  if (!options.agents.length) throw emptyAgentSelectionError({ command: "backendguard setup" });

  if (options.generateProjectContext) {
    console.log("◇ Generating starter project context...");
    const generated = generateProjectContext({ cwd });
    for (const line of formatProjectContextGeneration(generated).split("\n")) console.log(`│  ${line}`);
    console.log("");
  }

  // One agent failing (its CLI missing, say) should not lose the agents that
  // installed successfully — but if none installed, the setup did not happen.
  const installedAgents = [];
  for (const agent of options.agents) {
    console.log(`◇ Setting up ${agent}...`);
    const ok = await runOptionalIntegration(`${agent} install`, agent, degraded, () =>
      streamSetupOutput(() => install({ agent, copy: false })));
    if (ok) installedAgents.push(agent);
  }
  if (!installedAgents.length) {
    throw new EnvironmentError("No agent could be set up.", {
      hint: degraded.map((entry) => entry.message).join(" ")
        || "Check that the agent CLI is installed, then re-run `backendguard setup`."
    });
  }
  options.agents = installedAgents;

  if (options.syncRules) {
    console.log("◇ Syncing project rules and MCP servers...");
    const syncAgents = options.agents.map(externalAgentName).join(",");
    const syncArgs = ["--rules", "--agents", syncAgents];
    if (options.yes) syncArgs.push("--yes");
    await runOptionalIntegration("Ruler rule/MCP sync", "ruler", degraded, () =>
      streamSetupOutput(() => syncRules({ cwd, rootDir, args: syncArgs })));
  }

  if (options.syncSkills) {
    console.log("◇ Syncing skills...");
    const skillAgents = options.agents.map(externalAgentName).join(",");
    const syncArgs = ["--skills", "--agents", skillAgents];
    if (options.yes) syncArgs.push("--yes");

    const doSyncSkills = async () => streamSetupOutput(() => syncSkills({
      cwd,
      args: syncArgs,
      rebuildSkillEmbeddings: async ({ cwd: skillCwd, sourceDir }) => warmSkillEmbeddings({
        cwd: skillCwd,
        dataDir: dataRoot(),
        allowRemote: !isModelCacheReady(dataRoot()),
        skills: scanSkills({ cwd: skillCwd, roots: [sourceDir] })
      })
    }));

    const skillsSynced = await runOptionalIntegration("skillshare skill sync", "skillshare", degraded, doSyncSkills);

    // Fallback: if no skills were found, offer community library installer
    const existing = skillsSynced ? detectExistingSkills({ cwd }) : [];
    const totalExisting = existing.reduce((sum, e) => sum + e.count, 0);
    if (skillsSynced && totalExisting === 0) {
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
  if (degraded.length) {
    console.log("◇ BackendGuard is ready, with skipped steps");
    for (const entry of degraded) {
      console.log(`│  ${entry.step}: ${entry.message}`);
      if (entry.hint) console.log(`│    ${entry.hint}`);
    }
    console.log("│  These are optional integrations — the agent setup above completed.");
  } else {
    console.log("◇ BackendGuard is ready");
  }
  console.log("│  Next: restart/open your agent from this project directory.");
  console.log("│  Try: backendguard debug -- \"Recheck authen flow\"");
  console.log("");
  return { agents: options.agents, degraded };
}

/**
 * Runs one optional third-party integration step.
 *
 * Ruler and skillshare are optional: when one of them is missing, refuses to
 * install, or fails, the agent setup that already succeeded is still valid.
 * Before this, any failure in either step aborted the wizard — a skillshare
 * crash ended a completed Ruler+agent install with
 * "This is a bug in BackendGuard. Please report it."
 *
 * Only an environment or integration failure is absorbed. A genuine fault
 * inside BackendGuard propagates, and so do a usage error and a configuration
 * error: those name one specific thing the user must fix, and burying that
 * message under "could not install" — with the wrong exit code — would undo
 * the classification work this release is about.
 */
async function runOptionalIntegration(step, integration, degraded, run) {
  try {
    await run();
    return true;
  } catch (error) {
    if (!isRecoverableIntegrationError(error)) throw error;
    degraded.push({ step, integration, message: error.message, hint: error.hint });
    console.log(`│  Skipped: ${error.message}`);
    if (error.hint) console.log(`│  ${error.hint}`);
    console.log("");
    return false;
  }
}

/** Environment and integration failures are the ones a later step can survive. */
function isRecoverableIntegrationError(error) {
  return error instanceof EnvironmentError || error instanceof IntegrationError;
}

const args = process.argv.slice(2);
const debugMode = args.includes("--debug") || process.env.BACKENDGUARD_DEBUG === "1";
// `context` and `rules` are the canonical backend-engineering command names.
// `debug` and `skills` remain as aliases so existing scripts keep working; the
// dispatch below uses the internal names.
const INTERNAL_NAMES = { context: "debug", rules: "skills" };
const requestedCommand = args[0];
const canonicalCommand = resolveCommandName(requestedCommand);
const command = INTERNAL_NAMES[canonicalCommand] || canonicalCommand;

/**
 * `backendguard install claude`, `--agent claude` and `--agents claude,codex`
 * are all documented; only the two flag forms were implemented, so the
 * positional form fell through to the interactive prompt and — with nothing
 * preselected and no TTY — installed nothing and exited 0.
 *
 * Returns null only when the user named no agent, which is the one case that
 * should open the prompt.
 */
function installAgentsFromArgs(args) {
  const parsed = parseInstallAgents(args, { knownFlags: ["--agent", "--agents"] });
  return parsed ? parsed.agents : null;
}

const notifyUpdate = checkForUpdate({ currentVersion: packageVersion(), dataDir: dataRoot() });

try {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    // `backendguard help <command>` and `backendguard --help <command>` both
    // reach the per-command help, so a user never has to guess which form works.
    const topic = args.find((argument, index) => index > 0 && !argument.startsWith("-"));
    console.log(topic ? renderCommandHelp(topic) : usage());
  } else if (command === "--version" || command === "-v") {
    console.log(packageVersion());
  } else if (!findCommand(canonicalCommand)) {
    throw new UsageError(`Unknown command: ${requestedCommand}`, {
      hint: "Run `backendguard --help` to see the available commands."
    });
  } else if (wantsHelp(args)) {
    console.log(renderCommandHelp(canonicalCommand));
  } else if (validateArgs(canonicalCommand, args), command === "analyze") {
    process.exitCode = runAnalyzeCommand(args, { cwd: process.cwd() });
  } else if (command === "--config" || command === "config") {
    await configureOutputSections({
      dataRoot: dataRoot(),
      select: multiSelect,
      askLimit: askOutputLimit
    });
  } else if (command === "install") {
    const copy = args.includes("--copy");
    // Parsing validates every agent name, so an unknown agent is rejected
    // before the first file is copied rather than half-way through the install.
    const explicitAgents = installAgentsFromArgs(args);
    const interactive = explicitAgents === null;

    const agents = explicitAgents ?? await multiSelect({
      message: "Select agents to install:",
      options: agentSelectionOptions()
    });

    if (!agents.length) throw emptyAgentSelectionError();

    // One agent's CLI being absent must not cancel the others the user asked
    // for: `install --agents codex,claude` used to abort on codex and never
    // attempt claude. Failures are collected and reported at the end, and the
    // command still exits non-zero so a script notices.
    const installed = [];
    const failed = [];
    for (const agent of agents) {
      console.log(`◇ Installing ${agent}...`);
      const ok = await runOptionalIntegration(`${agent} install`, agent, failed, () =>
        streamSetupOutput(() => install({ copy, agent })));
      if (ok) installed.push(agent);
      console.log("");
    }

    if (!installed.length) {
      throw new EnvironmentError(`Could not install ${agents.length === 1 ? agents[0] : "any of the requested agents"}.`, {
        hint: failed.map((entry) => entry.hint || entry.message).join(" ")
          || "Check that the agent's CLI is installed, then re-run."
      });
    }
    if (failed.length) {
      console.log(`Installed: ${installed.join(", ")}`);
      for (const entry of failed) console.log(`Not installed — ${entry.step}: ${entry.message}`);
      console.log(`Re-run for those once fixed: backendguard install --agents ${failed.map((entry) => entry.integration).join(",")}`);
      process.exitCode = EXIT.ENVIRONMENT;
    }

    if (interactive) {
      // Recommend community skills based on the selected agents.
      try {
        const libraryResults = await fetchSkillsForAgents(installed, { dataDir: dataRoot() });
        printSkillRecommendations(libraryResults);
      } catch { /* skill library is best-effort */ }
    }
  } else if (command === "setup") {
    await setup({ args: args.slice(1), cwd: process.cwd() });
  } else if (command === "debug") {
    const marker = args.indexOf("--");
    const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(1).join(" ");
    if (!task.trim()) {
      throw new UsageError("A task description is required.", {
        hint: 'Example: backendguard context -- "add a paginated orders endpoint"'
      });
    }
    await debug(task);
  } else if (command === "health") {
    await health();
  } else if (command === "doctor") {
    if (args.includes("--fix")) {
      const generated = generateProjectContext({ cwd: process.cwd(), force: args.includes("--force") });
      console.log(formatProjectContextGeneration(generated));
      console.log("");
    }
    const readiness = inspectBackendGuardReady({ cwd: process.cwd() });
    console.log(args.includes("--json") ? JSON.stringify(readiness, null, 2) : formatBackendGuardReady(readiness));
  } else if (command === "stack") {
    const target = resolveTargetDirectory(args, { cwd: process.cwd() });
    const stack = detectStack({ cwd: target });
    console.log(args.includes("--json")
      ? JSON.stringify(stack, null, 2)
      : formatStackReport(stack, { showEvidence: args.includes("--evidence") }));
  } else if (command === "check") {
    process.exitCode = await checkCommand({ json: args.includes("--json"), failOn: parseSeverity(args, "--fail-on") });
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
      throw new UsageError(`Unknown embeddings subcommand: ${args[1] || "(none)"}`, {
        hint: 'The only subcommand is `warm`: backendguard embeddings warm -- "task"'
      });
    }
  } else if (command === "report") {
    console.log(formatReport(loadLastReport()));
  } else if (command === "evidence") {
    console.log(formatEvidence(loadLastReport()));
  } else if (command === "stats") {
    console.log(formatStats(loadStats(currentWorkspaceDir())));
  } else if (command === "benchmark") {
    if (args.includes("--skills")) {
      console.log(formatSkillRoutingBenchmark(await runSkillRoutingEval({ rootDir })));
    } else {
    const marker = args.indexOf("--");
    const task = marker >= 0 ? args.slice(marker + 1).join(" ") : args.slice(1).join(" ");
    if (!task.trim()) {
      throw new UsageError("A task description is required.", {
        hint: 'Example: backendguard benchmark -- "add a paginated orders endpoint", or use --skills for the routing benchmark'
      });
    }
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
      throw new UsageError("A leaderboard mode is required.", {
        hint: "Use --hallucination for the offline benchmark, or --agents <names> for the live one."
      });
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
          dataDir: dataRoot(),
          allowRemote: !isModelCacheReady(dataRoot()),
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
        dataDir: dataRoot(),
        allowRemote: !isModelCacheReady(dataRoot()),
        args: args.slice(1)
      });
    } else if (args.includes("--skills")) {
      await syncSkills({
        cwd: process.cwd(),
        args: args.slice(1),
        rebuildSkillEmbeddings: async ({ cwd, sourceDir }) => warmSkillEmbeddings({
          cwd,
          dataDir: dataRoot(),
          allowRemote: !isModelCacheReady(dataRoot()),
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
    throw new UsageError(`Unknown command: ${requestedCommand}`, {
      hint: "Run `backendguard --help` to see the available commands."
    });
  }
} catch (error) {
  console.error(formatCliError(error, { debug: debugMode }));
  process.exitCode = exitCodeFor(error);
} finally {
  await notifyUpdate();
}

/**
 * Rejects flags the command does not declare, so a typo never looks like it
 * was applied. The passthrough commands forward everything after `--` to a
 * third-party CLI and so are exempt.
 */
function validateArgs(name, argv) {
  if (name === "ruler" || name === "skillshare") return;
  rejectUnknownFlags(argv, findCommand(name));
}
