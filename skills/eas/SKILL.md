---
name: Expo EAS Deployment
description: Fix Expo EAS builds, submit flows, preview builds, production releases, and mobile deployment failures.
---

# Expo EAS Deployment

Use this skill for Expo or React Native projects with EAS evidence such as `eas.json`, `app.json`, `app.config.ts`, `expo`, or `eas-cli`.

## Workflow

1. Inspect `eas.json`, app config, package scripts, and CI workflow files.
2. Identify whether the failure is credentials, profile config, native dependency, bundling, or submit configuration.
3. Patch the smallest config or package boundary that explains the log.
4. Verify with the relevant EAS, Expo, or package build command.
