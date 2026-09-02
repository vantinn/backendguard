import { describe, expect, it } from "vitest";

import { defaultOutputConfig } from "../plugins/ctx/lib/output-config.js";
import { scheduleContext } from "../plugins/ctx/lib/scheduler.js";

describe("scheduler", () => {
  it("puts high-score rules at the beginning", () => {
    const scheduled = scheduleContext({
      rules: [
        { id: "r1", content: "Always use zod for validation.", sourcePath: "/repo/AGENTS.md", score: 0.9 },
        { id: "r2", content: "Prefer compact CSS.", sourcePath: "/repo/AGENTS.md", score: 0.2 },
        { id: "r3", content: "Unrelated deployment note.", sourcePath: "/repo/AGENTS.md", score: 0 }
      ],
      relevantFiles: [{ path: "src/auth/login.ts" }],
      suggestedSkills: [
        { name: "zod-validator", description: "Use for validation tasks.", path: ".codex/skills/zod-validator/SKILL.md", confidence: 0.9 },
        { name: "zod-validator", description: "Duplicate catalog entry.", path: ".claude/skills/zod-validator/SKILL.md", confidence: 0.8 }
      ],
      suggestedWorkflows: [{
        name: "primary-workflow",
        title: "Primary Workflow",
        hint: "use for feature implementation, testing, review, and debugging",
        chain: ["planner", "tester", "code-reviewer"],
        relativePath: ".claude/workflows/primary-workflow.md",
        score: 0.8
      }],
      outputConfig: defaultOutputConfig()
    });

    expect(scheduled.highRules).toHaveLength(1);
    expect(scheduled.midRules).toHaveLength(1);
    expect(scheduled.droppedRules).toHaveLength(1);
    expect(scheduled.additionalContext).toContain("## Critical BackendGuard rules");
    // Rules should appear once (no duplicate "reminders" section)
    expect(scheduled.additionalContext.match(/Always use zod/g)).toHaveLength(1);
    // No absolute paths in rule output
    expect(scheduled.additionalContext).not.toContain("/repo/AGENTS.md");
    expect(scheduled.additionalContext).toContain("## Suggested files to check (1 auto:");
    expect(scheduled.additionalContext).not.toContain("src/auth/login.ts");
    expect(scheduled.additionalContext).toContain("## Suggested skills for this task (2 auto: confidence elbow): zod-validator");
    expect(scheduled.additionalContext.match(/zod-validator/g)).toHaveLength(1);
    expect(scheduled.additionalContext).not.toContain("Use for validation tasks.");
    // No absolute paths in skill output
    expect(scheduled.additionalContext).not.toContain(".codex/skills/");
    expect(scheduled.additionalContext).toContain("## Suggested workflow for this task");
    expect(scheduled.additionalContext).toContain("Primary Workflow");
    expect(scheduled.additionalContext).toContain("planner -> tester -> code-reviewer");
    expect(scheduled.additionalContext).not.toContain("use for feature implementation");
    // No "see: …" path in workflow output
    expect(scheduled.additionalContext).not.toContain("see:");
  });

  it("trims output to max chars", () => {
    const scheduled = scheduleContext({
      rules: [{ id: "r1", content: "Always " + "very ".repeat(100), score: 1 }],
      maxChars: 120,
      outputConfig: defaultOutputConfig()
    });

    expect(scheduled.additionalContext.length).toBeLessThanOrEqual(140);
    expect(scheduled.additionalContext).toContain("truncated");
  });

  it("only renders dollar-prefixed skills for explicit user-requested skills", () => {
    const scheduled = scheduleContext({
      suggestedSkills: [
        { name: "chat-widget", confidence: 0.95 },
        { name: "realtime-chat", explicit: true, confidence: 0.9 },
        { name: "$user-named-skill", confidence: 0.8 }
      ],
      outputConfig: defaultOutputConfig()
    });

    expect(scheduled.additionalContext).toBe("## Suggested skills for this task (3 auto: confidence elbow): chat-widget, $realtime-chat, $user-named-skill");
  });

  it("hides disabled prompt sections without dropping scheduled metadata", () => {
    const scheduled = scheduleContext({
      rules: [
        { content: "Always validate input.", score: 0.9 },
        { content: "Prefer compact helpers.", score: 0.2 }
      ],
      relevantFiles: [{ path: "src/input.ts" }],
      suggestedSkills: [{ name: "validation" }],
      suggestedWorkflows: [{ name: "review" }],
      outputConfig: {
        sections: {
          rules: false,
          files: true,
          skills: false,
          workflows: false
        }
      }
    });

    expect(scheduled.additionalContext).toBe("## Suggested files to check (1 auto: feature task, 1 bucket), input.ts");
    expect(scheduled.highRules).toHaveLength(1);
    expect(scheduled.midRules).toHaveLength(1);
    expect(scheduled.suggestedSkills).toHaveLength(1);
    expect(scheduled.suggestedWorkflows).toHaveLength(1);
  });

  it("keeps duplicate file basenames distinct with relative paths", () => {
    const scheduled = scheduleContext({
      relevantFiles: [
        { path: "webapp/src/app/(private)/dashboard/page.tsx" },
        { path: "webapp/src/app/(private)/home/tutorials/create/page.tsx" },
        { path: "webapp/src/app/(private)/dashboard/layout.tsx" }
      ],
      outputConfig: defaultOutputConfig()
    });

    expect(scheduled.additionalContext).toContain("webapp/src/app/(private)/dashboard/page.tsx");
    expect(scheduled.additionalContext).toContain("webapp/src/app/(private)/home/tutorials/create/page.tsx");
    expect(scheduled.additionalContext).toContain("layout.tsx");
  });
});
