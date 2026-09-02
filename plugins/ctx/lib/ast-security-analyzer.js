import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Structural (AST-based) analysis for NestJS/TypeORM source.
 *
 * This is a deliberate second layer alongside the existing heuristic,
 * diff-keyword compliance checker in measure.js. Findings here are derived
 * from actual parsed syntax (decorators, class members, generic type
 * arguments, call-expression shape) rather than substring matching against
 * rule prose, so evidence always points at the construct that actually
 * causes the finding.
 *
 * It is intentionally NOT a full semantic type-checker (no ts.Program / no
 * module resolution): entity <-> service <-> controller relationships are
 * resolved by following decorator + constructor-parameter-type syntax
 * across the file set handed in, which is enough to catch the common
 * NestJS/TypeORM shapes without the cost/fragility of building a full
 * compiler Program over an arbitrary target project.
 */

const SOURCE_EXTENSIONS = new Set([".ts"]);
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules", ".git", ".ctx", "dist", "build", "coverage",
  "test", "tests", "__tests__", "spec", "specs", "e2e", "fixtures", "__fixtures__"
]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 300_000;

const SENSITIVE_COLUMN_PATTERN = /password|secret|refreshtoken|apikey|privatekey|accesstoken|clientsecret/i;
const SENSITIVE_EXACT_NAMES = new Set(["token"]);

const HTTP_METHOD_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All"]);
const PUBLIC_ROUTE_DECORATORS = new Set(["Public", "SkipAuth", "IsPublic", "AllowAnon", "NoAuth"]);
const PUBLIC_ROUTE_NAME_PATTERN = /login|register|signup|sign-up|refresh|forgot-password|forgotpassword|reset-password|resetpassword|health|healthz|webhook/i;
const VALIDATOR_DECORATOR_PATTERN = /^(Is[A-Z]|Validate|Matches$|Length$|Min$|Max$|ArrayMinSize$|ArrayMaxSize$|MinLength$|MaxLength$|NotContains$|Contains$|Equals$|NotEquals$|IsOptional$)/;
const SECRET_PROPERTY_NAME_PATTERN = /^(secret|secretorkey|apikey|api_key|privatekey|private_key|clientsecret|client_secret|accesskeyid|access_key_id)$/i;
const REPO_FIELD_NAME_PATTERN = /repo(sitory)?$/i;
const REPO_WRITE_METHODS = new Set(["save", "remove", "insert", "update", "delete", "softDelete", "softRemove"]);
const REPO_READ_METHODS = new Set(["find", "findOne", "findOneBy", "findBy"]);

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

export function collectProjectSourceFiles(cwd) {
  const files = [];
  walk(cwd, cwd, files);
  return files.slice(0, MAX_FILES);
}

function walk(root, dir, files) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, fullPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      files.push(path.relative(root, fullPath));
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * @param {{cwd: string, files?: string[]}} options - files are project-relative paths;
 *   when omitted, the whole project (bounded) is scanned.
 * @returns {Array<Finding>}
 */
