# Why Coding Agents Ignore AGENTS.md (and What I Built to Fix It)

Coding agents are getting better fast.

But after using Codex, Claude Code, and Cursor on real repositories, I kept seeing the same failure pattern:

- The agent ignored important project rules.
- The agent guessed the wrong deployment path.
- The agent started reading random files before understanding the task.

The problem usually was not that the model was incapable.

The problem was that the right context was missing, buried, or not selected at the right time.

So I built BackendGuard.

## 1. The AGENTS.md Problem

Many repositories now have an `AGENTS.md` file.

It might say things like:

- Always use the project graph before broad file search.
- Run focused tests before broad test suites.
- Do not edit generated files.
- Follow this service boundary.

These rules matter.

But in a large context window, the important rule can get buried. The agent may technically receive the instruction, but still fail to act on it.

## 2. Lost In The Middle

This is the classic "lost in the middle" problem applied to coding agents.

If the agent receives a long block of repository context, the highest-value instruction may not be the one that gets used.

BackendGuard treats project rules as runtime context, not static text.

For each prompt, it selects the rules that matter for that task and injects them before the agent starts working.

## 3. Wrong Deployment Paths

The easiest demo is deployment.

Prompt:

```txt
Fix deployment
```

A raw agent may guess:

```txt
Vercel
Docker
Railway
```

But in an Expo repository with `eas.json`, `expo`, and `react-native`, the useful answer is:

```txt
EAS
Mobile Deployment
GitHub Actions
```

Same prompt.
Same model.
Different context.

## 4. Random File Exploration

Another common problem is file exploration.

The agent starts with broad search, reads unrelated files, and burns context before it reaches the files that matter.

BackendGuard suggests files before the agent starts editing.

It uses prepared local indexes and project evidence so prompt-time hooks do not need to walk the whole repository.

## 5. Building BackendGuard

BackendGuard sits before the agent.

It prepares a compact task brief:

- Relevant rules
- Suggested files
- Suggested skills
- Suggested workflows
- Evidence for post-task reports

The goal is not to replace the coding agent.

The goal is to give the agent the right context before it writes code.

## 6. Skill Router

BackendGuard also routes skills.

The important part is that skills are not selected from the prompt alone.

They are selected from prompt plus repository evidence.

For example, `eas` should only score highly when the repo has evidence like:

- `eas.json`
- `expo`
- `react-native`
- mobile build config

Without that evidence, BackendGuard should not confidently suggest EAS just because the prompt says "deploy".

## 7. Hallucination Benchmark

I built an offline benchmark to measure wrong-context selection.

Current deterministic result:

```txt
Raw heuristic baseline: 10%
BackendGuard evidence benchmark: 80%
```

This is not a claim that BackendGuard beats Codex, Claude Code, Cursor, or Gemini in live runs.

Live agent benchmarks are still pending external environments with working auth/session access.

But it does show that evidence-based context routing changes the selected path on controlled repository fixtures.

## 8. Lessons Learned

The biggest lesson:

Coding agents often do not need more context.

They need better context selection.

`AGENTS.md` is useful, but not enough by itself.

RAG is useful, but file retrieval alone does not solve rules, workflows, skills, and compliance.

BackendGuard is my attempt to build the missing pre-flight layer for coding agents.

GitHub:

https://github.com/vantinn/backendguard

Install:

```bash
npm install -g @vantin/backendguard
ctx setup
```
