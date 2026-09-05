import ts from "typescript";

import {
  classProperties,
  decoratorArguments,
  decoratorName,
  findDecorator,
  getDecoratorList,
  hasDecorator,
  isLoopLike,
  objectLiteralHasKey,
  propertyName
} from "../ast-utils.js";
import { createFinding } from "../finding.js";
import { enclosingClassName } from "../source-index.js";

/**
 * TypeORM-specific analysis: entities, relations, repositories, QueryBuilder,
 * transactions, indexes and migrations.
 *
 * Everything here is gated on the project actually using TypeORM, so a Prisma
 * codebase never receives repository-shaped advice. TypeORM and Prisma findings
 * deliberately use disjoint id ranges (`TORM-*` vs `PRISMA-*`) so a report can
 * never blur the two.
 */

const ANALYZER_ID = "typeorm";

/**
 * Fallback only. A repository is normally identified by its *declared type*
 * (`Repository<T>` on a constructor parameter), recorded in the source index.
 * This name pattern is kept for the case where the type is unresolvable — an
 * `any`-typed field, or a repository obtained from `getRepository()` — but it
 * is no longer the primary signal. Relying on it alone meant the entire
 * analyzer produced nothing for `private readonly products: Repository<Product>`.
 */
const REPO_FIELD_NAME_PATTERN = /repo(sitory)?$/i;
const REPO_READ_METHODS = new Set(["find", "findBy", "findOne", "findOneBy", "findAndCount", "findOneOrFail", "count"]);
const REPO_WRITE_METHODS = new Set(["save", "remove", "insert", "update", "delete", "softDelete", "softRemove", "increment", "decrement"]);
const RELATION_DECORATORS = new Set(["OneToMany", "ManyToOne", "OneToOne", "ManyToMany"]);
const LOOKUP_COLUMN_PATTERN = /(^|[a-z])(id|email|slug|uuid|code|key|token)$/i;

export const typeormAnalyzer = {
  id: ANALYZER_ID,
  title: "TypeORM",
  categories: ["Database", "Performance"],
  appliesTo: ({ stack }) => stack?.orm === "TypeORM" || stack?.platforms?.includes("typeorm"),
  analyze({ index }) {
    const findings = [];
    for (const file of index.files) {
      findings.push(...checkRepositoryQueries(file, index));
      findings.push(...checkTransactionBoundaries(file, index));
      findings.push(...checkEagerRelations(file));
      findings.push(...checkMissingIndexes(file));
      findings.push(...checkQueryBuilderRisks(file));
      findings.push(...checkDataSourceConfiguration(file));
      findings.push(...checkRawQueryInterpolation(file));
    }
    return findings;
  }
};

// ---------------------------------------------------------------------------
// TORM-001 unbounded read · TORM-002 N+1
// ---------------------------------------------------------------------------

