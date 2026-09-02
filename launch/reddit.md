# I built a runtime context router because coding agents keep ignoring AGENTS.md

After a few months of using Codex, Claude Code, and Cursor on real repositories, I kept seeing the same failure mode:

- Agents ignored important AGENTS.md rules.
- Agents guessed the wrong deployment path.
- Agents started reading random files instead of the ones that actually mattered.

The problem wasn't that the agents couldn't read AGENTS.md.

The problem was that the right instruction often got buried in a large context window.

So I built BackendGuard.

Instead of sending the entire project context to the model, BackendGuard injects:

- Relevant rules
- Relevant files
- Relevant skills
- Relevant workflows
- Evidence from the repository

before the agent starts working.

Example:

Prompt:

> Fix deployment

Raw agent:

- Vercel
- Docker
- Railway

BackendGuard in an Expo repo:

- EAS
- Mobile Deployment
- GitHub Actions

Same prompt.
Same model.
Different context.

I also built an offline hallucination benchmark:

- Raw baseline: 10%
- BackendGuard routing: 80%

Still working on live benchmarks for Codex, Claude Code, Cursor, and Gemini.

Would love feedback from people who use coding agents daily.

## First Comment

GitHub: https://github.com/vantinn/backendguard

Install:

```bash
npm install -g @vantin/backendguard
ctx setup
```

Offline benchmark:

```bash
ctx leaderboard --hallucination
```

Note: the 10% to 80% number is an offline deterministic context-routing benchmark, not a claim that BackendGuard beats Codex/Claude/Cursor/Gemini in live runs.
