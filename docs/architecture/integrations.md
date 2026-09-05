# AI Agent Integrations

BackendGuard supports four AI coding agents: Codex, Claude Code, Antigravity, and GitHub Copilot. Each integration is responsible for two things — getting context *into* the agent before a task, and getting the compliance report data *out* after one — using whatever hook/MCP mechanism that agent actually exposes. Those mechanisms differ per agent, which is why each integration is a self-contained module rather than a shared abstraction pretending they're the same.

## Layout

```text
plugins/backendguard/
├── bin/                              hook entrypoints invoked directly by each agent's hook runner
│   ├── on-prompt.js                  UserPromptSubmit (Codex, Claude Code)
│   ├── on-stop.js                    Stop (Codex, Claude Code)
│   ├── on-session-start.js           SessionStart (Codex)
│   ├── on-antigravity-preinvocation.js   PreInvocation (Antigravity)
│   └── on-antigravity-stop.js        Stop (Antigravity)
│
├── integrations/
│   ├── claude/
│   │   ├── claude-hooks.js           installClaudeHooks() — merges hooks into ~/.claude/settings.json
│   │   └── claude-mcp.js             installClaudeMcp() — registers backendguard-mcp in ~/.claude.json
│   ├── antigravity/
│   │   ├── antigravity-hooks.js      installAntigravityHooks() — writes ~/.gemini/config/hooks.json
│   │   ├── antigravity-mcp.js        installAntigravityMcp() — registers backendguard-mcp in Antigravity MCP config paths
│   │   └── antigravity-adapter.js    antigravityCwd(), extractPromptFromAntigravityPayload() — payload shape adapter shared by the two on-antigravity-*.js hook entrypoints
│   └── copilot/
│       ├── copilot-hooks.js          installCopilotHooks()
│       └── copilot-mcp.js            installCopilotMcp()
│
├── mcp/
│   ├── server.js                     backendguard-mcp stdio entrypoint + private Unix-socket hook bridge + embedding model warmup
│   ├── backendguard-server.js        MCP tool registrations (ctx_health, ctx_detect_stack, ctx_score_context, ctx_analyze_changes, ...)
│   └── proxy.js                      transparent stdio proxy wrapping other configured MCP servers so their tool calls can be measured as compliance evidence
│
└── .codex-plugin/plugin.json         Codex plugin manifest — Codex is the primary/native integration, not a separate integrations/codex/ module (see below)
```

## Why Codex doesn't have its own `integrations/codex/`

Codex is the plugin host BackendGuard was originally built against: `plugins/backendguard/` *is* the Codex plugin (declared by `.codex-plugin/plugin.json` and `hooks.json`), and `plugins/backendguard/bin/on-prompt.js`/`plugins/backendguard/bin/on-stop.js`/`plugins/backendguard/bin/on-session-start.js` are its hook entrypoints directly. There's no separate "Codex adapter" to extract because the plugin's native shape already *is* the Codex integration. Claude Code, Antigravity, and Copilot are each retrofitted on top — they get their own hooks/MCP config written into their respective config directories by the installers in `integrations/`, which is why those three have dedicated modules and Codex doesn't.

## The MCP server (`backendguard-mcp`)

`integrations/mcp/server.js` is a long-running process (started by whichever agent's MCP client launches it) that keeps the embedding model hot and serves two roles:

1. **MCP tool server** — the tools registered in `backendguard-server.js`, callable by any agent that supports MCP tool calls directly (see the README's [Detailed Install](../../README.md#detailed-install) section for the current tool list).
2. **Private hook bridge** — a Unix socket (`backendguard-mcp.sock`) that Codex/Claude Code prompt hooks call into for fast, already-warm scoring, so the hook process itself never has to cold-load the embedding model. `backendguard-mcp-client.js` is the client side of this bridge.

## Adding a new agent

1. Create `integrations/<agent>/`.
2. Write `<agent>-hooks.js`: an `install<Agent>Hooks()` function that merges BackendGuard's hook commands into wherever that agent reads its hook config, following the shape of `claude-hooks.js` (simplest) or `antigravity-hooks.js` (if the agent's hook payload shape needs its own adapter, add a `<agent>-adapter.js` alongside it, as Antigravity does).
3. Write `<agent>-mcp.js`: an `install<Agent>Mcp()` function that registers `backendguard-mcp` in that agent's MCP config file(s).
4. If the agent's hook payload doesn't include `cwd` directly, extend `agent-context/hook-io.js` — `resolveHookCwd()` — with that agent's payload shape, following the existing `CLAUDE_PROJECT_DIR` / Antigravity `workspacePath` handling.
5. Wire both installers into `cli/backendguard.js`'s `install`/`setup` command handling, and add the agent name to `SUPPORTED_AGENTS`.
6. Add coverage in `tests/agent-hooks.test.js` following the existing Claude/Antigravity test blocks.

No change to `` (rule engine, compliance engine, stack detection) is needed to add an agent — that's the actual payoff of keeping integrations isolated: `scoreContext()`, `checkCompliance()`, and everything in [rule-engine.md](rule-engine.md)/[compliance-engine.md](compliance-engine.md) is agent-agnostic and already shared by all four.
