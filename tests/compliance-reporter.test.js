import { describe, expect, it } from "vitest";

import { buildComplianceScorecard, buildComplianceSummary, formatComplianceScorecard, formatEvidence, formatReport, scoreDeduction } from "../compliance/compliance-reporter.js";

describe("reporter evidence", () => {
  it("formats detailed rule evidence in markdown", () => {
    const output = formatEvidence({
      prompt: "Recheck authen flow",
      efficiencyScore: 50,
      changedFiles: ["src/auth.ts"],
      warnings: ["diff partial"],
      followed: [
        {
          rule: { content: "Always use `zod`.", sourcePath: "AGENTS.md", score: 0.9 },
          kind: "required",
          keywords: ["zod"],
          evidence: "found required zod in src/auth.ts:1",
          matchedLines: [{ file: "src/auth.ts", line: 1, content: 'import { z } from "zod";' }]
        }
      ],
      ignored: [],
      unknown: [
        {
          rule: { content: "Use code-review-graph.", sourcePath: "AGENTS.md", score: 0.4 },
          evidence: "expected keyword not visible in diff"
        }
      ],
      unmeasurable: [
        {
          rule: { content: "Use runtime telemetry.", sourcePath: "AGENTS.md", score: 0.3 },
          evidence: "no runtime telemetry source observed"
        }
      ]
    });

    expect(output).toContain("BackendGuard Evidence");
    expect(output).toContain("Evidence Details");
    expect(output).toContain("FOLLOWED");
    expect(output).toContain("found required zod");
    expect(output).toContain("src/auth.ts:1");
    expect(output).toContain("UNKNOWN");
    expect(output).toContain("UNMEASURABLE");
    expect(output).toContain("0.40");
  });

  it("formats report in markdown with proper sections", () => {
    const output = formatReport({
      efficiencyScore: 0,
      injectedRuleCount: 1,
      changedFiles: ["src/auth.ts"],
      relevantFiles: [],
      suggestedSkills: [{ name: "debugger", description: "Debug specialist" }],
      suggestedWorkflows: [{ name: "TDD", chain: ["test", "code", "review"] }],
      followed: [],
      ignored: [
        {
          rule: {
            content: "Never use console.log in committed code."
          },
          evidence: "found forbidden console.log in src/auth.ts:42"
        }
      ],
      unknown: []
    });

    expect(output).toContain("# BackendGuard Report");
    expect(output).toContain("## Summary");
    expect(output).toContain("## Rule Outcomes");
    expect(output).toContain("## Suggested Skills");
    expect(output).toContain("**debugger**");
    expect(output).toContain("## Suggested Workflows");
    expect(output).toContain("**TDD**");
    expect(output).toContain("test → code → review");
    expect(output).toContain("Suggestion:");
  });

  it("shows all items without truncation", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      rule: { content: `Rule ${i + 1}` },
      evidence: `Evidence ${i + 1}`
    }));
    const output = formatReport({
      efficiencyScore: 100,
      injectedRuleCount: 10,
      changedFiles: [],
      relevantFiles: [],
      followed: items,
      ignored: [],
      unknown: []
    });

    // All 10 should appear, no "... N more"
    for (let i = 1; i <= 10; i++) {
      expect(output).toContain(`Rule ${i}`);
    }
    expect(output).not.toContain("more");
  });

  it("filters system-user rules from stale reports at format time", () => {
    const report = {
      efficiencyScore: 100,
      injectedRuleCount: 2,
      changedFiles: ["src/policy.ts"],
      relevantFiles: [],
      followed: [
        {
          rule: { content: "First, execute the command to switch the user context to `deploy_user`." },
          evidence: "found required user in src/policy.ts:1"
        }
      ],
      ignored: [],
      unknown: [
        {
          rule: { content: "Always use zod for validation." },
          evidence: "expected keywords not visible in added lines: zod"
        }
      ]
    };

    const summary = formatReport(report);
    const evidence = formatEvidence(report);

    expect(summary).toContain("Injected rules");
    expect(summary).toContain("Rule Outcomes");
    expect(summary).not.toContain("deploy_user");
    expect(evidence).not.toContain("switch the user context");
    expect(evidence).toContain("Always use zod");
  });
});

