# BackendGuard Release Workflow

Use this workflow for version bumps, changelog updates, package validation, tags, and release checks.

planner -> tester -> docs-manager -> code-reviewer

## Steps

1. Update package and plugin versions together when releasing.
2. Update README and CHANGELOG with user-visible behavior.
3. Run tests, build, plugin validation, MCP smoke, and package dry-run.
4. Commit, tag, push, and verify the release automation result.
