import fs from "node:fs";
import path from "node:path";

/**
 * Copilot reads instructions from:
 *   1. .github/copilot-instructions.md (repo-level)
 *   2. AGENTS.md files (nearest in directory tree)
 *
 * Since BackendGuard already syncs AGENTS.md through Ruler,
 * this module writes a copilot-instructions.md that signals
 * BackendGuard integration and points Copilot at the backendguard-mcp MCP server.
 */

const MARKER = "<!-- managed by BackendGuard -->";

function buildCopilotInstructions({ installRoot } = {}) {
  return [
    MARKER,
    "# BackendGuard Integration",
    "",
    "This project uses [BackendGuard](https://github.com/vantinn/backendguard) for task-aware context injection.",
    "",
    "## MCP Server",
    "",
    "The `backendguard-mcp` MCP server is configured in `.vscode/mcp.json`.",
    "It provides semantic file search, skill discovery, and rule scoring for this workspace.",
    "",
    "## Rules",
    "",
    "Project rules are defined in `AGENTS.md` files managed by Ruler.",
    "These rules are automatically injected into your prompt context.",
    ""
  ].join("\n");
}

export function copilotInstructionsPath(cwd = process.cwd()) {
  return path.join(cwd, ".github", "copilot-instructions.md");
}

export function installCopilotHooks({ cwd = process.cwd(), installRoot } = {}) {
  const instructionsPath = copilotInstructionsPath(cwd);
  const dir = path.dirname(instructionsPath);
  fs.mkdirSync(dir, { recursive: true });

  // If the file exists and wasn't created by us, don't overwrite
  if (fs.existsSync(instructionsPath)) {
    const existing = fs.readFileSync(instructionsPath, "utf8");
    if (!existing.includes(MARKER)) {
      // Append our section
      const content = existing.trimEnd() + "\n\n" + buildCopilotInstructions({ installRoot });
      fs.writeFileSync(instructionsPath, content, "utf8");
      return instructionsPath;
    }
  }

  fs.writeFileSync(instructionsPath, buildCopilotInstructions({ installRoot }), "utf8");
  return instructionsPath;
}
