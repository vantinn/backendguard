import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { filterActionableRules, findExplicitPromptFiles, findProjectManifestFiles, findRelevantFiles, isDocumentationOnlyRule, isSystemUserRule, parseRules, scoreRules } from "../plugins/ctx/lib/analyzer.js";
import { findEmbeddingRelevantFiles, findIndexedFileTextMatches } from "../plugins/ctx/lib/file-embedding-retriever.js";
import { expandImportGraph, rebuildImportGraphIndex } from "../plugins/ctx/lib/import-graph.js";
import { buildGraphQueries, findGraphRelevantFiles, mergeRelevantFiles } from "../plugins/ctx/lib/graph-retriever.js";
import { loadRuntimeEvidence } from "../plugins/ctx/lib/telemetry.js";

describe("analyzer", () => {
  it("parses markdown rules with source attribution", () => {
    const rules = parseRules(`## Source: /repo/AGENTS.md
# Backend
- Always use zod for validation.
1. Never commit console.log.

Plain paragraph with enough content to become a standalone rule.
`);

    expect(rules).toHaveLength(4);
    expect(rules[0]).toMatchObject({
      sourcePath: "/repo/AGENTS.md",
      content: "Backend"
    });
    expect(rules[1].content).toBe("Always use zod for validation.");
    expect(filterActionableRules(rules).map((rule) => rule.content)).not.toContain("Backend");
  });

  it("scores auth rules above styling rules for auth tasks", () => {
    const rules = parseRules(`## Source: /repo/AGENTS.md
- Always use auth guards for login endpoints.
- Prefer CSS modules for styling.
`);
    const scored = scoreRules(rules, "Recheck authen flow", []);

    expect(scored[0].content).toContain("auth guards");
    expect(scored[0].score).toBeGreaterThan(0.5);
    expect(scored.at(-1).content).toContain("CSS modules");
    expect(scored.at(-1).score).toBeLessThan(0.5);
  });

  it("filters system-user shell rules before scheduling", () => {
    const rules = parseRules(`## Source: /repo/AGENTS.md
- All shell commands MUST run as minh_dev, not root.
- Do not prefix every command with sudo -u minh_dev.
- First run sudo su - minh_dev before doing project work.
- @/home/example/.codex/RTK.md
- Always use zod for validation.
`);

    expect(rules).toHaveLength(5);
    expect(isSystemUserRule("sudo -i -u minh_dev")).toBe(true);
    expect(filterActionableRules(rules).map((rule) => rule.content)).toEqual([
      "Always use zod for validation."
    ]);
  });

  it("filters documentation-only headings and tool reference tables", () => {
    const rules = parseRules(`## Source: /repo/AGENTS.md
# MCP Tools: code-review-graph
- <!-- code-review-graph MCP tools -->
- Key Tools
- Workflow
- | Tool | Use when | |------|----------| | \`detect_changes\` | Reviewing code changes | | \`query_graph\` | Tracing relationships |
- Use \`detect_changes\` for code review.
- **Exploring code**: \`semantic_search_nodes\` or \`query_graph\` instead of Grep
`);

    expect(isDocumentationOnlyRule("MCP Tools: code-review-graph")).toBe(true);
    expect(isDocumentationOnlyRule("Use `detect_changes` for code review.")).toBe(false);
    expect(filterActionableRules(rules).map((rule) => rule.content)).toEqual([
      "Use `detect_changes` for code review.",
      "**Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep"
    ]);
  });

  it("does not fall back to filename heuristics when embeddings are unavailable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-files-"));
    fs.mkdirSync(path.join(tmp, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "auth", "login.ts"), "");
    fs.writeFileSync(path.join(tmp, "src", "style.css"), "");
    fs.writeFileSync(path.join(tmp, "node_modules", "auth", "ignored.ts"), "");

    const files = await findRelevantFiles({
      cwd: tmp,
      task: "Recheck authen flow",
      limit: 3,
      embeddingFileFinder: async () => []
    });

    expect(files).toEqual([]);
  });

  it("queries the persisted file embedding index without walking source files", async () => {
    const missingCwd = path.join(os.tmpdir(), "ctx-no-source-tree", String(Date.now()));
    const files = await findEmbeddingRelevantFiles({
      cwd: missingCwd,
      task: "kiem duyet",
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-file-index-")),
      indexedSearcher: async ({ kind, task, timeoutMs }) => {
        expect(kind).toBe(`file:${path.resolve(missingCwd)}`);
        expect(task).toBe("kiem duyet");
        expect(timeoutMs).toBe(1000);
        return {
          status: "enabled",
          items: [
            { id: "src/content-moderation.service.ts", embeddingScore: 0.82 },
            { id: "src/profile.service.ts", embeddingScore: 0.2 }
          ]
        };
      }
    });

    expect(files).toEqual([
      {
        path: "src/content-moderation.service.ts",
        score: 8,
        source: "embedding",
        reasons: ["file-embedding:0.82"]
      }
    ]);
  });

  it("uses indexed file text matches when hook fallback disables embeddings", async () => {
    const cwd = path.join(os.tmpdir(), "ctx-indexed-text-files");
    const files = await findRelevantFiles({
      cwd,
      task: "create forum page with new topic, trending, and chatting everyone",
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-indexed-text-data-")),
      limit: 3,
      fileEmbeddingOptions: { enabled: false },
      embeddingFileFinder: async () => [],
      indexedFileTextFinder: async () => [
        {
          path: path.join("webapp", "src", "app", "forum", "page.tsx"),
          score: 12,
          source: "indexed-file-text",
          reasons: ["indexed-file-text:forum,page,topic"]
        },
        {
          path: path.join("webapp", "src", "components", "chat", "chat-panel.tsx"),
          score: 8,
          source: "indexed-file-text",
          reasons: ["indexed-file-text:chat"]
        }
      ]
    });

    expect(files.map((file) => file.path)).toEqual([
      path.join("webapp", "src", "app", "forum", "page.tsx"),
      path.join("webapp", "src", "components", "chat", "chat-panel.tsx")
    ]);
  });

  it("can list text matches from an existing embedding index without loading embeddings", async () => {
    const cwd = path.join(os.tmpdir(), "ctx-indexed-lister-files");
    const files = await findIndexedFileTextMatches({
      cwd,
      task: "create forum chat page",
      dataDir: "unused",
      indexedLister: async ({ kind }) => {
        expect(kind).toBe(`file:${path.resolve(cwd)}`);
        return {
          status: "enabled",
          items: [
            { id: path.join("webapp", "src", "app", "forum", "page.tsx"), text: "forum topic trending chat page" },
            { id: path.join("webapp", "src", "app", "settings", "page.tsx"), text: "settings profile" }
          ]
        };
      }
    });

    expect(files.map((file) => file.path)).toEqual([
      path.join("webapp", "src", "app", "forum", "page.tsx")
    ]);
  });

  it("uses embedding file candidates for Vietnamese moderation terms", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-semantic-files-"));
    fs.mkdirSync(path.join(tmp, "services", "content-service", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "services", "upload-service", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "services", "content-service", "src", "content-moderation.service.ts"), "");
    fs.writeFileSync(path.join(tmp, "services", "upload-service", "src", "confirm-resource-upload.handler.ts"), "");
    fs.writeFileSync(path.join(tmp, "services", "content-service", "src", "profile.service.ts"), "");

    const files = await findRelevantFiles({
      cwd: tmp,
      task: "kiem duyet upload",
      limit: 3,
      embeddingFileFinder: async () => [
        {
          path: path.join("services", "content-service", "src", "content-moderation.service.ts"),
          score: 7,
          source: "embedding",
          reasons: ["file-embedding:0.70"]
        },
        {
          path: path.join("services", "upload-service", "src", "confirm-resource-upload.handler.ts"),
          score: 6,
          source: "embedding",
          reasons: ["file-embedding:0.60"]
        }
      ]
    });

    expect(files[0].path).toBe(path.join("services", "content-service", "src", "content-moderation.service.ts"));
    expect(files.map((file) => file.path)).toContain(path.join("services", "upload-service", "src", "confirm-resource-upload.handler.ts"));
  });

  it("suggests explicit prompt paths without walking source files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-explicit-files-"));
    fs.mkdirSync(path.join(tmp, "webapp", "src", "app", "(private)", "dashboard"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "webapp", "src", "app", "(private)", "home", "tutorials", "create"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "webapp", "src", "app", "(private)", "home", "resources", "create"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "webapp", "src", "app", "(private)", "dashboard", "page.tsx"), "");
    fs.writeFileSync(path.join(tmp, "webapp", "src", "app", "(private)", "home", "tutorials", "create", "page.tsx"), "");
    fs.writeFileSync(path.join(tmp, "webapp", "src", "app", "(private)", "home", "resources", "create", "page.tsx"), "");

    const task = "triển khai giao diện webapp/src/app/(private)/dashboard và webapp/src/app/(private)/home/tutorials/create, webapp/src/app/(private)/home/resources/ create";
    expect(findExplicitPromptFiles({ cwd: tmp, task }).map((file) => file.path)).toEqual([
      path.join("webapp", "src", "app", "(private)", "dashboard", "page.tsx"),
      path.join("webapp", "src", "app", "(private)", "home", "tutorials", "create", "page.tsx"),
      path.join("webapp", "src", "app", "(private)", "home", "resources", "create", "page.tsx")
    ]);

    const files = await findRelevantFiles({
      cwd: tmp,
      task,
      limit: 3,
      embeddingFileFinder: async () => []
    });

    expect(files.map((file) => file.path)).toEqual([
      path.join("webapp", "src", "app", "(private)", "dashboard", "page.tsx"),
      path.join("webapp", "src", "app", "(private)", "home", "tutorials", "create", "page.tsx"),
      path.join("webapp", "src", "app", "(private)", "home", "resources", "create", "page.tsx")
    ]);
    expect(files.every((file) => file.source === "prompt-path")).toBe(true);
  });

  it("resolves explicit src paths through monorepo package roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-explicit-monorepo-files-"));
    fs.mkdirSync(path.join(tmp, "services", "src", "__tests__"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      workspaces: ["services"]
    }));
    fs.writeFileSync(path.join(tmp, "services", "package.json"), "{}");
    fs.writeFileSync(path.join(tmp, "services", "src", "__tests__", "ai-chat.e2e.test.ts"), "");

    const task = "fix jest error in src/__tests__/ai-chat.e2e.test.ts(12,21)";

    expect(findExplicitPromptFiles({ cwd: tmp, task }).map((file) => file.path)).toEqual([
      path.join("services", "src", "__tests__", "ai-chat.e2e.test.ts")
    ]);
  });

  it("pins explicit controller paths and expands booking module neighbors", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-booking-endpoint-files-"));
    const bookingRoot = path.join(tmp, "edura-api", "src", "modules", "booking");
    fs.mkdirSync(path.join(bookingRoot, "presentation", "controllers"), { recursive: true });
    fs.mkdirSync(path.join(bookingRoot, "application", "services"), { recursive: true });
    fs.mkdirSync(path.join(bookingRoot, "presentation", "dto"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "edura-api", "src", "modules", "grade", "presentation", "controllers"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "edura-api", "prisma"), { recursive: true });
    fs.writeFileSync(path.join(bookingRoot, "presentation", "controllers", "booking.controller.ts"), "");
    fs.writeFileSync(path.join(bookingRoot, "application", "services", "booking.service.ts"), "");
    fs.writeFileSync(path.join(bookingRoot, "booking.module.ts"), "");
    fs.writeFileSync(path.join(bookingRoot, "presentation", "dto", "reschedule-approve.dto.ts"), "");
    fs.writeFileSync(path.join(tmp, "edura-api", "src", "modules", "grade", "presentation", "controllers", "grade.controller.ts"), "");
    fs.writeFileSync(path.join(tmp, "edura-api", "prisma", "schema.prisma"), "");

    const task = [
      "Implement PATCH /api/sessions/:sessionId/reschedule/approve in",
      "edura-api/src/modules/booking/presentation/controllers/booking.controller.ts",
      "Set proposedStartTime => startTime, proposedEndTime => endTime, status SCHEDULED."
    ].join(" ");
    const files = await findRelevantFiles({
      cwd: tmp,
      task,
      limit: 5,
      embeddingFileFinder: async () => [
        {
          path: path.join("edura-api", "src", "modules", "grade", "presentation", "controllers", "grade.controller.ts"),
          score: 90,
          source: "embedding",
          reasons: ["file-embedding:0.99"]
        }
      ]
    });

    expect(files[0]).toMatchObject({
      path: path.join("edura-api", "src", "modules", "booking", "presentation", "controllers", "booking.controller.ts")
    });
    expect(files[0].reasons).toContain("explicit-path-mentioned");
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
      path.join("edura-api", "src", "modules", "booking", "application", "services", "booking.service.ts"),
      path.join("edura-api", "src", "modules", "booking", "booking.module.ts"),
      path.join("edura-api", "prisma", "schema.prisma")
    ]));
    const gradeIndex = files.findIndex((file) => file.path.endsWith("grade.controller.ts"));
    expect(gradeIndex === -1 || files.findIndex((file) => file.path.endsWith("booking.controller.ts")) < gradeIndex).toBe(true);
  });

  it("suggests package manifests for monorepo run and connect prompts", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-manifest-files-"));
    fs.mkdirSync(path.join(tmp, "webapp"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "libs", "shared"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      workspaces: ["webapp", "libs/*"],
      scripts: { "frontend:dev": "npm run start -w webapp" }
    }));
    fs.writeFileSync(path.join(tmp, "webapp", "package.json"), JSON.stringify({
      scripts: { start: "expo start" },
      dependencies: { expo: "^56.0.0" }
    }));
    fs.writeFileSync(path.join(tmp, "libs", "shared", "package.json"), JSON.stringify({
      dependencies: { zod: "^4.0.0" }
    }));

    const task = "why run can not show QR or something to connect webapp";
    expect(findProjectManifestFiles({ cwd: tmp, task }).map((file) => file.path)).toEqual([
      "package.json",
      path.join("webapp", "package.json"),
      path.join("libs", "shared", "package.json")
    ]);

    const files = await findRelevantFiles({
      cwd: tmp,
      task,
      limit: 3,
      embeddingFileFinder: async () => [
        { path: "webapp/app.config.js", score: 7, source: "embedding", reasons: ["file-embedding:0.70"] }
      ]
    });

    expect(files.map((file) => file.path)).toEqual([
      "package.json",
      path.join("webapp", "package.json"),
      path.join("libs", "shared", "package.json")
    ]);
  });

  it("expands purchase flow prompts before querying the file embedding index", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-purchase-files-"));
    const observedTasks = [];

    const files = await findRelevantFiles({
      cwd: tmp,
      task: "Implement purchase flow. Check wallet balance, continue checkout, grant access permissions through content-access-service, update /library, send notifications.",
      limit: 3,
      embeddingFileFinder: async ({ task }) => {
        observedTasks.push(task);
        return [
          {
            path: path.join("services", "billing-service", "src", "presentation", "http", "controllers", "billing.controller.ts"),
            score: 7,
            source: "embedding",
            reasons: ["file-embedding:0.70"]
          },
          {
            path: path.join("services", "content-access-service", "src", "presentation", "http", "controllers", "content-access.controller.ts"),
            score: 6,
            source: "embedding",
            reasons: ["file-embedding:0.62"]
          },
          {
            path: path.join("services", "notification-service", "src", "notification.service.ts"),
            score: 6,
            source: "embedding",
            reasons: ["file-embedding:0.61"]
          }
        ];
      }
    });

    expect(observedTasks[0]).toContain("BackendGuard retrieval hints");
    expect(observedTasks[0]).toContain("wallet");
    expect(observedTasks[0]).toContain("content-access-service");
    expect(observedTasks[0]).toContain("notification");
    expect(files.map((file) => file.path)).toEqual([
      path.join("services", "billing-service", "src", "presentation", "http", "controllers", "billing.controller.ts"),
      path.join("services", "content-access-service", "src", "presentation", "http", "controllers", "content-access.controller.ts"),
      path.join("services", "notification-service", "src", "notification.service.ts")
    ]);
  });

  it("boosts files connected by relative imports", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-import-files-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-import-index-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "upload.ts"), "export const uploadService = {};\n");
    fs.writeFileSync(path.join(tmp, "src", "consumer.ts"), "import { uploadService } from './upload';\n");
    rebuildImportGraphIndex({ cwd: tmp, dataDir, files: ["src/upload.ts", "src/consumer.ts"] });

    const files = await findRelevantFiles({
      cwd: tmp,
      dataDir,
      task: "fix upload",
      limit: 3,
      embeddingFileFinder: async () => [
        {
          path: path.join("src", "upload.ts"),
          score: 7,
          source: "embedding",
          reasons: ["file-embedding:0.70"]
        }
      ]
    });

    expect(files.map((file) => file.path)).toContain(path.join("src", "consumer.ts"));
    expect(files.find((file) => file.path === path.join("src", "consumer.ts")).source).toBe("import-graph");
  });

  it("expands persisted import adjacency without reading the source tree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-import-persisted-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-import-persisted-index-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "upload.ts"), "export const upload = true;\n");
    fs.writeFileSync(path.join(tmp, "src", "consumer.ts"), "import { upload } from './upload';\n");
    rebuildImportGraphIndex({ cwd: tmp, dataDir, files: ["src/upload.ts", "src/consumer.ts"] });
    fs.rmSync(path.join(tmp, "src"), { recursive: true });

    expect(expandImportGraph({
      cwd: tmp,
      dataDir,
      seedFiles: [{ path: "src/upload.ts" }]
    })).toEqual([
      {
        path: "src/consumer.ts",
        score: 5,
        source: "import-graph",
        reasons: ["imported-by:src/upload.ts"]
      }
    ]);
  });

  it("uses embedding file candidates before import graph expansion", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-file-embedding-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-file-import-index-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "content-moderation.service.ts"), "export const moderation = true;\n");
    fs.writeFileSync(path.join(tmp, "src", "consumer.ts"), "import { moderation } from './content-moderation.service';\n");
    rebuildImportGraphIndex({ cwd: tmp, dataDir, files: ["src/content-moderation.service.ts", "src/consumer.ts"] });

    const files = await findRelevantFiles({
      cwd: tmp,
      dataDir,
      task: "kiem duyet",
      limit: 3,
      embeddingFileFinder: async () => [
        {
          path: path.join("src", "content-moderation.service.ts"),
          score: 7,
          source: "embedding",
          reasons: ["file-embedding:0.70"]
        }
      ]
    });

    expect(files[0]).toMatchObject({
      path: path.join("src", "content-moderation.service.ts"),
      source: "embedding"
    });
    expect(files.map((file) => file.path)).toContain(path.join("src", "consumer.ts"));
  });

  it("scores English moderation rules for Vietnamese moderation prompts", () => {
    const rules = parseRules(`## Source: /repo/AGENTS.md
- Always run content moderation before approving uploaded resources.
- Prefer CSS modules for styling.
`);
    const scored = scoreRules(rules, "kiem duyet upload", []);

    expect(scored[0].content).toContain("content moderation");
    expect(scored[0].score).toBeGreaterThan(0.5);
  });

  it("builds graph retrieval queries from scored project rules", () => {
    const queries = buildGraphQueries({
      task: "kiem duyet upload",
      seedFiles: [
        {
          path: path.join("services", "content-service", "src", "content-moderation.service.ts")
        }
      ],
      rules: [
        {
          content: "Always run content moderation before approving uploaded resources.",
          score: 0.8
        }
      ]
    });

    expect(queries).toContain("kiem duyet upload");
    expect(queries).toContain("content-moderation.service");
    expect(
      buildGraphQueries({
        task: "kiem duyet upload",
        rules: [
          {
            content: "Always run content moderation before approving uploaded resources.",
            score: 0.8
          }
        ]
      })
    ).toContain("content moderation");
  });

  it("prefers graph file matches over heuristic file matches", () => {
    const files = mergeRelevantFiles({
      graphFiles: [
        {
          path: path.join("src", "content-moderation.service.ts"),
          score: 2,
          reasons: ["graph:content moderation"]
        }
      ],
      heuristicFiles: [
        {
          path: path.join("src", "upload.service.ts"),
          score: 8,
          reasons: ["upload"]
        }
      ],
      limit: 2
    });

    expect(files[0]).toMatchObject({
      path: path.join("src", "content-moderation.service.ts"),
      source: "graph"
    });
  });

  it("records direct graph retrieval as runtime telemetry", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-graph-retrieval-"));
    const telemetryPath = path.join(cwd, "telemetry.jsonl");
    fs.mkdirSync(path.join(cwd, ".code-review-graph"));
    fs.writeFileSync(path.join(cwd, ".code-review-graph", "graph.db"), "");

    const files = findGraphRelevantFiles({
      cwd,
      task: "kiem duyet",
      python: process.execPath,
      telemetryPath,
      graphSearch: () => [{ path: "src/moderation.js", query: "kiem duyet" }]
    });
    const evidence = loadRuntimeEvidence({ telemetryPath, cwd });

    expect(files[0]).toMatchObject({ path: "src/moderation.js", source: "graph" });
    expect(evidence.signals).toContain("code-review-graph");
    expect(evidence.toolSignals).toContain("code-review-graph.semantic_search_nodes");
    expect(evidence.sources[0].event).toBe("InternalGraphRetrieval");
  });

  it("audits failed graph retrieval without claiming compliance evidence", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-graph-retrieval-error-"));
    const telemetryPath = path.join(cwd, "telemetry.jsonl");
    fs.mkdirSync(path.join(cwd, ".code-review-graph"));
    fs.writeFileSync(path.join(cwd, ".code-review-graph", "graph.db"), "");

    expect(findGraphRelevantFiles({
      cwd,
      task: "kiem duyet",
      python: process.execPath,
      telemetryPath,
      graphSearch: () => {
        throw new Error("timeout");
      }
    })).toEqual([]);

    const [event] = fs.readFileSync(telemetryPath, "utf8").trim().split("\n").map(JSON.parse);
    expect(event).toMatchObject({
      event: "InternalGraphRetrieval",
      backend: "code-review-graph",
      status: "error"
    });
    expect(event.signals).toEqual([]);
    expect(event.toolSignals).toEqual([]);
  });
});
