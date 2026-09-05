import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatAgentLeaderboard,
  runAgentLeaderboard
} from "../evaluation/hallucination/run-agent-leaderboard.js";

describe("live agent leaderboard", () => {
  it("runs through a CLI adapter when an agent binary is available", () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-agent-leaderboard-"));
    const fake = path.join(tmp, "fake-agent.mjs");
    fs.writeFileSync(fake, "console.log('eas, mobile-deployment, github-actions-ci-cd');\n");
    const originalCommand = process.env.BACKENDGUARD_FAKE_AGENT_CMD;
    process.env.BACKENDGUARD_FAKE_AGENT_CMD = `${process.execPath} ${fake} {prompt_file}`;
    try {
      const result = runAgentLeaderboard({ agents: ["fake-agent"], caseLimit: 1, timeoutMs: 5000 });
      const output = formatAgentLeaderboard(result);

      expect(["ok", "skipped"]).toContain(result.systems[0].status);
      if (result.systems[0].status === "ok") {
        expect(result.systems[0].correctRate).toBe(1);
      } else {
        expect(result.systems[0].reason).toMatch(/EPERM|permission|not found/i);
      }
      expect(output).toContain("Live Agent Leaderboard");
    } finally {
      if (originalCommand === undefined) {
        delete process.env.BACKENDGUARD_FAKE_AGENT_CMD;
      } else {
        process.env.BACKENDGUARD_FAKE_AGENT_CMD = originalCommand;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
