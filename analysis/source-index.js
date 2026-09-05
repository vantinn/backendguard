import path from "node:path";
import ts from "typescript";

import {
  classProperties,
  decoratorName,
  findDecorator,
  firstTypeArgumentName,
  forEachClass,
  getDecoratorList,
  hasDecorator,
  propertyName,
  typeReferenceName,
  unwrapAwait
} from "./ast-utils.js";
import { collectTypeScriptFiles, readSource } from "./project-scanner.js";

/**
 * One parse of the project, shared by every analyzer.
 *
 * Before this existed each check re-walked and re-parsed the same files. The
 * index is built once per run and holds the cross-file facts analyzers need:
 * which classes are entities/controllers/DTOs, which constructor field holds
 * which repository or service, and which service methods hand back an entity.
 */

const SENSITIVE_COLUMN_PATTERN = /password|passwd|secret|refreshtoken|apikey|privatekey|accesstoken|clientsecret|ssn|creditcard|cardnumber/i;
const SENSITIVE_EXACT_NAMES = new Set(["token", "salt", "otp", "pin"]);
const REPO_READ_METHODS = new Set(["find", "findOne", "findOneBy", "findBy", "findAndCount", "findOneOrFail"]);

/**
 * Declared types that mean "this field is a TypeORM repository" and "this field
 * is a Prisma client".
 *
 * Resolution is by *type*, never by field name. An earlier version required the
 * field to be called `xRepo`/`xRepository` (TypeORM) or for the call path to
 * contain the word `prisma`, so both analyzers silently produced nothing on the
 * very common `private readonly products: Repository<Product>` and
 * `private readonly db: PrismaService` shapes.
 */
const TYPEORM_REPOSITORY_TYPES = new Set(["Repository", "TreeRepository", "MongoRepository", "EntityRepository"]);
const PRISMA_CLIENT_TYPE_PATTERN = /^(PrismaService|PrismaClient|ExtendedPrismaClient|.*PrismaService)$/;

/**
 * @param {{cwd: string, files?: string[], limits?: object}} options
 * @returns {SourceIndex}
 */
export function buildSourceIndex({ cwd, files, limits } = {}) {
  const scan = files && files.length
    ? { files: files.filter((file) => /\.m?c?ts$/.test(file) && !/\.d\.ts$/.test(file)), truncated: false, scanned: files.length }
    : collectTypeScriptFiles(cwd, { limits });

  const parsed = [];
  const unparsed = [];
  for (const relativePath of scan.files) {
    let text;
    try {
      text = readSource(cwd, relativePath, limits);
    } catch (error) {
      // Unreadable file (permissions, a broken symlink, a race with a build).
      unparsed.push({ relativePath, reason: error.code === "EACCES" ? "unreadable" : "read failed" });
      continue;
    }
    if (text === null) continue;

    // One file must not be able to end the run. The TypeScript parser is
    // recursive, so an expression nested a few thousand levels deep — which a
    // hostile or generated file can contain — overflows the stack, and that
    // `RangeError` used to propagate out of the whole analysis: a single file
    // made `backendguard analyze` fail with "This is a bug in BackendGuard".
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    } catch (error) {
      unparsed.push({
        relativePath,
        reason: error instanceof RangeError ? "too deeply nested to parse" : "could not be parsed"
      });
      continue;
    }
    parsed.push({ relativePath, text, sourceFile });
  }

  const index = {
    cwd,
    truncated: scan.truncated,
    /** Files the scanner refused to read because of their size. */
    skippedForSize: scan.skippedForSize || [],
    /** Files that were read but could not be parsed, with the reason. */
    unparsed,
    files: parsed,
    entities: new Map(),          // className -> { sensitiveColumns, allColumns, relativePath, node }
    controllers: new Map(),       // className -> { node, relativePath }
    classNodesByName: new Map(),  // className -> { node, relativePath }
    repoFieldToEntity: new Map(), // "Class.field" -> entityName
    repositoryFields: new Map(),  // className -> Set<fieldName> typed as a TypeORM repository
    prismaFields: new Map(),      // className -> Set<fieldName> typed as a Prisma client
    repositorySubclasses: new Set(), // classes extending Repository<T>: `this.find()` is a repo call
    fieldTypeByClass: new Map(),  // "Class.field" -> typeName
    methodReturnsEntity: new Map(),// "Class.method" -> { entityName, isArray }
    imports: new Map()            // relativePath -> Set<moduleSpecifier>
  };

  for (const file of parsed) collectDeclarations(index, file);
  for (const file of parsed) collectImports(index, file);
  inferEntityReturningMethods(index);
  return index;
}

