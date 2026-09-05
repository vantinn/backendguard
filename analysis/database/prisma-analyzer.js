import path from "node:path";
import ts from "typescript";

import { callPath, isLoopLike, objectLiteralHasKey, objectLiteralProperty, propertyName } from "../ast-utils.js";
import { createFinding, createTextFinding } from "../finding.js";
import { enclosingClassName } from "../source-index.js";
import { collectPrismaSchemas, readSource } from "../project-scanner.js";
import {
  fieldHasAttribute,
  isScalarType,
  modelHasBlockAttribute,
  parsePrismaSchema,
  relationFields
} from "./prisma-schema.js";

/**
 * Prisma-specific analysis.
 *
 * Two evidence sources, kept strictly separate from the TypeORM checks:
 *   1. `schema.prisma` — models, relations, indexes, constraints, datasource.
 *   2. generated-client call sites in TypeScript — pagination, select/include,
 *      relation loading in loops, transactions, raw queries.
 *
 * Findings use the `PRISMA-*` id range so a mixed repository can never present
 * a TypeORM finding as a Prisma one.
 */

const ANALYZER_ID = "prisma";

const READ_MANY_METHODS = new Set(["findMany"]);
const READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate"]);
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"]);
const RAW_METHODS = new Set(["$queryRawUnsafe", "$executeRawUnsafe"]);
const LOOKUP_FIELD_PATTERN = /(^|[a-z])(email|slug|uuid|code|externalId|token|username)$/i;

export const prismaAnalyzer = {
  id: ANALYZER_ID,
  title: "Prisma",
  categories: ["Database", "Performance", "Security"],
  appliesTo: ({ stack }) => stack?.orm === "Prisma" || stack?.platforms?.includes("prisma"),
  analyze({ index, cwd }) {
    const findings = [];
    findings.push(...analyzeSchemas(cwd));
    for (const file of index.files) findings.push(...analyzeClientUsage(file, index));
    return findings;
  }
};

// ---------------------------------------------------------------------------
// Schema checks
// ---------------------------------------------------------------------------

export function analyzeSchemas(cwd) {
  const findings = [];
  const { files } = collectPrismaSchemas(cwd);
  for (const relativePath of files) {
    if (path.basename(relativePath) !== "schema.prisma") continue;
    const text = readSource(cwd, relativePath);
    if (text === null) continue;
    findings.push(...analyzeSchemaText(text, relativePath));
  }
  return findings;
}