export function analyzeProjectSource({ cwd, files } = {}) {
  const relativeFiles = files && files.length ? files.filter((f) => f.endsWith(".ts")) : collectProjectSourceFiles(cwd);
  const parsed = [];
  for (const relativePath of relativeFiles) {
    const absolutePath = path.join(cwd, relativePath);
    let text;
    try {
      text = fs.readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsed.push({ relativePath, sourceFile });
  }

  const index = buildProjectIndex(parsed);

  const findings = [];
  for (const { relativePath, sourceFile } of parsed) {
    findings.push(...checkMissingGuards(sourceFile, relativePath));
    findings.push(...checkHardcodedSecrets(sourceFile, relativePath));
    findings.push(...checkUnvalidatedBody(sourceFile, relativePath, index));
    findings.push(...checkRepositoryQueryRisks(sourceFile, relativePath));
    findings.push(...checkSensitiveEntityExposure(sourceFile, relativePath, index));
    findings.push(...checkRawErrorExposure(sourceFile, relativePath));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Project index: entities, DTOs, controller/service field->class wiring,
// and lightweight "this method plausibly returns entity X" hints.
// ---------------------------------------------------------------------------

function buildProjectIndex(parsedFiles) {
  const entities = new Map(); // className -> { sensitiveColumns: string[] }
  const classNodesByName = new Map(); // className -> { node, relativePath }
  const repoFieldToEntity = new Map(); // "ClassName.fieldName" -> entityName
  const fieldTypeByClass = new Map(); // "ClassName.fieldName" -> typeName (constructor param types, any class)
  const methodReturnsEntity = new Map(); // "ClassName.methodName" -> { entityName, isArray }

  for (const { relativePath, sourceFile } of parsedFiles) {
    forEachClass(sourceFile, (classNode) => {
      const className = classNode.name?.text;
      if (!className) return;
      classNodesByName.set(className, { node: classNode, relativePath });

      if (hasDecorator(classNode, ["Entity"])) {
        const columns = classProperties(classNode).map((p) => propertyName(p)).filter(Boolean);
        const sensitiveColumns = columns.filter(isSensitiveColumnName);
        entities.set(className, { sensitiveColumns, allColumns: columns });
      }

      // Constructor parameter properties: `private readonly x: SomeType` /
      // `@InjectRepository(Entity) private x: Repository<Entity>`.
      const ctor = classNode.members.find((m) => ts.isConstructorDeclaration(m));
      if (ctor) {
        for (const param of ctor.parameters) {
          const fieldName = ts.isIdentifier(param.name) ? param.name.text : null;
          if (!fieldName || !param.type) continue;
          const typeName = typeReferenceName(param.type);
          if (typeName) fieldTypeByClass.set(`${className}.${fieldName}`, typeName);
          if (typeName === "Repository") {
            const entityArg = firstTypeArgumentName(param.type);
            if (entityArg) repoFieldToEntity.set(`${className}.${fieldName}`, entityArg);
          }
        }
      }
    });
  }

  // Second pass: infer method -> entity return hints for classes with repo fields.
  for (const [className, { node: classNode }] of classNodesByName) {
    const classRepoFields = new Map();
    for (const [key, entityName] of repoFieldToEntity) {
      const [owner, field] = key.split(".");
      if (owner === className) classRepoFields.set(field, entityName);
    }
    if (!classRepoFields.size) continue;

    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      const methodName = propertyName(member);
      if (!methodName) continue;
      const hint = findReturnedRepoCall(member.body, classRepoFields);
      if (hint) methodReturnsEntity.set(`${className}.${methodName}`, hint);
    }
  }

  return { entities, classNodesByName, repoFieldToEntity, fieldTypeByClass, methodReturnsEntity };
}

function repoCallEntityHint(expr, classRepoFields) {
  const call = unwrapAwait(expr);
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const base = call.expression.expression;
  const methodName = call.expression.name.text;
  if (!ts.isPropertyAccessExpression(base) || base.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  const entityName = classRepoFields.get(base.name.text);
  if (!entityName || !(REPO_READ_METHODS.has(methodName) || methodName === "save")) return null;
  return { entityName, isArray: methodName === "find" };
}

/**
 * Looks for a function that returns a repo-resolved entity, either directly
 * (`return this.<repoField>.findOne(...)`) or via a local variable assigned
 * from that call earlier in the same body (`const user = await this.<repoField>.findOne(...); ...; return user;`),
 * which is the more common shape once there's a null-check in between.
 */
function findReturnedRepoCall(body, classRepoFields) {
  const localVarHints = new Map();
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const hint = repoCallEntityHint(node.initializer, classRepoFields);
      if (hint) localVarHints.set(node.name.text, hint);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(body);

  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const direct = repoCallEntityHint(node.expression, classRepoFields);
      if (direct) {
        found = direct;
      } else if (ts.isIdentifier(node.expression) && localVarHints.has(node.expression.text)) {
        found = localVarHints.get(node.expression.text);
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

// ---------------------------------------------------------------------------
// SEC-002: missing authentication guard on a route handler
// ---------------------------------------------------------------------------

function checkMissingGuards(sourceFile, relativePath) {
  const findings = [];
  forEachClass(sourceFile, (classNode) => {
    if (!hasDecorator(classNode, ["Controller"])) return;
    const classGuarded = hasDecorator(classNode, ["UseGuards"]) || hasDecorator(classNode, [...PUBLIC_ROUTE_DECORATORS]);
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const httpDecorator = findDecorator(member, [...HTTP_METHOD_DECORATORS]);
      if (!httpDecorator) continue;
      const methodGuarded = hasDecorator(member, ["UseGuards"]) || hasDecorator(member, [...PUBLIC_ROUTE_DECORATORS]);
      const routePath = firstStringLiteralArg(httpDecorator) || "";
      const methodName = propertyName(member) || "";
      const publicByConvention = PUBLIC_ROUTE_NAME_PATTERN.test(routePath) || PUBLIC_ROUTE_NAME_PATTERN.test(methodName);
      if (classGuarded || methodGuarded || publicByConvention) continue;
      // A GET with no guard is common and often intentional (a public catalog/listing
      // endpoint) — real signal, but much weaker than a state-changing verb with no
      // guard, so it's reported at lower severity/confidence rather than suppressed.
      const isStateChanging = decoratorName(httpDecorator) !== "Get";
      findings.push(makeFinding({
        id: "SEC-002",
        category: "Security",
        severity: isStateChanging ? "HIGH" : "MEDIUM",
        confidence: isStateChanging ? "high-structural" : "low-structural",
        title: "Route handler has no authentication guard",
        detail: `${classNode.name?.text || "Controller"}.${methodName}() handles ${httpDecorator ? decoratorName(httpDecorator) : "a route"} but has no @UseGuards(...) at the method or class level, and its name/path doesn't match a known-public pattern.${isStateChanging ? "" : " (GET handlers are sometimes intentionally public — verify before treating this as a bug.)"}`,
        remediation: "Add @UseGuards(<AuthGuard>) at the method or controller level, or mark the route explicitly public if it's meant to be unauthenticated.",
        sourceFile,
        node: member.name || member
      }, relativePath));
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// SEC-003: hardcoded secret literal
// ---------------------------------------------------------------------------

function checkHardcodedSecrets(sourceFile, relativePath) {
  const findings = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name && SECRET_PROPERTY_NAME_PATTERN.test(name) && ts.isStringLiteralLike(node.initializer) && node.initializer.text.trim().length > 0) {
        findings.push(makeFinding({
          id: "SEC-003",
          category: "Security",
          severity: "HIGH",
          confidence: "high-structural",
          title: "Hardcoded secret literal",
          detail: `Property "${name}" is assigned a plain string literal instead of an environment/config-sourced value.`,
          remediation: "Read this value from process.env (or a ConfigService) instead of hardcoding it in source.",
          sourceFile,
          node
        }, relativePath));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SEC-004: unvalidated @Body()
// ---------------------------------------------------------------------------

function checkUnvalidatedBody(sourceFile, relativePath, index) {
  const findings = [];
  forEachClass(sourceFile, (classNode) => {
    if (!hasDecorator(classNode, ["Controller"])) return;
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      if (!findDecorator(member, [...HTTP_METHOD_DECORATORS])) continue;
      for (const param of member.parameters) {
        if (!hasDecorator(param, ["Body"])) continue;
        const paramLabel = ts.isIdentifier(param.name) ? param.name.text : "body";
        if (!param.type || param.type.kind === ts.SyntaxKind.AnyKeyword) {
          findings.push(makeFinding({
            id: "SEC-004",
            category: "Security",
            severity: "MEDIUM",
            confidence: "high-structural",
            title: "@Body() parameter has no DTO type",
            detail: `Parameter "${paramLabel}" is typed \`any\` (or untyped), so no request-body validation runs before the handler executes.`,
            remediation: "Type the parameter with a DTO class validated by class-validator (e.g. `@Body() dto: CreateUserDto`), and enable a global/route ValidationPipe.",
            sourceFile,
            node: param
          }, relativePath));
          continue;
        }
        const dtoName = typeReferenceName(param.type);
        if (!dtoName) continue;
        const dtoEntry = index.classNodesByName.get(dtoName);
        if (!dtoEntry) continue; // imported from elsewhere / unresolved — don't guess
        const dtoHasValidation = classProperties(dtoEntry.node).some((prop) =>
          getDecoratorList(prop).some((d) => VALIDATOR_DECORATOR_PATTERN.test(decoratorName(d) || ""))
        );
        if (!dtoHasValidation && classProperties(dtoEntry.node).length > 0) {
          findings.push(makeFinding({
            id: "SEC-004",
            category: "Security",
            severity: "MEDIUM",
            confidence: "high-structural",
            title: "DTO has no class-validator decorators",
            detail: `"${dtoName}" is used as a @Body() DTO but none of its properties carry a class-validator decorator (e.g. @IsString, @IsEmail), so invalid input is not rejected before reaching the handler.`,
            remediation: "Add class-validator decorators to each property of the DTO, and ensure a ValidationPipe is applied.",
            sourceFile,
            node: param
          }, relativePath));
        }
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// DB-001 unbounded find(), DB-002 N+1, DB-003 missing transaction
// ---------------------------------------------------------------------------

function checkRepositoryQueryRisks(sourceFile, relativePath) {
  const findings = [];

  // DB-001 / DB-002: walk every call expression.
  const visitCalls = (node, loopDepth) => {
    const nextLoopDepth = loopDepth + (isLoopLike(node) ? 1 : 0);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const baseName = repoBaseName(node.expression.expression);
      const methodName = node.expression.name.text;
      if (baseName && REPO_FIELD_NAME_PATTERN.test(baseName)) {
        if (methodName === "find") {
          const firstArg = node.arguments[0];
          const isPredicateFn = firstArg && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg));
          if (!isPredicateFn) {
            const hasPagination = firstArg && ts.isObjectLiteralExpression(firstArg) &&
              firstArg.properties.some((p) => propertyName(p) === "take" || propertyName(p) === "skip" || propertyName(p) === "cursor");
            if (!hasPagination) {
              findings.push(makeFinding({
                id: "DB-001",
                category: "Database",
                severity: "MEDIUM",
                confidence: "high-structural",
                title: "Unbounded repository query",
                detail: `${baseName}.find(${firstArg ? "..." : ""}) has no take/skip (or cursor) option, so it can return the entire table as the table grows.`,
                remediation: "Add pagination (`take`/`skip`, or a cursor-based query) to this call.",
                sourceFile,
                node
              }, relativePath));
            }
          }
        }
        if (REPO_READ_METHODS.has(methodName) && loopDepth > 0) {
          findings.push(makeFinding({
            id: "DB-002",
            category: "Database",
            severity: "MEDIUM",
            confidence: "high-structural",
            title: "Repository query inside a loop (N+1 pattern)",
            detail: `${baseName}.${methodName}(...) is called from inside a loop, issuing one query per iteration instead of a single batched query.`,
            remediation: "Replace the per-iteration call with a single query using `relations`/a query-builder `join`, or `In(...)` for a batched lookup.",
            sourceFile,
            node
          }, relativePath));
        }
      }
    }
    ts.forEachChild(node, (child) => visitCalls(child, nextLoopDepth));
  };
  visitCalls(sourceFile, 0);

  // DB-003: per-function, count distinct repo write calls not textually wrapped in a transaction.
  const visitFunctions = (node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
      const writeCalls = [];
      const collect = (n) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const baseName = repoBaseName(n.expression.expression);
          const methodName = n.expression.name.text;
          if (baseName && REPO_FIELD_NAME_PATTERN.test(baseName) && REPO_WRITE_METHODS.has(methodName)) {
            writeCalls.push(n);
          }
        }
        ts.forEachChild(n, collect);
      };
      collect(node.body);
      const bodyText = node.body.getText(sourceFile);
      const looksTransactional = /\.transaction\s*\(|queryRunner/i.test(bodyText);
      if (writeCalls.length >= 2 && !looksTransactional) {
        findings.push(makeFinding({
          id: "DB-003",
          category: "Database",
          severity: "MEDIUM",
          confidence: "medium-structural",
          title: "Multiple writes without a transaction boundary",
          detail: `This function makes ${writeCalls.length} separate repository write calls with no enclosing \`dataSource.transaction(...)\` or \`queryRunner\`, so a failure partway through can leave data inconsistent.`,
          remediation: "Wrap the related writes in a single `dataSource.transaction(async (manager) => { ... })` or an explicit QueryRunner transaction.",
          sourceFile,
          node: writeCalls[0]
        }, relativePath));
      }
    }
    ts.forEachChild(node, visitFunctions);
  };
  visitFunctions(sourceFile);

  return findings;
}

function isLoopLike(node) {
  return ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["forEach", "map"].includes(node.expression.name.text) &&
      node.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
}

function repoBaseName(expression) {
  if (ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expression.name.text;
  }
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

// ---------------------------------------------------------------------------
// SEC-005: raw error.stack / error.message built into a response payload
// ---------------------------------------------------------------------------

function checkRawErrorExposure(sourceFile, relativePath) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      const catchVarName = node.variableDeclaration.name.text;
      const visitBlock = (inner) => {
        if (ts.isObjectLiteralExpression(inner)) {
          for (const prop of inner.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const propName = propertyName(prop);
            if (propName !== "stack" && propName !== "message") continue;
            if (isPropertyAccessOf(prop.initializer, catchVarName, propName)) {
              findings.push(makeFinding({
                id: "SEC-005",
                category: "Security",
                severity: "MEDIUM",
                confidence: "high-structural",
                title: `Raw error.${propName} built into a response payload`,
                detail: `A response/thrown object literal includes "${propName}: ${catchVarName}.${propName}" directly from the caught error, which can leak internal implementation details (stack traces, query text, file paths) to the client.`,
                remediation: "Log the full error server-side and return a generic, safe error message/code to the client instead of the raw error object.",
                sourceFile,
                node: prop
              }, relativePath));
            }
          }
        }
        ts.forEachChild(inner, visitBlock);
      };
      if (node.block) visitBlock(node.block);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function isPropertyAccessOf(expr, baseName, propName) {
  return ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) && expr.expression.text === baseName &&
    expr.name.text === propName;
}

// ---------------------------------------------------------------------------
// SEC-001: sensitive entity/columns returned from a controller without a DTO
// ---------------------------------------------------------------------------

function checkSensitiveEntityExposure(sourceFile, relativePath, index) {
  const findings = [];
  forEachClass(sourceFile, (classNode) => {
    if (!hasDecorator(classNode, ["Controller"])) return;
    const className = classNode.name?.text;
    if (!className) return;

    // field -> service class name, from constructor parameter types.
    const serviceFields = new Map();
    for (const [key, typeName] of index.fieldTypeByClass) {
      const [owner, field] = key.split(".");
      if (owner === className) serviceFields.set(field, typeName);
    }
    if (!serviceFields.size) return;

    const serviceCallHint = (expr) => {
      const call = unwrapAwait(expr);
      if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
      const base = call.expression.expression;
      const methodName = call.expression.name.text;
      if (!ts.isPropertyAccessExpression(base) || base.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
      const serviceClass = serviceFields.get(base.name.text);
      if (!serviceClass) return null;
      const hint = index.methodReturnsEntity.get(`${serviceClass}.${methodName}`);
      return hint ? { serviceClass, methodName, ...hint } : null;
    };

    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      if (!findDecorator(member, [...HTTP_METHOD_DECORATORS])) continue;

      const returnTypeMentionsDto = member.type ? /Dto\b/.test(member.type.getText(sourceFile)) : false;
      if (returnTypeMentionsDto) continue;

      // A local variable assigned directly from a service call earlier in the
      // handler, then returned bare, resolves the same way as a direct return.
      const localVarHints = new Map();
      const collectDeclarations = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const hint = serviceCallHint(node.initializer);
          if (hint) localVarHints.set(node.name.text, hint);
        }
        ts.forEachChild(node, collectDeclarations);
      };
      collectDeclarations(member.body);

      const visit = (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
          const hint = serviceCallHint(node.expression) ||
            (ts.isIdentifier(node.expression) ? localVarHints.get(node.expression.text) : null);
          if (hint) {
            const entity = index.entities.get(hint.entityName);
            if (entity && entity.sensitiveColumns.length) {
              findings.push(makeFinding({
                id: "SEC-001",
                category: "Security",
                severity: "HIGH",
                confidence: "medium-structural",
                title: "Sensitive entity field may be exposed in an API response",
                detail: `${className}.${propertyName(member)}() returns ${hint.serviceClass}.${hint.methodName}()'s result. That resolves to the "${hint.entityName}" entity, which has sensitive column(s) [${entity.sensitiveColumns.join(", ")}], and the handler's return type doesn't reference a *Dto class.`,
                remediation: `Map the result to a response DTO that excludes ${entity.sensitiveColumns.join("/")} before returning it.`,
                sourceFile,
                node
              }, relativePath));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(member.body);
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Shared AST helpers
// ---------------------------------------------------------------------------

function forEachClass(sourceFile, callback) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function classProperties(classNode) {
  return classNode.members.filter((m) => ts.isPropertyDeclaration(m));
}

function propertyName(node) {
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function getDecoratorList(node) {
  if (ts.canHaveDecorators && ts.canHaveDecorators(node)) {
    return ts.getDecorators(node) || [];
  }
  return node.decorators || [];
}

function decoratorName(decorator) {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function findDecorator(node, names) {
  return getDecoratorList(node).find((d) => names.includes(decoratorName(d) || "")) || null;
}

function hasDecorator(node, names) {
  return Boolean(findDecorator(node, names));
}

function firstStringLiteralArg(decorator) {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr) || !expr.arguments.length) return null;
  const arg = expr.arguments[0];
  return ts.isStringLiteralLike(arg) ? arg.text : null;
}

function isSensitiveColumnName(name) {
  const lower = name.toLowerCase();
  return SENSITIVE_COLUMN_PATTERN.test(lower) || SENSITIVE_EXACT_NAMES.has(lower);
}

function typeReferenceName(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) return typeNode.typeName.text;
  return null;
}

function firstTypeArgumentName(typeNode) {
  if (!ts.isTypeReferenceNode(typeNode) || !typeNode.typeArguments?.length) return null;
  return typeReferenceName(typeNode.typeArguments[0]);
}

function unwrapAwait(expr) {
  return ts.isAwaitExpression(expr) ? expr.expression : expr;
}

function makeFinding({ id, category, severity, confidence, title, detail, remediation, sourceFile, node }, relativePath) {
  const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
  return {
    id,
    category,
    severity,
    confidence,
    title,
    detail,
    remediation,
    file: relativePath,
    line: line + 1
  };
}

/**
 * Adapts structural findings into the same `{ rule, status, kind, evidence, ... }`
 * shape checkCompliance() produces, so reporter.js can merge both sources into one
 * report without a parallel rendering path. Structural findings always land in the
 * "ignored" bucket — they are concrete detections, not rule-relevance guesses.
 */
/**
 * Runs structural analysis over the whole project (needed so cross-file
 * resolution like entity <-> service <-> controller works even when only the
 * controller changed) but only returns compliance items for files that are
 * part of the current diff, so `backendguard check`/the Stop hook report
 * stays scoped to "what does the current change introduce or leave behind"
 * rather than flooding every run with pre-existing findings in untouched code.
 * Fails open (returns []) on any analysis error — this must never break the
 * rest of the compliance report.
 */
export function structuralComplianceForChangedFiles({ cwd, changedFiles = [] } = {}) {
  if (!changedFiles.length) return [];
  try {
    const changedSet = new Set(changedFiles);
    const findings = analyzeProjectSource({ cwd }).filter((finding) => changedSet.has(finding.file));
    return toComplianceItems(findings);
  } catch {
    return [];
  }
}

export function toComplianceItems(findings) {
  return findings.map((finding) => ({
    rule: {
      id: finding.id,
      sourcePath: "structural-analysis",
      content: `${finding.title}. ${finding.detail}`,
      structural: true,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      remediation: finding.remediation
    },
    status: "ignored",
    kind: "structural",
    keywords: [],
    evidence: `${finding.file}:${finding.line}`,
    matchedLines: [{ file: finding.file, line: finding.line, content: finding.detail }]
  }));
}