describe("backend engineering compliance summary", () => {
  it("classifies ignored rules into a security-severity category and flags it as a failure", () => {
    const report = {
      followed: [],
      ignored: [
        {
          rule: { content: "Never return the password hash field in an API response." },
          evidence: "found forbidden passwordHash in src/users/user.controller.ts:40"
        }
      ],
      unknown: []
    };

    const summary = buildComplianceSummary(report);
    const security = summary.categories.find((category) => category.name === "Security");
    expect(security.status).toBe("FAIL");
    expect(summary.issues[0].severity).toBe("HIGH");
    expect(summary.issues[0].category).toBe("Security");

    const rendered = formatReport({ ...report, efficiencyScore: 0, changedFiles: [], relevantFiles: [] });
    expect(rendered).toContain("Backend Engineering Compliance");
    expect(rendered).toContain("**Security:** FAIL");
  });

  it("marks categories with no measured rules as not evaluated instead of a false PASS", () => {
    const report = { followed: [], ignored: [], unknown: [] };
    const summary = buildComplianceSummary(report);
    expect(summary.categories.every((category) => category.status === "NOT_EVALUATED")).toBe(true);
    expect(formatReport({ ...report, efficiencyScore: null, changedFiles: [], relevantFiles: [] })).not.toContain("Backend Engineering Compliance");
  });

  it("classifies a followed database rule as PASS without raising an issue", () => {
    const report = {
      followed: [
        { rule: { content: "Add a composite index on (user_id, created_at) for this query." }, evidence: "found required index in src/orders/order.repository.ts:12" }
      ],
      ignored: [],
      unknown: []
    };
    const summary = buildComplianceSummary(report);
    const database = summary.categories.find((category) => category.name === "Database");
    expect(database.status).toBe("PASS");
    expect(summary.issues).toHaveLength(0);
  });
});

describe("compliance scorecard", () => {
  const report = {
    followed: [{ rule: { content: "Always write an integration test for a new endpoint." }, evidence: "src/a.spec.ts:1" }],
    ignored: [
      {
        rule: {
          id: "SEC-003", structural: true, category: "Security", severity: "HIGH", confidence: "certain",
          content: "Hardcoded secret literal. A signing key is committed.", remediation: "Read it from the environment."
        },
        evidence: "src/auth.module.ts:8"
      },
      {
        rule: {
          id: "TORM-001", structural: true, category: "Database", severity: "MEDIUM", confidence: "certain",
          content: "Unbounded repository read. find() has no pagination.", remediation: "Add take/skip."
        },
        evidence: "src/users.service.ts:18"
      }
    ],
    unknown: []
  };

  it("scores each category from its own findings, deterministically", () => {
    const first = buildComplianceScorecard(report);
    const second = buildComplianceScorecard(report);
    expect(first).toEqual(second);

    const security = first.categories.find((category) => category.name === "Security");
    // HIGH (25) x certain (1.0) = 25 points off.
    expect(security.score).toBe(75);
    expect(security.deductions[0]).toMatchObject({ id: "SEC-003", points: 25 });

    const database = first.categories.find((category) => category.name === "Database");
    // MEDIUM (10) x certain (1.0) = 10 points off.
    expect(database.score).toBe(90);
  });

  it("reports a category with nothing to measure as not evaluated, not as 100", () => {
    const scorecard = buildComplianceScorecard(report);
    const performance = scorecard.categories.find((category) => category.name === "Performance");
    expect(performance.score).toBeNull();
    expect(performance.status).toBe("NOT_EVALUATED");
    expect(scorecard.evaluatedCategories).not.toContain("Performance");
  });

  it("gives a clean category full marks", () => {
    const scorecard = buildComplianceScorecard(report);
    const testing = scorecard.categories.find((category) => category.name === "Testing");
    expect(testing.score).toBe(100);
  });

  it("weights a low-confidence finding less than a certain one", () => {
    const certain = scoreDeduction({ severity: "HIGH", confidence: "certain" });
    const low = scoreDeduction({ severity: "HIGH", confidence: "low" });
    expect(certain).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
  });

  it("never goes below zero", () => {
    const many = {
      followed: [],
      unknown: [],
      ignored: Array.from({ length: 20 }, (_, index) => ({
        rule: {
          id: `SEC-00${index}`, structural: true, category: "Security", severity: "CRITICAL", confidence: "certain",
          content: "Hardcoded secret literal.", remediation: "fix"
        },
        evidence: `src/a${index}.ts:1`
      }))
    };
    expect(buildComplianceScorecard(many).categories.find((c) => c.name === "Security").score).toBe(0);
  });

  it("prints the formula so a score can be checked by hand", () => {
    const text = formatComplianceScorecard(report);
    expect(text).toContain("Formula:");
    expect(text).toContain("SEC-003");
    expect(text).toContain("-25");
  });
});
