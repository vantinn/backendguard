# BackendGuard Documentation

## Architecture

| Document | What it covers |
| --- | --- |
| [overview.md](architecture/overview.md) | The domain map: every concept, the file that owns it, and the end-to-end flows. Start here. |
| [analysis.md](architecture/analysis.md) | The static analyzers, the registry, the finding shape, and how to add a check or a whole analyzer. |
| [rule-engine.md](architecture/rule-engine.md) | Parsing `AGENTS.md`, scoring rules against a task, rule packs, and retrieval. |
| [compliance-engine.md](architecture/compliance-engine.md) | Diff compliance, report building, and deterministic category scoring. |
| [integrations.md](architecture/integrations.md) | Codex, Claude Code, Antigravity, Copilot, and the MCP server. |
| [refactor-audit.md](architecture/refactor-audit.md) | The 0.9.0 reorganisation: what every directory was, what it became, and why. |

## Evaluation

| Document | What it covers |
| --- | --- |
| [score-gap-analysis.md](evaluation/score-gap-analysis.md) | Every gap the 0.9.0 work addressed: what the code did before, the root cause, the implementation, and the test. |
| [release-validation.md](evaluation/release-validation.md) | Before/after measurements from the repository's own rubric, run against both commits — including what the numbers are *not* evidence of. |
| [implementation-gap-analysis.md](implementation-gap-analysis.md) | The earlier (0.8.0) gap analysis, kept as a record. |

## Other

- [roadmap.md](roadmap.md)
- [launch-demos.md](launch-demos.md), [demo.md](demo.md), [demo/](demo/) — recorded terminal transcripts and the scripts that capture them
- [launch/](launch/) — launch collateral
