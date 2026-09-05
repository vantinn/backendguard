# Primary BackendGuard Workflow

Use this workflow for feature implementation, debugging, routing changes, and test fixes in BackendGuard.

planner -> researcher -> tester -> code-reviewer -> docs-manager

## Steps

1. Confirm the affected BackendGuard surface: CLI, prompt hook, MCP server, router, setup, docs, or tests.
2. Inspect the existing module and nearby tests before patching.
3. Keep runtime behavior local-first, bounded, and fail-open.
4. Add focused tests for the changed behavior.
5. Run the relevant validation commands before commit.
