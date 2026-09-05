/**
 * Error types that carry an intended process exit code.
 *
 * These live in `runtime/` rather than `cli/` because the modules that *detect*
 * a usage or environment problem — rule sync, skill sync, passthrough, the
 * benchmarks — sit below the CLI layer and must not import from it. Before this
 * existed they threw bare `Error`s, which the CLI could only classify as
 * internal faults: six commands answered a missing argument with exit code 70
 * and "This is a bug in BackendGuard. Please report it."
 */

export const EXIT = {
  /** Command completed; nothing blocking was found. */
  OK: 0,
  /** The command ran correctly and found issues at or above the fail threshold. */
  FINDINGS: 1,
  /** The user's invocation was wrong: unknown command, bad flag, missing argument. */
  USAGE: 2,
  /** The environment is not ready: not a git repository, a required CLI is missing. */
  ENVIRONMENT: 3,
  /** A bug in BackendGuard. Distinct from every code above so it is never mistaken for a finding. */
  INTERNAL: 70
};

/** A problem with what the user asked for. Printed as a message, never a stack. */
export class UsageError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "UsageError";
    this.exitCode = EXIT.USAGE;
    this.hint = hint;
  }
}

/** A problem with the environment the command was run in. */
export class EnvironmentError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "EnvironmentError";
    this.exitCode = EXIT.ENVIRONMENT;
    this.hint = hint;
  }
}

export function isExpectedError(error) {
  return error instanceof UsageError || error instanceof EnvironmentError;
}

export function exitCodeFor(error) {
  return typeof error?.exitCode === "number" ? error.exitCode : EXIT.INTERNAL;
}
