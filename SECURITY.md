# Security Policy

This document covers the security of the `@vantin/backendguard` package and CLI itself — not the security of code it helps you write. For what BackendGuard can and cannot detect in *your* backend project, see the README's [Limitations](README.md#limitations) section; its compliance checks are heuristic keyword matching against a git diff, not static analysis or a formal security audit.

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

- Reports, prompt history, evidence, and telemetry are written locally under `~/.ctx/backendguard/`. No source code, credentials, or prompt contents are sent anywhere by default.
- Prompt and Stop hooks do not make network calls. Install/warm commands may download the local embedding model and prepare local indexes when explicitly run.
- See the README's [Safety Model](README.md#safety-model) and [Runtime Files](README.md#runtime-files) sections for the full data-handling picture.

## Known Dependency Advisories

`npm audit` currently reports advisories (including a critical one) in transitive dependencies pulled in by the optional local-embedding stack (`@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`, plus `sharp`), with no upstream fix available at the time of writing. These are dependency-level issues tracked upstream, not vulnerabilities in BackendGuard's own code. Run `npm audit` after installing to see the current state for the version you have installed.
