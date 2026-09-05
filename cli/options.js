import fs from "node:fs";
import path from "node:path";

import { EnvironmentError, UsageError } from "./exit-codes.js";

/**
 * Argument validation shared by the analysis commands.
 *
 * Every function here rejects bad input with a `UsageError` carrying an
 * actionable hint, so a mistyped flag produces one readable line and exit code
 * 2 rather than a stack trace or — worse — a silently ignored flag.
 */

export const SEVERITY_ORDER = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const CONFIDENCE_ORDER = ["low", "medium", "high", "certain"];

export function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value.`, { hint: `Example: ${flag} <value>` });
  }
  return value;
}

export function parseSeverity(args, flag, { required = false } = {}) {
  const raw = flagValue(args, flag);
  if (raw === null) {
    if (required) throw new UsageError(`${flag} is required.`);
    return null;
  }
  const normalized = raw.toUpperCase();
  if (!SEVERITY_ORDER.includes(normalized)) {
    throw new UsageError(`Invalid severity "${raw}" for ${flag}.`, {
      hint: `Valid values: ${SEVERITY_ORDER.map((value) => value.toLowerCase()).join(", ")}`
    });
  }
  return normalized;
}

export function parseConfidence(args, flag) {
  const raw = flagValue(args, flag);
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (!CONFIDENCE_ORDER.includes(normalized)) {
    throw new UsageError(`Invalid confidence "${raw}" for ${flag}.`, {
      hint: `Valid values: ${CONFIDENCE_ORDER.join(", ")}`
    });
  }
  return normalized;
}

export function parseList(args, flag, { allowed, label } = {}) {
  const raw = flagValue(args, flag);
  if (raw === null) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.length) {
    throw new UsageError(`${flag} needs at least one ${label || "value"}.`);
  }
  if (allowed) {
    const unknown = values.filter((value) => !allowed.includes(value.toLowerCase()));
    if (unknown.length) {
      throw new UsageError(`Unknown ${label || "value"}(s) for ${flag}: ${unknown.join(", ")}.`, {
        hint: `Valid values: ${allowed.join(", ")}`
      });
    }
  }
  return values;
}

export function meetsSeverity(finding, minimum) {
  if (!minimum) return true;
  return SEVERITY_ORDER.indexOf(finding.severity) >= SEVERITY_ORDER.indexOf(minimum);
}

export function meetsConfidence(finding, minimum) {
  if (!minimum) return true;
  return CONFIDENCE_ORDER.indexOf(finding.confidence) >= CONFIDENCE_ORDER.indexOf(minimum);
}

/**
 * Resolves an optional positional path argument.
 *
 * `valueFlags` names the flags that consume the following token, so
 * `analyze --severity high` does not mistake "high" for a directory — the bug
 * that made `--severity huge` report "No such directory: huge".
 */
export function resolveTargetDirectory(args, { cwd = process.cwd(), valueFlags = [] } = {}) {
  const consumed = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.includes(args[index])) consumed.add(index + 1);
  }
  const positional = args.find((argument, index) =>
    index > 0 && !argument.startsWith("-") && !consumed.has(index));
  if (!positional) return cwd;
  const resolved = path.resolve(cwd, positional);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new EnvironmentError(`No such directory: ${positional}`, {
      hint: "Pass a path to a project directory, or run the command from inside one."
    });
  }
  if (!stats.isDirectory()) {
    throw new EnvironmentError(`Not a directory: ${positional}`, {
      hint: "backendguard analyzes a project directory, not a single file."
    });
  }
  return resolved;
}

/**
 * Flags that appear on the command line but are not declared for the command.
 * A silently ignored `--sevrity` is worse than an error: the user believes a
 * filter was applied.
 */
export function rejectUnknownFlags(args, command) {
  if (!command) return;
  const declared = new Set(["--help", "-h", "--debug", "--json"]);
  for (const [flags] of command.options || []) {
    for (const token of flags.split(",")) {
      const flag = token.trim().split(" ")[0];
      if (flag.startsWith("-")) declared.add(flag);
    }
  }
  const separator = args.indexOf("--");
  const scanned = separator >= 0 ? args.slice(0, separator) : args;
  const unknown = scanned
    .slice(1)
    .filter((argument) => argument.startsWith("-") && !declared.has(argument))
    // A value that itself starts with "-" was already rejected by flagValue.
    .filter((argument) => !/^-\d/.test(argument));
  if (unknown.length) {
    throw new UsageError(`Unknown option(s) for \`backendguard ${command.name}\`: ${unknown.join(", ")}.`, {
      hint: `Run \`backendguard ${command.name} --help\` to see the accepted options.`
    });
  }
}
