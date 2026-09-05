import { describe, expect, it } from "vitest";

import { buildGlobalHooksConfig } from "../integrations/codex/codex-hooks.js";

describe("global hooks installer", () => {
  it("preserves existing hooks and installs BackendGuard hooks idempotently", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [{ type: "command", command: "code-review-graph status" }]
          },
          {
            matcher: "startup|resume",
            hooks: [{ type: "command", command: "node '/home/deploy_user/.codex/marketplaces/backendguard/plugins/backendguard/bin/on-session-start.js'" }]
          }
        ],
        PostToolUse: [
          {
            matcher: "Write|Edit|Bash",
            hooks: [{ type: "command", command: "code-review-graph update --skip-flows" }]
          }
        ]
      }
    };

    const once = buildGlobalHooksConfig(existing, {
      marketplaceRoot: "/home/deploy_user/.codex/marketplaces/backendguard"
    });
    const twice = buildGlobalHooksConfig(once, {
      marketplaceRoot: "/home/deploy_user/.codex/marketplaces/backendguard"
    });

    expect(twice.hooks.PostToolUse).toHaveLength(1);
    expect(twice.hooks.PostToolUse[0].hooks[0].command).toContain("cat >/dev/null");
    expect(twice.hooks.SessionStart).toHaveLength(2);
    expect(twice.hooks.UserPromptSubmit).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
    expect(twice.hooks.SessionStart[0].hooks[0].command).toContain("code-review-graph status >/dev/null");
    expect(twice.hooks.UserPromptSubmit[0].hooks[0].command).not.toContain("BACKENDGUARD_INJECT=0");
    expect(JSON.stringify(twice).match(/plugins\/backendguard\/bin\/on-prompt\.js/g)).toHaveLength(1);
    expect(JSON.stringify(twice).match(/plugins\/backendguard\/bin\/on-session-start\.js/g)).toHaveLength(1);
  });

  it("can disable visible prompt context injection", () => {
    const config = buildGlobalHooksConfig({}, {
      marketplaceRoot: "/home/deploy_user/.codex/marketplaces/backendguard",
      injectPromptContext: false
    });

    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain("BACKENDGUARD_INJECT=0");
  });
});