export function analyzeSchemaText(text, relativePath) {
  const schema = parsePrismaSchema(text);
  const findings = [];

  for (const model of schema.models) {
    if (model.kind !== "model") continue;

    for (const field of model.fields) {
      // PRISMA-001 — relation scalar with no index. Prisma does not create one,
      // and Postgres does not index foreign keys automatically, so every join
      // and every cascading delete on this column is a sequential scan.
      const isRelationScalar = /_?id$/i.test(field.name)
        && isScalarType(field.type)
        && model.fields.some((other) => other.attributes.some((attribute) => attribute.includes(`fields: [${field.name}]`)));
      if (isRelationScalar
        && !fieldHasAttribute(field, "id")
        && !fieldHasAttribute(field, "unique")
        && !modelHasBlockAttribute(model, "index", field.name)
        && !modelHasBlockAttribute(model, "unique", field.name)) {
        findings.push(createTextFinding({
          id: "PRISMA-001",
          category: "Database",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Relation scalar field has no index",
          detail: `${model.name}.${field.name} backs a relation but has no @@index([${field.name}]) and is not unique. Prisma does not add an index for relation scalars, so joins and cascading deletes scan the table.`,
          remediation: `Add @@index([${field.name}]) to model ${model.name} and create a migration for it.`,
          evidence: field.text,
          file: relativePath,
          line: field.line
        }));
      }

      // PRISMA-002 — a natural lookup key that is neither unique nor indexed.
      if (isScalarType(field.type)
        && !field.isList
        && LOOKUP_FIELD_PATTERN.test(field.name)
        && !fieldHasAttribute(field, "unique")
        && !fieldHasAttribute(field, "id")
        && !modelHasBlockAttribute(model, "unique", field.name)
        && !modelHasBlockAttribute(model, "index", field.name)) {
        findings.push(createTextFinding({
          id: "PRISMA-002",
          category: "Database",
          severity: field.name.toLowerCase() === "email" ? "MEDIUM" : "LOW",
          confidence: field.name.toLowerCase() === "email" ? "medium" : "low",
          analyzer: ANALYZER_ID,
          title: "Lookup field has no unique constraint or index",
          detail: `${model.name}.${field.name} is named like an identity/lookup key but carries neither @unique nor an index, so duplicates are possible and lookups scan the table.`,
          remediation: `Add @unique to ${field.name} if values must be distinct, otherwise @@index([${field.name}]).`,
          evidence: field.text,
          file: relativePath,
          line: field.line
        }));
      }

      // PRISMA-003 — money stored as a float.
      if (field.type === "Float" && /price|amount|total|balance|cost|fee|salary/i.test(field.name)) {
        findings.push(createTextFinding({
          id: "PRISMA-003",
          category: "Database",
          severity: "MEDIUM",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Monetary field stored as Float",
          detail: `${model.name}.${field.name} is a Float. Binary floating point cannot represent decimal currency exactly, so totals drift.`,
          remediation: `Use Decimal @db.Decimal(precision, scale) (or an integer number of minor units) for ${field.name}.`,
          evidence: field.text,
          file: relativePath,
          line: field.line
        }));
      }
    }

    // PRISMA-004 — one-to-many relation with no index on the owning side is
    // covered by PRISMA-001; this covers a model with relations and no id.
    const hasId = model.fields.some((field) => fieldHasAttribute(field, "id")) || modelHasBlockAttribute(model, "id");
    if (!hasId && relationFields(schema, model).length) {
      findings.push(createTextFinding({
        id: "PRISMA-004",
        category: "Database",
        severity: "MEDIUM",
        confidence: "high",
        analyzer: ANALYZER_ID,
        title: "Model has relations but no primary key",
        detail: `Model ${model.name} declares relations but no @id/@@id, so rows cannot be addressed individually and Prisma cannot update or delete them by identity.`,
        remediation: `Add a primary key to ${model.name} (@id on a field, or @@id([...]) for a composite key).`,
        evidence: `model ${model.name}`,
        file: relativePath,
        line: model.line
      }));
    }
  }

  // PRISMA-005 — datasource url inlined instead of read from the environment.
  for (const datasource of schema.datasources) {
    if (datasource.url && !/^env\(/.test(datasource.url)) {
      findings.push(createTextFinding({
        id: "PRISMA-005",
        category: "Security",
        severity: "HIGH",
        confidence: "certain",
        analyzer: ANALYZER_ID,
        title: "Prisma datasource URL is hardcoded",
        detail: `datasource ${datasource.name} sets url to a literal value instead of env("..."), so the connection string (and any credentials in it) is committed to the repository.`,
        remediation: 'Set url = env("DATABASE_URL") and supply the value through the environment.',
        evidence: `url = ${datasource.url}`,
        file: relativePath,
        line: datasource.line
      }));
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Client call-site checks
// ---------------------------------------------------------------------------

/**
 * True when a call goes through a Prisma client.
 *
 * Resolution is by declared type first (`private readonly db: PrismaService`),
 * because the field is very often not called `prisma`. Matching the word
 * `prisma` in the call path is kept as a fallback for a module-level client
 * (`import { prisma } from "./client"`), but it is no longer the only signal —
 * relying on it meant the analyzer silently produced nothing for the common
 * `db`/`orm`/`client` naming.
 */
function isPrismaClientCall(callNode, index) {
  const target = callNode.expression.expression;
  const className = enclosingClassName(callNode);

  // this.<field>.model.op() — walk down to the `this.<field>` root.
  let root = target;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (root.kind === ts.SyntaxKind.ThisKeyword) {
    let owner = target;
    while (ts.isPropertyAccessExpression(owner) && !(owner.expression.kind === ts.SyntaxKind.ThisKeyword)) {
      owner = owner.expression;
    }
    const fieldName = ts.isPropertyAccessExpression(owner) ? owner.name.text : null;
    if (className && fieldName && index?.prismaFields?.get(className)?.has(fieldName)) return true;
    // A Prisma client subclass calling itself: `this.user.findMany()`.
    if (className && index?.prismaFields?.get(className)?.has("this")) return true;
  }

  const path = callPath(callNode.expression);
  return Boolean(path) && /(^|\.)prisma(\.|$)/i.test(path);
}

function analyzeClientUsage({ sourceFile, relativePath }, index) {
  const findings = [];

  const visit = (node, loopDepth) => {
    const nextDepth = loopDepth + (isLoopLike(node) ? 1 : 0);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = callPath(node.expression) || "prisma client";
      const isPrismaCall = isPrismaClientCall(node, index);

      if (isPrismaCall && READ_MANY_METHODS.has(method)) {
        const [options] = node.arguments;
        if (!options || !objectLiteralHasKey(options, ["take", "cursor"])) {
          findings.push(createFinding({
            id: "PRISMA-010",
            category: "Database",
            severity: "MEDIUM",
            confidence: "certain",
            analyzer: ANALYZER_ID,
            title: "Unbounded findMany()",
            detail: `${target}() has no \`take\` (or cursor) argument, so it returns every matching row and its cost grows with the table.`,
            remediation: "Add `take` plus `skip`/`cursor` pagination and expose page size through the API.",
            sourceFile,
            node,
            file: relativePath
          }));
        }
      }

      if (isPrismaCall && READ_METHODS.has(method) && loopDepth > 0) {
        findings.push(createFinding({
          id: "PRISMA-011",
          category: "Performance",
          severity: "HIGH",
          confidence: "high",
          analyzer: ANALYZER_ID,
          title: "Prisma query inside a loop (N+1)",
          detail: `${target}() runs inside a loop, issuing one query per iteration instead of a single batched call.`,
          remediation: "Fetch the related rows in one call: `include`/`select` on the parent query, or `where: { id: { in: [...] } }`.",
          sourceFile,
          node,
          file: relativePath
        }));
      }

      // PRISMA-012 — nested include with no select: Prisma hydrates every
      // column of every included relation, which is where "why is this endpoint
      // slow" usually ends up.
      if (isPrismaCall && READ_METHODS.has(method)) {
        const [options] = node.arguments;
        const include = objectLiteralProperty(options, "include");
        if (include && ts.isPropertyAssignment(include) && ts.isObjectLiteralExpression(include.initializer)) {
          const depth = includeDepth(include.initializer);
          if (depth >= 2 && !objectLiteralHasKey(options, ["select"])) {
            findings.push(createFinding({
              id: "PRISMA-012",
              category: "Performance",
              severity: "MEDIUM",
              confidence: "medium",
              analyzer: ANALYZER_ID,
              title: "Deeply nested include with no field selection",
              detail: `${target}() includes relations ${depth} levels deep with no \`select\`, so every column of every related row is loaded and serialised.`,
              remediation: "Narrow the query with `select` on each level, requesting only the fields the caller actually returns.",
              sourceFile,
              node: include,
              file: relativePath
            }));
          }
        }
      }

      // PRISMA-013 — raw query through the *Unsafe* API.
      if (RAW_METHODS.has(method)) {
        findings.push(createFinding({
          id: "PRISMA-013",
          category: "Security",
          severity: "HIGH",
          confidence: "certain",
          analyzer: ANALYZER_ID,
          title: `Raw SQL through ${method}`,
          detail: `${method}(...) interpolates its SQL string directly. Prisma names it "Unsafe" precisely because no parameter binding happens.`,
          remediation: "Use the tagged-template form ($queryRaw`SELECT ... WHERE id = ${id}`), which binds parameters, or go through the typed client API.",
          sourceFile,
          node,
          file: relativePath
        }));
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  };
  visit(sourceFile, 0);

  findings.push(...checkPrismaTransactions(sourceFile, relativePath, index));
  return findings;
}

// PRISMA-014 — several writes in one function with no $transaction.
function checkPrismaTransactions(sourceFile, relativePath, index) {
  const findings = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body && !ts.isConstructorDeclaration(node)) {
      const writes = [];
      const collect = (inner) => {
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
          if (isPrismaClientCall(inner, index) && WRITE_METHODS.has(inner.expression.name.text)) writes.push(inner);
        }
        ts.forEachChild(inner, collect);
      };
      collect(node.body);
      if (writes.length >= 2) {
        const bodyText = node.body.getText(sourceFile);
        const transactional = /\$transaction\s*\(|\btx\s*\./.test(bodyText);
        if (!transactional) {
          findings.push(createFinding({
            id: "PRISMA-014",
            category: "Database",
            severity: "MEDIUM",
            confidence: "medium",
            analyzer: ANALYZER_ID,
            title: "Multiple Prisma writes without $transaction",
            detail: `This function performs ${writes.length} separate Prisma write calls with no \`prisma.$transaction(...)\`, so a failure between them leaves the data partially written.`,
            remediation: "Group the related writes into `prisma.$transaction([...])`, or the interactive form `prisma.$transaction(async (tx) => { ... })`.",
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

function includeDepth(objectLiteral, depth = 1) {
  let deepest = depth;
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
    const nested = objectLiteralProperty(property.initializer, "include");
    if (nested && ts.isPropertyAssignment(nested) && ts.isObjectLiteralExpression(nested.initializer)) {
      deepest = Math.max(deepest, includeDepth(nested.initializer, depth + 1));
    } else if (property.initializer.properties.some((entry) => propertyName(entry) === "include")) {
      deepest = Math.max(deepest, depth + 1);
    }
  }
  return deepest;
}
