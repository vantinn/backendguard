import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scoreContext } from "../lib/score-context.js";
import { scheduleContext } from "../lib/scheduler.js";

const CTX_BIN = fileURLToPath(new URL("../../../bin/ctx.js", import.meta.url));

export function createBackendGuardMcpServer({ dataDir, getHealth = defaultHealth, runCommand = runCliCommand, scoreContextRunner = scoreContext } = {}) {
  const server = new McpServer({
    name: "ctx-mcp",
    version: "0.1.0"
  });

  server.registerTool("ctx_health", {
    title: "BackendGuard health",
    description: "Reports BackendGuard MCP bridge and embedding model readiness.",
    inputSchema: {},
    outputSchema: {
      model_cache_ready: z.boolean(),
      embedding_pipeline_loaded: z.boolean(),
      bridge_ready: z.boolean(),
      preload_status: z.string().optional(),
      loaded_at: z.number().optional(),
      error: z.string().optional(),
      score_queue_depth: z.number().optional(),
      score_active: z.number().optional(),
      score_cache_entries: z.number().optional(),
      score_inflight: z.number().optional(),
      score_concurrency: z.number().optional(),
      score_cache_ttl_ms: z.number().optional(),
      score_request_timeout_ms: z.number().optional()
    }
  }, async () => {
    const health = getHealth();
    return {
      content: [{ type: "text", text: JSON.stringify(health) }],
      structuredContent: health
    };
  });

  registerCliTool(server, {
    name: "ctx_detect_stack",
    title: "Detect backend stack",
    description: "Inspects package.json, lockfiles, prisma/schema.prisma, ormconfig, and Dockerfiles to report the detected framework, language, database, ORM, cache, and auth — never claims a technology without file/dependency evidence.",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["stack"],
    runCommand
  });

  server.registerTool("ctx_score_context", {
    title: "Retrieve backend engineering rules",
    description: "Retrieves task-aware security, architecture, database, and testing rules from AGENTS.md for the current prompt, ranked by relevance to the detected backend stack, and suggests the files/skills most relevant to the task.",
    inputSchema: {
      cwd: z.string().optional(),
      prompt: z.string(),
      openFiles: z.array(z.string()).optional(),
      maxFiles: z.number().int().positive().max(20).optional(),
      maxSkills: z.number().int().positive().max(10).optional(),
      maxWorkflows: z.number().int().positive().max(10).optional(),
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        path: z.string().optional()
      })).optional(),
      workflows: z.array(z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string(),
        chain: z.array(z.string()).optional(),
        path: z.string().optional()
      })).optional()
    },
    outputSchema: {
      scoredRules: z.array(z.any()),
      suggestedFiles: z.array(z.any()),
      suggestedSkills: z.array(z.any()),
      suggestedWorkflows: z.array(z.any()),
      telemetry: z.record(z.string(), z.any())
    }
  }, async (args) => {
    const result = await scoreContextRunner({
      cwd: args.cwd || process.cwd(),
      prompt: args.prompt || "",
      openFiles: args.openFiles || [],
      dataDir,
      maxFiles: args.maxFiles || 5,
      maxSkills: args.maxSkills || 3,
      maxWorkflows: args.maxWorkflows || 2,
      skills: args.skills,
      workflows: args.workflows
    });

    // Format the same human-readable context that the hook path produces
    const scheduled = scheduleContext({
      rules: result.scoredRules,
      relevantFiles: result.suggestedFiles,
      suggestedSkills: result.suggestedSkills,
      suggestedWorkflows: result.suggestedWorkflows,
      prompt: args.prompt || ""
    });

    const contextText = scheduled.additionalContext || "";
    const contentBlocks = [];

    // Primary block: human-readable rules, files, skills, workflows
    if (contextText) {
      contentBlocks.push({ type: "text", text: contextText });
    }

    // Secondary block: telemetry metadata
    contentBlocks.push({
      type: "text",
      text: JSON.stringify(result.telemetry)
    });

    return {
      content: contentBlocks,
      structuredContent: {
        scoredRules: result.scoredRules,
        suggestedFiles: result.suggestedFiles,
        suggestedSkills: result.suggestedSkills,
        suggestedWorkflows: result.suggestedWorkflows,
        telemetry: result.telemetry
      }
    };
  });

  registerCliTool(server, {
    name: "ctx_debug_context",
    title: "Debug BackendGuard routing",
    description: "Preview rules, files, skills, workflows, and final prompt context for a task.",
    inputSchema: {
      cwd: z.string().optional(),
      prompt: z.string()
    },
    args: ({ prompt }) => ["debug", "--", prompt],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_doctor_repo",
    title: "Inspect backend production readiness",
    description: "Scores this repository's production readiness (rule coverage, security/database/testing rule packs installed, workflow chain) without modifying files.",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["doctor"],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_skills_doctor",
    title: "Explain backend rule routing",
    description: "Explains which backend engineering rule packs (security, nestjs, postgresql, typeorm, prisma, redis, ...) would be selected for a prompt and why.",
    inputSchema: {
      cwd: z.string().optional(),
      prompt: z.string()
    },
    args: ({ prompt }) => ["skills", "doctor", "--", prompt],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_analyze_changes",
    title: "Analyze uncommitted backend changes",
    description: "Diffs the working tree against scheduled AGENTS.md rules and returns a severity-ranked (CRITICAL/HIGH/MEDIUM/LOW/INFO) compliance report across security, architecture, database, performance, and testing categories.",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["check"],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_report_last_task",
    title: "Show last compliance report",
    description: "Reads the latest local backend engineering compliance report for the workspace (from the last agent task or `backendguard check`).",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["report"],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_evidence_last_task",
    title: "Show last compliance evidence",
    description: "Reads file/line-level evidence (rule, file, evidence, recommendation) for the latest local compliance report.",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["evidence"],
    runCommand
  });

  registerCliTool(server, {
    name: "ctx_stats_workspace",
    title: "Show BackendGuard workspace stats",
    description: "Summarize local BackendGuard prompt, report, hook, and telemetry history.",
    inputSchema: {
      cwd: z.string().optional()
    },
    args: () => ["stats"],
    runCommand
  });

  return server;
}

function registerCliTool(server, { name, title, description, inputSchema, args, runCommand }) {
  server.registerTool(name, {
    title,
    description,
    inputSchema,
    outputSchema: {
      code: z.number(),
      stdout: z.string(),
      stderr: z.string()
    }
  }, async (toolArgs) => {
    const result = await runCommand(args(toolArgs), {
      cwd: toolArgs.cwd || process.cwd()
    });
    const text = result.stdout || result.stderr || `(backendguard command exited with code ${result.code})`;
    return {
      content: [{ type: "text", text }],
      structuredContent: result
    };
  });
}

function runCliCommand(args, { cwd = process.cwd(), timeoutMs = Number(process.env.BACKENDGUARD_MCP_CLI_TOOL_TIMEOUT_MS || 10000) } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CTX_BIN, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: stderr || `backendguard command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error?.message || String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function defaultHealth() {
  return {
    model_cache_ready: false,
    embedding_pipeline_loaded: false,
    bridge_ready: false,
    preload_status: "unknown"
  };
}
