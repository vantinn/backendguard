# Rule Engine & Context Retrieval

This covers how BackendGuard decides which `AGENTS.md` rules, files, and rule packs ("skills") are relevant to the current task, and how to extend it.

## Two kinds of rules

BackendGuard has two distinct rule mechanisms — don't confuse them:

1. **AGENTS.md rules** — free-text bullets/paragraphs the target repo's own `AGENTS.md` file already contains. BackendGuard parses and ranks these; it does not author them.
2. **Rule packs** ("skills") — structured, installable, technology-specific bundles BackendGuard ships (`security`, `nestjs`, `postgresql`, `typeorm`, `prisma`, `redis`, `jwt-auth`, `oauth-google`, plus community packs). These are the first-party backend engineering rule library described in the README.

Both feed into the same retrieval pipeline, but they're authored and versioned differently.

## AGENTS.md rule parsing & ranking

File: `plugins/ctx/lib/analyzer.js`

- `parseRules(markdown)` turns raw `AGENTS.md`-style content into flat rule objects: `{ id, sourcePath, content, originalOrder }`. A rule is one bullet/numbered-list line or paragraph of at least ~20 characters; `## Source:` markers track which file it came from when multiple `AGENTS.md` files are chained together (`reader.js` — `readAgentsChain()`).
- `scoreRules(rules, task, openFiles)` ranks rules by token overlap between the task text and rule text (`tokenize()`), a semantic-alias table for near-synonyms, and an "imperative" bonus for words like *always/never/must*. This is intentionally lexical, not ML — the embedding layer (below) is a separate, optional scoring signal.
- `findProjectManifestFiles`, `findExplicitPromptFiles`, `findPromptContextFiles` do the equivalent ranking for candidate files, including NestJS-shaped module-neighbor boosting (`src/modules/<name>/*.controller.ts` etc.) and Prisma schema hinting.
- `isSystemUserRule()` / `isDocumentationOnlyRule()` filter out rules that describe the *agent's runtime environment* (e.g. "run shell commands as user X") rather than the project — these never get injected or scored for compliance.

There is no severity/category metadata on AGENTS.md rules themselves — see [compliance-engine.md](compliance-engine.md#severity-classification) for how severity gets assigned to them after the fact, heuristically.

## Rule packs ("skills")

Files: `community-skills/<pack>/SKILL.md` + `skill.yaml`, parsed by `plugins/ctx/lib/skill-discoverer.js`.

A rule pack is a directory with:

- `SKILL.md` — YAML frontmatter (`name`, `description`) plus a model-visible workflow in Markdown.
- `skill.yaml` — structured metadata: `positive_triggers` (prompts/files/dependencies), `evidence`, `negative_triggers`, `workflow`, `related_skills`. Parsed by the lightweight custom parser `parseSkillMetadata()` (not a full YAML library — see its source for the exact inline-array syntax it supports) and normalized by `normalizeSkillMetadata()` into:

```js
{
  id, name, intent,
  positivePrompts, files, dependencies,
  negativePrompts, negativeFiles, negativeDependencies,
  workflows, relatedSkills, dependsOn, provides, requires, suggestedFiles
}
```

Routing (`hybridSkillScore()`) blends multiple signals — see the formula in the README's [Skill Ranking](../../README.md#skill-ranking) section. The key property: a pack only activates when the target repo shows **real evidence** (a matching dependency or config file) — `detectProjectEvidence()` checks the repo's actual `package.json`/lockfiles/config against each pack's `evidence` block. Negative triggers actively suppress a pack (e.g. `typeorm` pack won't fire in a repo whose evidence points to `prisma`).

### Adding a rule pack

1. Copy `community-skills/_template/` to `community-skills/<your-pack-id>/`.
2. Fill in `skill.yaml`: `positive_triggers` (what prompts/files/deps should surface this pack), `evidence` (what actually proves the repo uses this technology — keep this narrower/stricter than `positive_triggers`), `negative_triggers` (what should suppress it, e.g. a competing ORM), `workflow` (3-5 concrete steps).
3. Write `SKILL.md` — frontmatter `name`/`description` plus the workflow explained in prose for the agent to read directly.
4. Cross-link `related_skills` to existing packs where relevant (see how `security`, `nestjs`, `postgresql`, `typeorm` reference each other).
5. If this is a first-party pack (not a community contribution), add its id to `expectedSeeds` in `test/community-skills.test.js`.
6. Run `backendguard rules doctor -- "<a task that should route to your pack>"` to verify routing, and `npm run benchmark:skills` (`backendguard benchmark --skills`) to check it doesn't regress the routing eval in `eval/skill-routing/cases.yaml`.

### Adding stack detection for a new framework/ORM/database

Rule packs only activate on evidence — that evidence comes from `detectProjectProfile()` in `plugins/ctx/lib/project-context-generator.js`. To support a new technology end-to-end:

1. Add a dependency/file check to `detectProjectProfile()` (follow the existing `pg`/`typeorm`/`prisma` checks) and push a new tag onto `platforms`.
2. If it should show up in `backendguard stack`, add a field to `buildStackReport()` and a row in `formatStackReport()`.
3. Author the corresponding rule pack (see above) with `evidence` matching the same dependency/file signals.

## Context retrieval orchestration

File: `plugins/ctx/lib/score-context.js` — `scoreContext()` is the single entrypoint both the CLI (`backendguard context`/`debug`) and the MCP tool `ctx_score_context` call. It runs rule scoring, file retrieval, rule-pack retrieval, and workflow retrieval, optionally boosted by:

- `plugins/ctx/lib/embedding-scorer.js` / `file-embedding-retriever.js` — local MiniLM embeddings for semantic similarity (bridges vocabulary mismatch, e.g. non-English prompts vs. English rule text). Runs inside the hot `ctx-mcp` process; hooks never cold-load the model (see [integrations.md](integrations.md)).
- `plugins/ctx/lib/graph-retriever.js` / `graph-strategy.js` — optional `code-review-graph`/`codegraph` adapters for blast-radius and symbol search. Contribute score `0` when unavailable; never required.

`plugins/ctx/lib/scheduler.js` — `scheduleContext()` takes the scored candidates and lays out the final injected text: which rules are "critical" vs. additional, adaptive budgets for files/skills/workflows (task-complexity-aware, not a fixed count), and the exact markdown the agent sees.
