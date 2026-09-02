# Launch Demos

These are demo scripts for explaining BackendGuard quickly. They are intentionally small and visual.

## 1. Agent Hallucination Benchmark

GIF: [`docs/demo/same-prompt-different-context.gif`](demo/same-prompt-different-context.gif)

Prompt:

```text
Add a registration endpoint
```

Raw agent:

```text
Returns the raw user entity (including passwordHash), no rate limiting.
Reason: no backend-specific security rule was surfaced.
```

BackendGuard:

```text
Detected:
- @nestjs/core, bcrypt, class-validator
- prisma/schema.prisma (provider = "postgresql")

Selected:
- security
- nestjs
- postgresql
```

Message:

```text
Same prompt. Same model. Different context.
```

## 2. AGENTS.md Lost In The Middle

GIF: [`docs/demo/agents-lost-middle.gif`](demo/agents-lost-middle.gif)

Setup:

```text
AGENTS.md
  rule 1
  rule 2
  ...
  IMPORTANT: Always use code-review-graph before grep.
  ...
  rule 40
```

Raw agent:

```text
Misses the buried rule.
```

BackendGuard:

```text
Extracts the relevant rule and injects it before work starts.
```

Message:

```text
Important repo rules should not depend on where they appear in a long file.
```

## 3. Repo-Aware Skills

GIF: [`docs/demo/same-prompt-different-context.gif`](demo/same-prompt-different-context.gif)

Prompt:

```text
add caching to this endpoint
```

Repo A:

```text
Evidence: typeorm, @nestjs/typeorm, pg
Rule packs: typeorm, postgresql, redis
```

Repo B:

```text
Evidence: prisma, @prisma/client, provider = "postgresql"
Rule packs: prisma, postgresql, redis
```

Repo C:

```text
Evidence: no redis/ioredis dependency
Rule packs: redis skipped — no cache client detected
```

Message:

```text
Context is not extra text. It changes the correct answer.
```

## 4. BackendGuard Ready

GIF: [`docs/demo/backendguard-ready.gif`](demo/backendguard-ready.gif)

Command:

```bash
backendguard doctor
```

Message:

```text
Repos now have a target: AGENTS.md + skills + workflows + evidence.
```
