/**
 * The release-readiness rubric.
 *
 * IMPORTANT — what this is and is not.
 *
 * The 57/100 baseline this repository was working against came from an
 * *external* validation run that is not part of this repository, so its exact
 * scoring code cannot be re-executed here. Rather than assert an unverifiable
 * "after" number against it, this file defines a rubric that lives in the repo,
 * is fully deterministic, and can be run against **any commit** — including the
 * pre-refactor one — so a before/after comparison is measured, not asserted.
 *
 * Every check answers a yes/no or counted question about the repository as it
 * exists on disk. Nothing here inspects this rubric's own results, and no check
 * can be satisfied by editing the rubric: each one names the artefact it reads.
 *
 * Weights are stated up front and sum to 100.
 */

export const CATEGORIES = [
  {
    id: "correctness",
    title: "Correctness and tests",
    weight: 18,
    rationale: "A tool whose own tests do not run, or barely exist, cannot be trusted to judge other code."
  },
  {
    id: "security-analysis",
    title: "Security analysis capability",
    weight: 12,
    rationale: "The product's headline claim: finding real security defects in backend code."
  },
  {
    id: "database-analysis",
    title: "Database, ORM and PostgreSQL analysis",
    weight: 12,
    rationale: "PostgreSQL, Prisma and TypeORM are named in the package description and must be separately supported."
  },
  {
    id: "performance-scalability",
    title: "Performance and scalability analysis",
    weight: 8,
    rationale: "Claimed in the README; must be evidence-based and must not overclaim measurement."
  },
  {
    id: "detection-quality",
    title: "Detection quality (false positives and negatives)",
    weight: 12,
    rationale: "A analyzer that cries wolf gets switched off; one that misses defects is decoration."
  },
  {
    id: "retrieval",
    title: "Context retrieval quality",
    weight: 8,
    rationale: "The other half of the product: giving an agent the right rules for the task."
  },
  {
    id: "cli",
    title: "CLI reliability",
    weight: 8,
    rationale: "Help, validation, exit codes and error messages are the entire interface."
  },
  {
    id: "packaging",
    title: "Package integrity",
    weight: 8,
    rationale: "The package that npm publishes is what users actually run."
  },
  {
    id: "tool-security",
    title: "Security of the tool itself",
    weight: 6,
    rationale: "A security tool with a command-injection path in its own installer has no standing."
  },
  {
    id: "architecture",
    title: "Architecture and extensibility",
    weight: 8,
    rationale: "Whether a second contributor can add a framework, ORM or check without touching everything else."
  }
];

export const TOTAL_WEIGHT = CATEGORIES.reduce((sum, category) => sum + category.weight, 0);

export const RELEASE_GATES = [
  { id: "tests-pass", title: "All automated tests pass" },
  { id: "no-known-critical", title: "No known critical security issue in the tool itself" },
  { id: "package-installs", title: "The packed npm artefact installs and its CLI runs" },
  { id: "commands-work", title: "Every documented command has working --help" },
  { id: "no-legacy-terminology", title: "No unintended legacy product terminology remains" },
  { id: "no-broken-imports", title: "Every relative import resolves" },
  { id: "no-secret-leakage", title: "No secret material or developer path is committed or packed" },
  { id: "docs-match", title: "Documentation describes behaviour that exists" }
];
