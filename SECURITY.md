# Security Policy

This document covers the security of the `@vantin/backendguard` package and CLI itself — not the security of code it helps you write. For what BackendGuard can and cannot detect in *your* backend project, see the README's [Limitations](README.md#limitations) section.

BackendGuard analyses your code in two layers: a **structural layer** that parses TypeScript with the TypeScript compiler API and reports findings anchored to specific syntax, and a weaker **rule-keyword layer** that matches written `AGENTS.md` rules against a git diff. Neither is a substitute for a security audit or a penetration test.

## Supported Versions

Only the latest published `0.x` release on npm receives fixes. There is no long-term support branch yet.

## Reporting a Vulnerability

Please do not open a public GitHub issue for a suspected vulnerability in BackendGuard itself.

Instead, use [GitHub Security Advisories](https://github.com/vantinn/backendguard/security/advisories/new) on this repository to report privately. Include:

- The affected version (`backendguard --version`).
- Steps to reproduce.
- The potential impact (e.g. local file access, arbitrary command execution, data exfiltration).

We'll acknowledge reports and work with you on a fix and disclosure timeline before any public advisory is published.

## What BackendGuard Does With Your Data

- Reports, prompt history, evidence, and telemetry are written locally under `~/.backendguard/` (a `~/.ctx/backendguard/` directory from a pre-0.9.0 install is still read if it exists, so an upgrade does not lose warmed caches). No source code, credentials, or prompt contents are sent anywhere by default.
- Prompt and Stop hooks do not make network calls. Install/warm commands may download the local embedding model and prepare local indexes when explicitly run.
- The CLI checks npm for a newer version once a day. Set `BACKENDGUARD_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or run in an environment where `CI` is set, and no network request is made at all.
- See the README's [Safety Model](README.md#safety-model) and [Runtime Files](README.md#runtime-files) sections for the full data-handling picture.

## Security Practices In This Codebase

These are the properties the project holds itself to, each enforced by a test:

- **No shell interpolation of arguments.** Child processes are spawned through `runtime/process-runner.js`, which passes an argv array with `shell: false`. Before 0.9.0 several call sites combined `shell: true` with an argument array, which concatenates arguments into a shell command line — a command-injection path reachable from agent names, project paths, and passthrough arguments. On Windows, where npm-installed CLIs are `.cmd` shims that need a shell, arguments are quoted individually and any argument containing a cmd.exe metacharacter is refused. Covered by `tests/process-runner.test.js`.
- **Path containment.** Analyzers only read files resolved inside the project root, never follow symlinks out of it, and bound both file count and file size (`analysis/project-scanner.js`).
- **No developer paths or secret material in the repository or the published package.** `npm run test:package` fails the release if the tarball contains anything matching `.env`, `.pem`, `.key`, `.npmrc`, or an absolute home directory.
- **Analysis fails open, never loud.** An analyzer that throws is reported by id and the other analyzers' findings are still returned, so one parser failure cannot suppress a security finding.

## Known Dependency Advisories

As of 0.9.0, every advisory with a non-breaking fix has been taken (`npm audit fix`), reducing `npm audit --omit=dev` from 11 advisories to 5.

The 5 that remain are all in one chain: the optional local-embedding stack, `@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`, plus `sharp`. The only available fix is `npm audit fix --force`, which downgrades `@xenova/transformers` from 2.x to 1.4.2 — a breaking change to the embedding runtime that would not actually resolve the underlying `protobufjs` advisories. That trade has not been taken.

These are dependency-level issues tracked upstream, not vulnerabilities in BackendGuard's own code, and the affected code path is reached only when embeddings are warmed. Run `npm audit` after installing to see the current state for the version you have.
