#!/usr/bin/env node
// Codex resolves MCP servers relative to the plugin directory (see ../.mcp.json),
// so the plugin keeps a thin entrypoint here; the implementation lives in the
// integrations domain and is shared by every agent.
import "../../../integrations/mcp/server.js";
