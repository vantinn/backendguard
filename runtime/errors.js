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

/**
 * True for every error that describes something outside BackendGuard's control:
 * a mistaken invocation, an unprepared environment, a malformed user config, a
 * third-party integration that failed. These print as a message and a hint.
 * Everything else is a genuine fault in BackendGuard and prints as such.
 */
export function isExpectedError(error) {
  return error instanceof UsageError
    || error instanceof EnvironmentError
    || error instanceof ConfigurationError
    || error instanceof IntegrationError;
}

export function exitCodeFor(error) {
  return typeof error?.exitCode === "number" ? error.exitCode : EXIT.INTERNAL;
}

/**
 * A user-supplied configuration file is present but unusable (malformed JSON,
 * an unparseable TOML table, a value of the wrong shape). The file belongs to
 * the user, so this is their problem to fix, not a fault in BackendGuard.
 */
export class ConfigurationError extends Error {
  constructor(message, { hint, path: filePath } = {}) {
    super(message);
    this.name = "ConfigurationError";
    this.exitCode = EXIT.USAGE;
    this.hint = hint;
    this.path = filePath;
  }
}

/**
 * An optional third-party integration (Ruler, skillshare, an agent CLI) failed.
 *
 * The distinction from `EnvironmentError` is *whose* failure it is: an
 * environment error means BackendGuard cannot run here, an integration error
 * means one external tool BackendGuard drives did not do its job. The rest of
 * a setup run is still valid, so callers are expected to report these and
 * continue rather than abort.
 */
export class IntegrationError extends Error {
  constructor(message, { hint, integration, cause } = {}) {
    super(message);
    this.name = "IntegrationError";
    this.exitCode = EXIT.ENVIRONMENT;
    this.hint = hint;
    this.integration = integration;
    if (cause !== undefined) this.cause = cause;
  }
}
