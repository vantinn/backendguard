import ts from "typescript";

import { objectLiteralProperty, propertyName } from "../ast-utils.js";
import { createFinding, createTextFinding } from "../finding.js";
import { collectSqlFiles, readSource } from "../project-scanner.js";

/**
 * PostgreSQL analysis that is ORM-independent: raw SQL, migration files, and
 * connection/pool configuration.
 *
 * The ORM analyzers cover schema modelling through TypeORM entities and the
 * Prisma schema; this one covers the SQL a project writes or generates itself,
 * which is where the sharpest production incidents come from (a blocking
 * migration, an unbounded `SELECT *`, an exhausted connection pool).
 */

const ANALYZER_ID = "postgresql";

// Statements that take an ACCESS EXCLUSIVE lock and rewrite the table. On a
// large table these block every read and write for the duration.
const BLOCKING_MIGRATION_PATTERNS = [
  { pattern: /\bALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i, what: "ADD COLUMN ... NOT NULL without a default" },
  { pattern: /\bALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+TYPE\b/i, what: "ALTER COLUMN ... TYPE (full table rewrite)" },
  { pattern: /\bALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\b[^;]*\b(FOREIGN\s+KEY|CHECK)\b(?![^;]*\bNOT\s+VALID\b)/i, what: "ADD CONSTRAINT without NOT VALID" }
];

