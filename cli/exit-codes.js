import {
  EXIT,
  ConfigurationError,
  EnvironmentError,
  IntegrationError,
  UsageError,
  exitCodeFor,
  isExpectedError
} from "../runtime/errors.js";

/**
 * CLI-side error presentation. The types themselves live in `runtime/errors.js`
 * so modules below the CLI can raise them without importing the CLI.
 */
export { EXIT, ConfigurationError, EnvironmentError, IntegrationError, UsageError, exitCodeFor };

/**
 * Renders an error for the terminal.
 *
 * Expected errors (usage, environment) print a one-line message plus an
 * actionable hint. Anything else is a bug: the message is printed with an
 * explicit "unexpected error" marker, and the stack only when the user asked
 * for it — a stack trace is noise for a mistyped flag and evidence for a bug.
 */
export function formatCliError(error, { debug = false } = {}) {
  const lines = [];
  if (isExpectedError(error)) {
    lines.push(error.message);
    if (error.hint) lines.push(`  ${error.hint}`);
  } else {
    lines.push(`Unexpected error: ${error.message}`);
    lines.push("  This is a bug in BackendGuard. Please report it at https://github.com/vantinn/backendguard/issues");
    if (debug && error.stack) lines.push(error.stack);
    else lines.push("  Re-run with --debug to include a stack trace in the report.");
  }
  return lines.join("\n");
}