function collectDeclarations(index, { relativePath, sourceFile }) {
  forEachClass(sourceFile, (classNode) => {
    const className = classNode.name?.text;
    if (!className) return;
    index.classNodesByName.set(className, { node: classNode, relativePath, sourceFile });

    if (hasDecorator(classNode, ["Entity", "ViewEntity"])) {
      const properties = classProperties(classNode);
      const columns = properties.map((property) => propertyName(property)).filter(Boolean);
      // A column annotated `@Exclude()` is stripped by the serializer before it
      // reaches a response, so it is not an exposure risk and must not drive
      // SEC-001. This is the pattern NestJS documents for exactly this problem.
      const excluded = new Set(
        properties
          .filter((property) => hasDecorator(property, ["Exclude"]))
          .map((property) => propertyName(property))
          .filter(Boolean)
      );
      index.entities.set(className, {
        relativePath,
        node: classNode,
        sourceFile,
        allColumns: columns,
        excludedColumns: [...excluded],
        sensitiveColumns: columns.filter((column) => isSensitiveColumnName(column) && !excluded.has(column))
      });
    }
    if (hasDecorator(classNode, ["Controller"])) {
      index.controllers.set(className, { node: classNode, relativePath, sourceFile });
    }

    // `class InvoiceRepository extends Repository<Invoice>` — inside it, a bare
    // `this.find(...)` is a repository call with no field to name.
    for (const clause of classNode.heritageClauses || []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const baseName = ts.isIdentifier(type.expression) ? type.expression.text : null;
        if (baseName && TYPEORM_REPOSITORY_TYPES.has(baseName)) index.repositorySubclasses.add(className);
        if (baseName && PRISMA_CLIENT_TYPE_PATTERN.test(baseName)) addTo(index.prismaFields, className, "this");
      }
    }

    const constructorNode = classNode.members.find((member) => ts.isConstructorDeclaration(member));
    if (!constructorNode) return;
    for (const parameter of constructorNode.parameters) {
      const fieldName = ts.isIdentifier(parameter.name) ? parameter.name.text : null;
      if (!fieldName || !parameter.type) continue;
      const typeName = typeReferenceName(parameter.type);
      if (typeName) index.fieldTypeByClass.set(`${className}.${fieldName}`, typeName);
      if (TYPEORM_REPOSITORY_TYPES.has(typeName)) {
        addTo(index.repositoryFields, className, fieldName);
        const entityArg = firstTypeArgumentName(parameter.type);
        if (entityArg) index.repoFieldToEntity.set(`${className}.${fieldName}`, entityArg);
      }
      if (PRISMA_CLIENT_TYPE_PATTERN.test(typeName || "")) {
        addTo(index.prismaFields, className, fieldName);
      }
    }
  });
}

function collectImports(index, { relativePath, sourceFile }) {
  const specifiers = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      specifiers.add(statement.moduleSpecifier.text);
    }
  }
  index.imports.set(relativePath, specifiers);
}

function inferEntityReturningMethods(index) {
  for (const [className, { node: classNode }] of index.classNodesByName) {
    const classRepoFields = new Map();
    for (const [key, entityName] of index.repoFieldToEntity) {
      const [owner, field] = key.split(".");
      if (owner === className) classRepoFields.set(field, entityName);
    }
    if (!classRepoFields.size) continue;
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const methodName = propertyName(member);
      if (!methodName) continue;
      const hint = findReturnedRepoCall(member.body, classRepoFields);
      if (hint) index.methodReturnsEntity.set(`${className}.${methodName}`, hint);
    }
  }
}

export function repoCallEntityHint(expression, classRepoFields) {
  const call = unwrapAwait(expression);
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const base = call.expression.expression;
  const methodName = call.expression.name.text;
  if (!ts.isPropertyAccessExpression(base) || base.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  const entityName = classRepoFields.get(base.name.text);
  if (!entityName || !(REPO_READ_METHODS.has(methodName) || methodName === "save")) return null;
  return { entityName, isArray: methodName === "find" || methodName === "findBy" };
}

/**
 * Finds a function that hands back a repository-resolved entity, either
 * directly (`return this.repo.findOne(...)`) or through a local assigned from
 * that call — the common shape once a null check sits in between.
 */
export function findReturnedRepoCall(body, classRepoFields) {
  const localHints = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const hint = repoCallEntityHint(node.initializer, classRepoFields);
      if (hint) localHints.set(node.name.text, hint);
    }
    ts.forEachChild(node, collect);
  };
  collect(body);

  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const direct = repoCallEntityHint(node.expression, classRepoFields);
      if (direct) found = direct;
      else if (ts.isIdentifier(node.expression) && localHints.has(node.expression.text)) {
        found = localHints.get(node.expression.text);
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function addTo(map, key, value) {
  const existing = map.get(key) || new Set();
  existing.add(value);
  map.set(key, existing);
}

/**
 * The class that lexically encloses a node, so a call site can be matched
 * against that class's typed repository/client fields.
 */
export function enclosingClassName(node) {
  let current = node?.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current.name?.text || null;
    current = current.parent;
  }
  return null;
}

export function isSensitiveColumnName(name) {
  const value = String(name || "");
  return SENSITIVE_COLUMN_PATTERN.test(value) || SENSITIVE_EXACT_NAMES.has(value.toLowerCase());
}

/** Every dependency name reachable from the indexed files' import statements. */
export function importedModules(index) {
  const modules = new Set();
  for (const specifiers of index.imports.values()) {
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      modules.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
    }
  }
  return modules;
}

export function fileBaseName(relativePath) {
  return path.basename(relativePath);
}

export { REPO_READ_METHODS, TYPEORM_REPOSITORY_TYPES, PRISMA_CLIENT_TYPE_PATTERN };