const CREATE_INDEX_BLOCKING = /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?![^;]*\bCONCURRENTLY\b)/i;
const SELECT_STAR_UNBOUNDED = /\bSELECT\s+\*\s+FROM\s+[\w".]+(?![^;]*\b(LIMIT|WHERE|COUNT)\b)/i;
const DELETE_OR_UPDATE_NO_WHERE = /\b(DELETE\s+FROM|UPDATE)\s+[\w".]+\s*(?![^;]*\bWHERE\b)[^;]*;/i;

export const postgresqlAnalyzer = {
  id: ANALYZER_ID,
  title: "PostgreSQL",
  categories: ["Database", "Performance"],
  appliesTo: ({ stack }) => stack?.database === "PostgreSQL" || stack?.platforms?.includes("postgresql"),
  analyze({ index, cwd }) {
    const findings = [];
    findings.push(...analyzeSqlFiles(cwd));
    for (const file of index.files) {
      findings.push(...checkConnectionPool(file));
      findings.push(...checkInlineSql(file));
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// SQL and migration files
// ---------------------------------------------------------------------------

export function analyzeSqlFiles(cwd) {
  const findings = [];
  const { files } = collectSqlFiles(cwd);
  for (const relativePath of files) {
    const text = readSource(cwd, relativePath);
    if (text === null) continue;
    findings.push(...analyzeSqlText(text, relativePath));
  }
  return findings;
}

/**
 * Splits SQL into statements, remembering where each one started.
 *
 * The checks below used to run line-by-line, which meant a conventionally
 * formatted migration —
 *
 *   ALTER TABLE orders
 *     ADD COLUMN region varchar(8) NOT NULL;
 *
 * — matched nothing at all, because no single line contains both halves of the
 * pattern. Every migration tool in common use emits multi-line statements, so
 * the line-based version missed the majority of real migrations.
 */
export function splitSqlStatements(text) {
  const statements = [];
  const lines = String(text || "").split(/\r?\n/);
  let current = [];
  let startLine = 1;

  for (let index = 0; index < lines.length; index += 1) {
    const withoutComment = lines[index].replace(/--.*$/, "");
    if (!current.length && !withoutComment.trim()) continue;
    if (!current.length) startLine = index + 1;
    current.push(withoutComment);
    if (withoutComment.includes(";")) {
      statements.push({ text: current.join(" ").replace(/\s+/g, " ").trim(), line: startLine });
      current = [];
    }
  }
  if (current.length) {
    const trailing = current.join(" ").replace(/\s+/g, " ").trim();
    if (trailing) statements.push({ text: trailing, line: startLine });
  }
  return statements;
}

export function analyzeSqlText(text, relativePath) {
  const findings = [];
  const isMigration = /migrat/i.test(relativePath);

  for (const { text: statement, line: statementLine } of splitSqlStatements(text)) {
    const line = statement;
    const i = statementLine - 1;

    if (isMigration) {
      for (const { pattern, what } of BLOCKING_MIGRATION_PATTERNS) {
        if (!pattern.test(line)) continue;
        findings.push(createTextFinding({
          id: "PG-001",
          category: "Database",
          severity: "HIGH",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Migration takes a blocking table lock",
          detail: `${what} holds an ACCESS EXCLUSIVE lock while PostgreSQL rewrites the table, blocking all reads and writes for the duration. On a large table that is a production outage.`,
          remediation: "Split the change: add the column nullable (or with a default) first, backfill in batches, then add the constraint as NOT VALID and VALIDATE CONSTRAINT separately.",
          evidence: line.trim(),
          file: relativePath,
          line: i + 1
        }));
      }
      if (CREATE_INDEX_BLOCKING.test(line)) {
        findings.push(createTextFinding({
          id: "PG-002",
          category: "Database",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Index created without CONCURRENTLY",
          detail: "CREATE INDEX takes a SHARE lock that blocks writes to the table until the index is built.",
          remediation: "Use CREATE INDEX CONCURRENTLY (outside a transaction block) so writes continue during the build.",
          evidence: line.trim(),
          file: relativePath,
          line: i + 1
        }));
      }
      if (DELETE_OR_UPDATE_NO_WHERE.test(line)) {
        findings.push(createTextFinding({
          id: "PG-003",
          category: "Database",
          severity: "CRITICAL",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Migration UPDATE/DELETE has no WHERE clause",
          detail: "This statement rewrites or removes every row in the table, and in a migration that runs unattended against production data.",
          remediation: "Add a WHERE clause scoping the change, and run large backfills in bounded batches.",
          evidence: line.trim(),
          file: relativePath,
          line: i + 1
        }));
      }
    }

    if (SELECT_STAR_UNBOUNDED.test(line)) {
      findings.push(createTextFinding({
        id: "PG-004",
        category: "Performance",
        severity: "MEDIUM",
        confidence: "medium",
        analyzer: ANALYZER_ID,
        title: "SELECT * with no WHERE or LIMIT",
        detail: "This query reads every column of every row. Result size and memory use grow without bound as the table grows.",
        remediation: "Select only the columns needed and add a WHERE/LIMIT bound.",
        evidence: line.trim(),
        file: relativePath,
        line: i + 1
      }));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// PG-010 — connection pool configuration
// ---------------------------------------------------------------------------

function checkConnectionPool({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Pool") {
      const [options] = node.arguments || [];
      const hasMax = options && ts.isObjectLiteralExpression(options)
        && options.properties.some((property) => ["max", "maxConnections", "connectionLimit"].includes(propertyName(property)));
      if (!hasMax) {
        findings.push(createFinding({
          id: "PG-010",
          category: "Scalability",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Connection pool has no size limit",
          detail: "new Pool(...) is created without `max`, so the pool grows to the driver default. Several application instances each doing that will exhaust PostgreSQL's max_connections before the app itself saturates.",
          remediation: "Set `max` explicitly, sized as (postgres max_connections − reserve) / number of app instances, and put a pooler (PgBouncer) in front for high replica counts.",
          sourceFile,
          node,
          file: relativePath
        }));
      }

      const idleTimeout = options && objectLiteralProperty(options, "idleTimeoutMillis");
      if (hasMax && !idleTimeout) {
        findings.push(createFinding({
          id: "PG-011",
          category: "Scalability",
          severity: "LOW",
          confidence: "medium",
          analyzer: ANALYZER_ID,
          title: "Connection pool has no idle timeout",
          detail: "Without `idleTimeoutMillis`, idle connections are held indefinitely, keeping server-side backends alive after a traffic spike has passed.",
          remediation: "Set `idleTimeoutMillis` (and `connectionTimeoutMillis`) so the pool releases connections it no longer needs.",
          sourceFile,
          node,
          file: relativePath
        }));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// PG-012 — SQL embedded in TypeScript, built by interpolation
// ---------------------------------------------------------------------------

const SQL_SHAPE = /\b(select|insert\s+into|update|delete\s+from)\b/i;

/**
 * `"SELECT ... WHERE x = '" + value + "'"` — string concatenation is the oldest
 * and still the most common form of SQL injection, and it was not detected at
 * all: only template literals were inspected.
 */
function isConcatenatedSql(node, sourceFile) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  // Only the outermost node of a concatenation chain should report.
  if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return false;
  const text = node.getText(sourceFile);
  if (!SQL_SHAPE.test(text) || !/\bwhere\b/i.test(text)) return false;
  // At least one operand must be a non-literal: `"a" + "b"` is a constant.
  let hasDynamic = false;
  const walk = (current) => {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      walk(current.left);
      walk(current.right);
      return;
    }
    if (!ts.isStringLiteralLike(current)) hasDynamic = true;
  };
  walk(node);
  return hasDynamic;
}

function checkInlineSql({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (isConcatenatedSql(node, sourceFile)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      findings.push({ ...createFinding({
        id: "PG-012",
        category: "Security",
        severity: "CRITICAL",
        confidence: "high",
        analyzer: ANALYZER_ID,
        title: "SQL statement assembled by string concatenation",
        detail: "A SQL statement with a WHERE clause is built by concatenating a non-literal value into the string rather than binding it, so any user-controlled value alters the statement.",
        remediation: "Pass values as bound parameters ($1, $2 with an argument array) instead of concatenating them into the SQL text.",
        sourceFile,
        node,
        file: relativePath
      }), supersededWithin: { startLine: line, endLine: line } });
    }
    if (ts.isTemplateExpression(node) && node.templateSpans.length) {
      const text = node.getText(sourceFile);
      // A tagged template (sql`...`, prisma.$queryRaw`...`) binds parameters, so
      // interpolation there is correct, not a defect.
      const tagged = ts.isTaggedTemplateExpression(node.parent);
      if (!tagged && SQL_SHAPE.test(text) && /\bwhere\b/i.test(text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        // When an ORM analyzer has already named the exact unsafe API at this
        // line (e.g. Prisma's $queryRawUnsafe), that finding is the more useful
        // one and this generic observation is suppressed.
        findings.push({ ...createFinding({
          id: "PG-012",
          category: "Security",
          severity: "CRITICAL",
          confidence: "medium",
          analyzer: ANALYZER_ID,
          title: "SQL statement assembled by template interpolation",
          detail: "A template literal containing a SQL statement with a WHERE clause interpolates values directly into the string rather than binding them, so any user-controlled value alters the statement.",
          remediation: "Pass values as bound parameters ($1, $2 with an argument array), or use a tagged template that binds them.",
          sourceFile,
          node,
          file: relativePath
        }), supersededWithin: { startLine: line, endLine: line } });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
