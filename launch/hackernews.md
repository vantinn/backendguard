# Show HN: BackendGuard - a runtime context router for coding agents

Most coding-agent tooling today focuses on retrieval.

I became interested in a slightly different problem:

How do we decide what context should be retrieved in the first place?

BackendGuard is an OSS project that sits before the agent.

Instead of blindly retrieving files, it:

1. Scores AGENTS.md rules.
2. Selects relevant files.
3. Routes skills based on repository evidence.
4. Suggests workflows.
5. Produces post-task compliance reports.

One design goal was keeping prompt hooks fast.

The embedding model is preloaded in a long-running MCP process, while hooks fail open when the bridge is unavailable.

Current local metrics:

- MCP warm p95: ~15-58 ms
- Hook fallback: ~0.69 s

Skill routing currently benchmarks at:

- Top-1 Accuracy: 94.2%
- Top-3 Recall: 94.2%

The more visible demo is:

Prompt:

> Fix deployment

Raw prompt-only baseline:

- Vercel
- Docker
- Railway

BackendGuard in an Expo repo:

- EAS
- Mobile Deployment
- GitHub Actions

Same prompt, different repository evidence.

Would appreciate feedback from people building coding-agent infrastructure.