function checkRepositoryQueries({ sourceFile, relativePath }, index) {
  const findings = [];
  const visit = (node, loopDepth) => {
    const nextDepth = loopDepth + (isLoopLike(node) ? 1 : 0);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const baseName = repositoryTargetName(node, index);
      const methodName = node.expression.name.text;
      if (baseName) {
        if (methodName === "find" || methodName === "findBy") {
          const [options] = node.arguments;
          const isPredicate = options && (ts.isArrowFunction(options) || ts.isFunctionExpression(options));
          const paginated = options && objectLiteralHasKey(options, ["take", "skip", "cursor", "limit"]);
          if (!isPredicate && !paginated) {
            findings.push(createFinding({
              id: "TORM-001",
              category: "Database",
              severity: "MEDIUM",
              confidence: "certain",
              analyzer: ANALYZER_ID,
              title: "Unbounded repository read",
              detail: `${baseName}.${methodName}(${options ? "..." : ""}) has no take/skip (or cursor) option, so it returns the whole table and its memory cost grows with the data.`,
              remediation: "Add pagination (`take`/`skip`, or a cursor-based query) to this call and expose it through the API.",
              sourceFile,
              node,
              file: relativePath
            }));
          }
        }
        if (REPO_READ_METHODS.has(methodName) && loopDepth > 0) {
          findings.push(createFinding({
            id: "TORM-002",
            category: "Performance",
            severity: "HIGH",
            confidence: "high",
            analyzer: ANALYZER_ID,
            title: "Repository query inside a loop (N+1)",
            detail: `${baseName}.${methodName}(...) runs inside a loop, issuing one round trip per iteration instead of a single batched query.`,
            remediation: "Replace the per-iteration call with one query: `relations`/a QueryBuilder join, or `In([...])` for a batched lookup.",
            sourceFile,
            node,
            file: relativePath
          }));
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  };
  visit(sourceFile, 0);
  return findings;
}

// ---------------------------------------------------------------------------
// TORM-003 — several writes with no transaction boundary
// ---------------------------------------------------------------------------

function checkTransactionBoundaries({ sourceFile, relativePath }, index) {
  const findings = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body && !ts.isConstructorDeclaration(node)) {
      const writes = [];
      const collect = (inner) => {
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
          const baseName = repositoryTargetName(inner, index);
          if (baseName && REPO_WRITE_METHODS.has(inner.expression.name.text)) writes.push(inner);
        }
        ts.forEachChild(inner, collect);
      };
      collect(node.body);
      if (writes.length >= 2) {
        // Textual containment rather than data-flow proof: a `manager`/
        // `queryRunner` mentioned anywhere in the body means the author is
        // already thinking transactionally, and reporting them anyway is the
        // kind of noise that makes a tool get switched off.
        const bodyText = node.body.getText(sourceFile);
        const transactional = /\.transaction\s*\(|queryRunner|manager\s*\.\s*(save|remove|insert|update)/i.test(bodyText);
        if (!transactional) {
          findings.push(createFinding({
            id: "TORM-003",
            category: "Database",
            severity: "MEDIUM",
            confidence: "medium",
            analyzer: ANALYZER_ID,
            title: "Multiple writes without a transaction boundary",
            detail: `This function makes ${writes.length} separate repository write calls with no enclosing \`dataSource.transaction(...)\` or QueryRunner, so a failure partway through leaves the data half-written.`,
            remediation: "Wrap the related writes in a single `dataSource.transaction(async (manager) => { ... })`, or an explicit QueryRunner transaction with commit/rollback.",
            sourceFile,
            node: writes[0],
            file: relativePath
          }));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// TORM-004 — eager relation on an entity
// ---------------------------------------------------------------------------

function checkEagerRelations({ sourceFile, relativePath }) {
  const findings = [];
  eachEntity(sourceFile, (classNode) => {
    for (const property of classProperties(classNode)) {
      const relation = getDecoratorList(property).find((decorator) => RELATION_DECORATORS.has(decoratorName(decorator) || ""));
      if (!relation) continue;
      const eager = decoratorArguments(relation).some((argument) =>
        ts.isObjectLiteralExpression(argument)
        && argument.properties.some((option) =>
          propertyName(option) === "eager"
          && ts.isPropertyAssignment(option)
          && option.initializer.kind === ts.SyntaxKind.TrueKeyword)
      );
      if (!eager) continue;
      findings.push(createFinding({
        id: "TORM-004",
        category: "Performance",
        severity: "MEDIUM",
        confidence: "certain",
        analyzer: ANALYZER_ID,
        title: "Eager relation loads on every query",
        detail: `${classNode.name?.text}.${propertyName(property)} is declared \`eager: true\`, so every read of this entity joins and hydrates the relation even when the caller doesn't need it.`,
        remediation: "Drop `eager: true` and load the relation explicitly where it is needed (`relations: { ... }` or a QueryBuilder join).",
        sourceFile,
        node: property,
        file: relativePath
      }));
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// TORM-005 — foreign key / lookup column with no index
// ---------------------------------------------------------------------------

function checkMissingIndexes({ sourceFile, relativePath }) {
  const findings = [];
  eachEntity(sourceFile, (classNode) => {
    const classIndexed = getDecoratorList(classNode)
      .filter((decorator) => decoratorName(decorator) === "Index")
      .map((decorator) => decorator.getText(sourceFile))
      .join(" ");
    for (const property of classProperties(classNode)) {
      const name = propertyName(property);
      if (!name) continue;
      const decorators = getDecoratorList(property);
      const names = decorators.map((decorator) => decoratorName(decorator));
      const isManyToOne = names.includes("ManyToOne");
      const isColumn = names.includes("Column");
      const indexed = names.includes("Index") || names.includes("PrimaryColumn")
        || names.includes("PrimaryGeneratedColumn") || classIndexed.includes(`"${name}"`) || classIndexed.includes(`'${name}'`);
      const unique = names.includes("Unique") || decorators.some((decorator) =>
        decoratorArguments(decorator).some((argument) =>
          ts.isObjectLiteralExpression(argument)
          && argument.properties.some((option) => propertyName(option) === "unique"
            && ts.isPropertyAssignment(option)
            && option.initializer.kind === ts.SyntaxKind.TrueKeyword)));
      if (indexed || unique) continue;

      if (isManyToOne) {
        findings.push(createFinding({
          id: "TORM-005",
          category: "Database",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Foreign key column has no index",
          detail: `${classNode.name?.text}.${name} is a @ManyToOne relation with no @Index(). PostgreSQL does not index foreign keys automatically, so joins and cascading deletes on this column do a sequential scan.`,
          remediation: `Add @Index() to ${name} (or a composite @Index on the entity covering it) and generate a migration for it.`,
          sourceFile,
          node: property,
          file: relativePath
        }));
        continue;
      }
      if (isColumn && LOOKUP_COLUMN_PATTERN.test(name) && name.toLowerCase() !== "id") {
        findings.push(createFinding({
          id: "TORM-005",
          category: "Database",
          severity: "LOW",
          confidence: "low",
          analyzer: ANALYZER_ID,
          title: "Likely lookup column has no index",
          detail: `${classNode.name?.text}.${name} is named like a lookup key but carries neither @Index() nor a unique constraint. If rows are fetched by this column the query is a sequential scan.`,
          remediation: `If this column is used in WHERE clauses, add @Index() (or @Column({ unique: true }) when values must be unique) and generate a migration.`,
          sourceFile,
          node: property,
          file: relativePath
        }));
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// TORM-006 — QueryBuilder with no bound on result size
// ---------------------------------------------------------------------------

function checkQueryBuilderRisks({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "getMany" || node.expression.name.text === "getRawMany")) {
      const chain = node.expression.expression.getText(sourceFile);
      if (/createQueryBuilder\s*\(/.test(chain) && !/\.(take|limit|skip|offset)\s*\(/.test(chain)) {
        findings.push(createFinding({
          id: "TORM-006",
          category: "Database",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "QueryBuilder result set is unbounded",
          detail: `A createQueryBuilder(...) chain ends in .${node.expression.name.text}() with no .take()/.limit()/.skip(), so the query returns every matching row.`,
          remediation: "Add .take(pageSize).skip(offset) (or .limit/.offset for raw results) and surface pagination through the API.",
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
// TORM-007 — schema synchronize enabled
// ---------------------------------------------------------------------------

function checkDataSourceConfiguration({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node) === "synchronize"
      && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      findings.push(createFinding({
        id: "TORM-007",
        category: "Database",
        severity: "HIGH",
        confidence: "certain",
        analyzer: ANALYZER_ID,
        title: "TypeORM schema synchronize is enabled",
        detail: "`synchronize: true` makes TypeORM alter the live schema to match the entities at startup. Against a production database that silently drops columns and data.",
        remediation: "Set synchronize to false and manage schema changes with generated migrations (`typeorm migration:generate` / `migration:run`).",
        sourceFile,
        node,
        file: relativePath
      }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// TORM-008 — SQL built by string interpolation
// ---------------------------------------------------------------------------

function checkRawQueryInterpolation({ sourceFile, relativePath }) {
  const findings = [];
  const constants = collectConstantStringSources(sourceFile);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["query", "where", "andWhere", "orWhere", "having"].includes(node.expression.name.text)) {
      const [first] = node.arguments;
      if (first && isInterpolatedSql(first, constants)) {
        findings.push(createFinding({
          id: "TORM-008",
          category: "Security",
          severity: "CRITICAL",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "SQL built by string interpolation",
          detail: `.${node.expression.name.text}(...) receives SQL assembled with template interpolation or concatenation instead of bound parameters, so any user-controlled value is injected into the statement.`,
          remediation: "Use bound parameters: `.where(\"user.id = :id\", { id })` or `dataSource.query(sql, [value])`.",
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

function isInterpolatedSql(node, constants = new Set()) {
  if (ts.isTemplateExpression(node)) {
    if (!node.templateSpans.length) return false;
    // A dynamic ORDER BY cannot be bound as a parameter, so the documented
    // remedy is to interpolate a value looked up from a constant allow-list.
    // Reporting that as a CRITICAL injection flags the fix as the bug, so an
    // interpolation is a finding only when something in it is not provably a
    // compile-time constant.
    return node.templateSpans.some((span) => !isCompileTimeConstant(span.expression, constants));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return ts.isStringLiteralLike(node.left) || ts.isStringLiteralLike(node.right);
  }
  return false;
}

/**
 * Module-level `const` bindings whose value can only ever be a string literal:
 * a literal itself, or an object literal whose every property is one. These
 * are the only names an interpolation may safely carry.
 *
 * `let`/`var` are excluded, and so is an object with any non-literal value —
 * `{ name: process.env.COL }` is not an allow-list.
 */
function collectConstantStringSources(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (isConstantStringInitializer(declaration.initializer)) names.add(declaration.name.text);
    }
  }
  return names;
}

function isConstantStringInitializer(node) {
  const initializer = ts.isAsExpression(node) ? node.expression : node;
  if (ts.isStringLiteralLike(initializer) && !ts.isTemplateExpression(initializer)) return true;
  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer.properties.length > 0 && initializer.properties.every((property) =>
      ts.isPropertyAssignment(property)
      && ts.isStringLiteralLike(property.initializer)
      && !ts.isTemplateExpression(property.initializer));
  }
  return false;
}

/**
 * True when an interpolated expression can only produce one of a fixed set of
 * string literals: a literal, a constant name, or an access into a constant
 * map. Anything else — a parameter, a call, a property of something unknown —
 * is treated as attacker-controlled.
 */
function isCompileTimeConstant(expression, constants) {
  if (ts.isStringLiteralLike(expression) && !ts.isTemplateExpression(expression)) return true;
  if (ts.isIdentifier(expression)) return constants.has(expression.text);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    // The *root* of the access must be a constant map; the key may be dynamic,
    // because every value in that map is a literal the author chose.
    let root = expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && constants.has(root.text);
  }
  return false;
}

// ---------------------------------------------------------------------------

function eachEntity(sourceFile, callback) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && hasDecorator(node, ["Entity", "ViewEntity"])) callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Names the repository a call targets, or null when the call is not a
 * repository call.
 *
 * Order of evidence, strongest first:
 *   1. `this.<field>.x()` where <field> is declared `Repository<T>`.
 *   2. `this.x()` inside a class that extends `Repository<T>`.
 *   3. A local/imported identifier or field whose *name* looks like a
 *      repository — the legacy heuristic, kept only as a fallback.
 */
function repositoryTargetName(callNode, index) {
  const target = callNode.expression.expression;
  const className = enclosingClassName(callNode);

  if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const fieldName = target.name.text;
    if (className && index?.repositoryFields?.get(className)?.has(fieldName)) return fieldName;
    return REPO_FIELD_NAME_PATTERN.test(fieldName) ? fieldName : null;
  }

  if (target.kind === ts.SyntaxKind.ThisKeyword) {
    return className && index?.repositorySubclasses?.has(className) ? "this" : null;
  }

  if (ts.isIdentifier(target)) {
    return REPO_FIELD_NAME_PATTERN.test(target.text) ? target.text : null;
  }
  return null;
}

export { REPO_FIELD_NAME_PATTERN, findDecorator };
