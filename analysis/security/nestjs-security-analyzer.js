import ts from "typescript";

import {
  classProperties,
  decoratorName,
  findDecorator,
  firstStringLiteralArg,
  getDecoratorList,
  hasDecorator,
  isEnvironmentSourced,
  objectLiteralProperty,
  propertyName,
  typeReferenceName,
  unwrapAwait
} from "../ast-utils.js";
import { createFinding } from "../finding.js";
import { buildSourceIndex } from "../source-index.js";
import { classifySecretLiteral, matchesKnownCredentialFormat } from "./secret-detection.js";

/**
 * Structural security analysis for NestJS/Express TypeScript backends.
 *
 * Every check answers a question about *parsed syntax* — which decorators a
 * route carries, what a handler returns, whether a value came from the
 * environment — so the evidence always points at the construct that caused the
 * finding. Nothing here matches rule prose against diff text; that is a
 * separate, deliberately weaker layer in `compliance/rule-compliance.js`.
 *
 * Checks that need a *specific* ORM live in the database analyzers instead, so
 * a project using Prisma never receives TypeORM-shaped advice.
 */

const ANALYZER_ID = "nestjs-security";

const HTTP_METHOD_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All"]);
const PUBLIC_ROUTE_DECORATORS = new Set(["Public", "SkipAuth", "IsPublic", "AllowAnon", "NoAuth"]);
const PUBLIC_ROUTE_NAME_PATTERN = /login|register|signup|sign-up|refresh|forgot-password|forgotpassword|reset-password|resetpassword|health|healthz|readiness|liveness|webhook|metrics/i;
const AUTH_ROUTE_NAME_PATTERN = /login|signin|sign-in|register|signup|sign-up|forgot-password|forgotpassword|reset-password|resetpassword|verify-otp|token/i;
const VALIDATOR_DECORATOR_PATTERN = /^(Is[A-Z]|Validate|Matches$|Length$|Min$|Max$|ArrayMinSize$|ArrayMaxSize$|MinLength$|MaxLength$|NotContains$|Contains$|Equals$|NotEquals$|IsOptional$|Type$|Transform$)/;
const SECRET_PROPERTY_NAME_PATTERN = /^(secret|secretorkey|apikey|api_key|privatekey|private_key|clientsecret|client_secret|accesskeyid|access_key_id|password|passphrase)$/i;
const RATE_LIMIT_DECORATORS = new Set(["Throttle", "UseGuards", "RateLimit"]);
const RATE_LIMIT_GUARD_PATTERN = /throttl|ratelimit|rate_limit/i;

export const nestjsSecurityAnalyzer = {
  id: ANALYZER_ID,
  title: "NestJS / HTTP security",
  categories: ["Security"],
  analyze({ index }) {
    const findings = [];
    for (const file of index.files) {
      findings.push(...checkMissingGuards(file, index));
      findings.push(...checkHardcodedSecrets(file));
      findings.push(...checkUnvalidatedBody(file, index));
      findings.push(...checkRawErrorExposure(file));
      findings.push(...checkSensitiveEntityExposure(file, index));
      findings.push(...checkPermissiveCors(file));
      findings.push(...checkMissingRateLimit(file));
      findings.push(...checkUnsafeCommandExecution(file));
      findings.push(...checkRequestControlledFilePath(file));
    }
    return findings;
  }
};

/**
 * Backwards-compatible entrypoint: parses a project and runs only the security
 * checks. `analysis/index.js` is the full pipeline; this is kept because the
 * security checks are useful on their own and are exercised directly by tests.
 */
export function analyzeProjectSource({ cwd, files, index } = {}) {
  const sourceIndex = index || buildSourceIndex({ cwd, files });
  return nestjsSecurityAnalyzer.analyze({ index: sourceIndex });
}

// ---------------------------------------------------------------------------
// SEC-002 — route handler with no authentication guard
// ---------------------------------------------------------------------------

function checkMissingGuards({ sourceFile, relativePath }) {
  const findings = [];
  eachController(sourceFile, (classNode) => {
    const classGuarded = hasDecorator(classNode, ["UseGuards"]) || hasDecorator(classNode, [...PUBLIC_ROUTE_DECORATORS]);
    const controllerPath = controllerBasePath(classNode);
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const httpDecorator = findDecorator(member, [...HTTP_METHOD_DECORATORS]);
      if (!httpDecorator) continue;
      const methodGuarded = hasDecorator(member, ["UseGuards"]) || hasDecorator(member, [...PUBLIC_ROUTE_DECORATORS]);
      const methodName = propertyName(member) || "";
      // The route is the controller prefix plus the method path. Matching only
      // the method path missed `@Controller("webhooks/stripe")` + `@Post()`,
      // `@Controller("auth/login")` + `@Post()`, and every other controller
      // that carries the meaningful segment.
      const routePath = joinRoute(controllerPath, firstStringLiteralArg(httpDecorator));
      const publicByConvention = PUBLIC_ROUTE_NAME_PATTERN.test(routePath) || PUBLIC_ROUTE_NAME_PATTERN.test(methodName);
      if (classGuarded || methodGuarded || publicByConvention) continue;

      // A GET with no guard is frequently intentional (a public catalog). It is
      // still real signal, so it is reported — at a severity/confidence that
      // says "check this", not "this is a bug".
      const isStateChanging = decoratorName(httpDecorator) !== "Get";
      findings.push(createFinding({
        id: "SEC-002",
        category: "Security",
        severity: isStateChanging ? "HIGH" : "MEDIUM",
        confidence: isStateChanging ? "high" : "low",
        analyzer: ANALYZER_ID,
        title: "Route handler has no authentication guard",
        detail: `${classNode.name?.text || "Controller"}.${methodName}() handles ${decoratorName(httpDecorator)} but has no @UseGuards(...) at the method or class level, and its name/path doesn't match a known-public pattern.${isStateChanging ? "" : " (GET handlers are sometimes intentionally public — verify before treating this as a bug.)"}`,
        remediation: "Add @UseGuards(<AuthGuard>) at the method or controller level, or mark the route explicitly public if it's meant to be unauthenticated.",
        sourceFile,
        node: member.name || member,
        file: relativePath
      }));
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// SEC-003 — hardcoded secret literal
// ---------------------------------------------------------------------------

function checkHardcodedSecrets({ sourceFile, relativePath }) {
  const findings = [];
  const reported = new Set();

  const report = ({ node, confidence, reason, name }) => {
    // One literal, one finding: a key assigned once and referenced later must
    // not be counted twice, and the two passes below can reach the same node.
    const key = `${node.getStart(sourceFile)}`;
    if (reported.has(key)) return;
    reported.add(key);
    findings.push(createFinding({
      id: "SEC-003",
      category: "Security",
      severity: "HIGH",
      confidence,
      analyzer: ANALYZER_ID,
      title: "Hardcoded credential",
      detail: name
        ? `Property "${name}" is assigned a literal credential: ${reason}. It lives in version control and in every build artefact.`
        : `A literal credential is committed here: ${reason}. It lives in version control and in every build artefact.`,
      remediation: "Read this value from process.env (or a ConfigService) instead of hardcoding it, and rotate the committed credential — it must be treated as compromised.",
      sourceFile,
      node,
      file: relativePath
    }));
  };

  // Pass 1: any string literal whose *format* identifies it as a credential.
  // Issuer-defined formats cannot collide with an env var or header name, so
  // they need no corroborating property name — and a real leak is written as
  // `const STRIPE_KEY = "sk_live_..."`, which the property-name pass misses.
  const visitLiterals = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const match = matchesKnownCredentialFormat(node.text);
      if (match) report({ node, confidence: "certain", reason: `the value matches the format of ${match.what}` });
    }
    ts.forEachChild(node, visitLiterals);
  };
  visitLiterals(sourceFile);

  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      const initializer = node.initializer;
      if (name && SECRET_PROPERTY_NAME_PATTERN.test(name) && ts.isStringLiteralLike(initializer)) {
        // A secret-shaped property name is not evidence on its own: config maps
        // routinely hold environment-variable names, header names and defaults
        // under exactly these keys. The *value* has to look like a credential.
        const verdict = classifySecretLiteral(initializer.text, { propertyName: name });
        if (verdict.isCredential) {
          report({ node: initializer, confidence: verdict.confidence, reason: verdict.reason, name });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------------
// SEC-004 — unvalidated request body
// ---------------------------------------------------------------------------

function checkUnvalidatedBody({ sourceFile, relativePath }, index) {
  const findings = [];
  eachController(sourceFile, (classNode) => {
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      if (!findDecorator(member, [...HTTP_METHOD_DECORATORS])) continue;
      for (const parameter of member.parameters) {
        if (!hasDecorator(parameter, ["Body"])) continue;
        const label = ts.isIdentifier(parameter.name) ? parameter.name.text : "body";
        if (!parameter.type || parameter.type.kind === ts.SyntaxKind.AnyKeyword) {
          findings.push(createFinding({
            id: "SEC-004",
            category: "Security",
            severity: "MEDIUM",
            confidence: "certain",
            analyzer: ANALYZER_ID,
            title: "@Body() parameter has no DTO type",
            detail: `Parameter "${label}" is typed \`any\` (or untyped), so no request-body validation runs before the handler executes.`,
            remediation: "Type the parameter with a DTO class validated by class-validator (e.g. `@Body() dto: CreateUserDto`), and enable a global/route ValidationPipe.",
            sourceFile,
            node: parameter,
            file: relativePath
          }));
          continue;
        }
        const dtoName = typeReferenceName(parameter.type);
        if (!dtoName) continue;
        const dtoEntry = index.classNodesByName.get(dtoName);
        if (!dtoEntry) continue; // declared elsewhere and unresolved — don't guess
        const properties = classProperties(dtoEntry.node);
        if (!properties.length) continue;
        const validated = properties.some((property) =>
          getDecoratorList(property).some((decorator) => VALIDATOR_DECORATOR_PATTERN.test(decoratorName(decorator) || ""))
        );
        if (!validated) {
          findings.push(createFinding({
            id: "SEC-004",
            category: "Security",
            severity: "MEDIUM",
            confidence: "high",
            analyzer: ANALYZER_ID,
            title: "DTO has no class-validator decorators",
            detail: `"${dtoName}" is used as a @Body() DTO but none of its ${properties.length} properties carry a class-validator decorator (e.g. @IsString, @IsEmail), so invalid input is not rejected before reaching the handler.`,
            remediation: "Add class-validator decorators to each property of the DTO, and ensure a ValidationPipe is applied.",
            sourceFile,
            node: parameter,
            file: relativePath
          }));
        }
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// SEC-005 — raw error detail returned to the client
// ---------------------------------------------------------------------------

function checkRawErrorExposure({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      const catchVar = node.variableDeclaration.name.text;
      const visitBlock = (inner) => {
        if (ts.isObjectLiteralExpression(inner)) {
          for (const property of inner.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = propertyName(property);
            if (name !== "stack" && name !== "message") continue;
            if (!isPropertyAccessOf(property.initializer, catchVar, name)) continue;
            findings.push(createFinding({
              id: "SEC-005",
              category: "Security",
              severity: "MEDIUM",
              confidence: "high",
              analyzer: ANALYZER_ID,
              title: `Raw error.${name} built into a response payload`,
              detail: `A response/thrown object literal includes "${name}: ${catchVar}.${name}" directly from the caught error, which can leak internal implementation details (stack traces, query text, file paths) to the client.`,
              remediation: "Log the full error server-side and return a generic, safe error message/code to the client instead of the raw error object.",
              sourceFile,
              node: property,
              file: relativePath
            }));
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

function isPropertyAccessOf(expression, baseName, propertyText) {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === baseName
    && expression.name.text === propertyText;
}

// ---------------------------------------------------------------------------
// SEC-001 — sensitive entity field reachable through an API response
// ---------------------------------------------------------------------------

function checkSensitiveEntityExposure({ sourceFile, relativePath }, index) {
  const findings = [];
  eachController(sourceFile, (classNode) => {
    const className = classNode.name?.text;
    if (!className) return;

    const serviceFields = new Map();
    for (const [key, typeName] of index.fieldTypeByClass) {
      const [owner, field] = key.split(".");
      if (owner === className) serviceFields.set(field, typeName);
    }
    if (!serviceFields.size) return;

    const serviceCallHint = (expression) => {
      const call = unwrapAwait(expression);
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
      if (member.type && /Dto\b/.test(member.type.getText(sourceFile))) continue;
      if (hasDecorator(member, ["SerializeOptions"]) || hasDecorator(classNode, ["SerializeOptions"])) continue;
      // `@UseInterceptors(ClassSerializerInterceptor)` plus `@Exclude()` on the
      // sensitive columns is the pattern NestJS documents. Flagging it told
      // users their correct implementation was a leak.
      if (usesClassSerializer(classNode, sourceFile) || usesClassSerializer(member, sourceFile)) continue;

      const localHints = new Map();
      const collect = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const hint = serviceCallHint(node.initializer);
          if (hint) localHints.set(node.name.text, hint);
        }
        ts.forEachChild(node, collect);
      };
      collect(member.body);

      const visit = (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
          const hint = serviceCallHint(node.expression)
            || (ts.isIdentifier(node.expression) ? localHints.get(node.expression.text) : null);
          const entity = hint && index.entities.get(hint.entityName);
          if (entity && entity.sensitiveColumns.length) {
            findings.push(createFinding({
              id: "SEC-001",
              category: "Security",
              severity: "HIGH",
              confidence: "medium",
              analyzer: ANALYZER_ID,
              title: "Sensitive entity field may be exposed in an API response",
              detail: `${className}.${propertyName(member)}() returns ${hint.serviceClass}.${hint.methodName}()'s result. That resolves to the "${hint.entityName}" entity, which has sensitive column(s) [${entity.sensitiveColumns.join(", ")}], and the handler's return type doesn't reference a *Dto class.`,
              remediation: `Map the result to a response DTO that excludes ${entity.sensitiveColumns.join("/")} before returning it, or annotate those columns with @Exclude() and enable ClassSerializerInterceptor.`,
              sourceFile,
              node,
              file: relativePath
            }));
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
// SEC-006 — CORS configured to reflect any origin while allowing credentials
// ---------------------------------------------------------------------------

function checkPermissiveCors({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const originProperty = objectLiteralProperty(node, "origin");
      const credentialsProperty = objectLiteralProperty(node, "credentials");
      if (originProperty && credentialsProperty && ts.isPropertyAssignment(originProperty) && ts.isPropertyAssignment(credentialsProperty)) {
        const originText = originProperty.initializer.getText(sourceFile).trim();
        const credentialsOn = credentialsProperty.initializer.kind === ts.SyntaxKind.TrueKeyword;
        const wildcardOrigin = /^["'`]\*["'`]$/.test(originText) || originText === "true";
        if (credentialsOn && wildcardOrigin) {
          findings.push(createFinding({
            id: "SEC-006",
            category: "Security",
            severity: "HIGH",
            confidence: "certain",
            analyzer: ANALYZER_ID,
            title: "CORS allows any origin together with credentials",
            detail: `CORS is configured with origin ${originText} and credentials: true, so any site a logged-in user visits can call this API with their cookies attached.`,
            remediation: "Replace the wildcard with an explicit allowlist of trusted origins (read from configuration), or turn credentials off.",
            sourceFile,
            node,
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
// SEC-007 — authentication endpoint with no rate limiting
// ---------------------------------------------------------------------------

function checkMissingRateLimit({ sourceFile, relativePath }) {
  const findings = [];
  eachController(sourceFile, (classNode) => {
    const classThrottled = isThrottled(classNode, sourceFile);
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const httpDecorator = findDecorator(member, [...HTTP_METHOD_DECORATORS]);
      if (!httpDecorator) continue;
      // Only credential-accepting routes: rate limiting every endpoint is a
      // deployment concern, but an unthrottled login is a credential-stuffing
      // target regardless of deployment.
      if (decoratorName(httpDecorator) === "Get") continue;
      const routePath = firstStringLiteralArg(httpDecorator) || "";
      const methodName = propertyName(member) || "";
      if (!AUTH_ROUTE_NAME_PATTERN.test(routePath) && !AUTH_ROUTE_NAME_PATTERN.test(methodName)) continue;
      if (classThrottled || isThrottled(member, sourceFile)) continue;
      findings.push(createFinding({
        id: "SEC-007",
        category: "Security",
        severity: "MEDIUM",
        confidence: "medium",
        analyzer: ANALYZER_ID,
        title: "Authentication endpoint has no rate limiting",
        detail: `${classNode.name?.text || "Controller"}.${methodName}() accepts credentials but carries no @Throttle(...) and no throttler guard, so it is open to credential stuffing and brute force.`,
        remediation: "Apply @Throttle({ default: { limit, ttl } }) (or a ThrottlerGuard) to this route or its controller. If rate limiting is enforced at the gateway, record that in AGENTS.md so this check can be reasoned about.",
        sourceFile,
        node: member.name || member,
        file: relativePath
      }));
    }
  });
  return findings;
}

function isThrottled(node, sourceFile) {
  return getDecoratorList(node).some((decorator) => {
    const name = decoratorName(decorator) || "";
    if (!RATE_LIMIT_DECORATORS.has(name)) return false;
    if (name === "Throttle" || name === "RateLimit") return true;
    return RATE_LIMIT_GUARD_PATTERN.test(decorator.getText(sourceFile));
  });
}

// ---------------------------------------------------------------------------
// SEC-008 — shell execution built from a non-literal value
// ---------------------------------------------------------------------------

const SHELL_EXEC_FUNCTIONS = new Set(["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork"]);

function checkUnsafeCommandExecution({ sourceFile, relativePath }) {
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : (ts.isIdentifier(node.expression) ? node.expression.text : null);
      if (callee && SHELL_EXEC_FUNCTIONS.has(callee)) {
        const [command] = node.arguments;
        const shellEnabled = node.arguments.some((argument) =>
          ts.isObjectLiteralExpression(argument)
          && argument.properties.some((property) =>
            propertyName(property) === "shell"
            && ts.isPropertyAssignment(property)
            && property.initializer.kind === ts.SyntaxKind.TrueKeyword)
        );
        const dynamicCommand = command && !ts.isStringLiteralLike(command);
        if (dynamicCommand && (callee === "exec" || callee === "execSync" || shellEnabled)) {
          findings.push(createFinding({
            id: "SEC-008",
            category: "Security",
            severity: "HIGH",
            confidence: "high",
            analyzer: ANALYZER_ID,
            title: "Shell command built from a non-literal value",
            detail: `${callee}(...) is called with a command that is not a string literal${shellEnabled ? " and with shell: true" : ""}, so any interpolated value is interpreted by the shell.`,
            remediation: "Use execFile/spawn with an argument array and no `shell: true`, so arguments are passed to the process directly instead of being parsed by a shell.",
            sourceFile,
            node,
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
// SEC-009 — filesystem path built from request input
// ---------------------------------------------------------------------------

const FS_PATH_FUNCTIONS = new Set([
  "readFile", "readFileSync", "writeFile", "writeFileSync", "unlink", "unlinkSync",
  "createReadStream", "createWriteStream", "rm", "rmSync", "appendFile", "appendFileSync"
]);

function checkRequestControlledFilePath({ sourceFile, relativePath }) {
  const findings = [];
  eachController(sourceFile, (classNode) => {
    for (const member of classNode.members) {
      if (!ts.isMethodDeclaration(member) || !member.body) continue;
      if (!findDecorator(member, [...HTTP_METHOD_DECORATORS])) continue;
      const requestParams = new Set(
        member.parameters
          .filter((parameter) => hasDecorator(parameter, ["Param", "Query", "Body"]))
          .map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : null))
          .filter(Boolean)
      );
      if (!requestParams.size) continue;

      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && FS_PATH_FUNCTIONS.has(node.expression.name.text)) {
          const [pathArgument] = node.arguments;
          if (pathArgument && mentionsIdentifier(pathArgument, requestParams) && !isPathSanitized(node, sourceFile)) {
            findings.push(createFinding({
              id: "SEC-009",
              category: "Security",
              severity: "HIGH",
              confidence: "medium",
              analyzer: ANALYZER_ID,
              title: "Filesystem path built from request input",
              detail: `fs.${node.expression.name.text}(...) receives a path derived from a request parameter with no visible containment check, so "../" segments can escape the intended directory.`,
              remediation: "Resolve the path and verify it stays inside the intended base directory (path.relative(base, resolved) must not start with ..), or map the request value through an allowlist.",
              sourceFile,
              node,
              file: relativePath
            }));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(member.body);
    }
  });
  return findings;
}

function mentionsIdentifier(node, names) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isIdentifier(current) && names.has(current.text)) found = true;
    else ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isPathSanitized(callNode, sourceFile) {
  // Walk up to the enclosing function and look for a containment check. This is
  // intentionally generous: a false negative here is much cheaper than telling
  // a team their correct sanitisation is a vulnerability.
  let current = callNode.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) && current.body) {
      const text = current.body.getText(sourceFile);
      return /path\s*\.\s*relative\s*\(|startsWith\s*\(|basename\s*\(|sanitiz|allowlist|whitelist/i.test(text);
    }
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------

/** The path argument of `@Controller("...")`, or "" when it has none. */
function controllerBasePath(classNode) {
  const decorator = findDecorator(classNode, ["Controller"]);
  return decorator ? (firstStringLiteralArg(decorator) || "") : "";
}

function joinRoute(base, methodPath) {
  return [base, methodPath].filter(Boolean).join("/");
}

/** True when this node applies ClassSerializerInterceptor. */
function usesClassSerializer(node, sourceFile) {
  return getDecoratorList(node).some((decorator) =>
    decoratorName(decorator) === "UseInterceptors"
    && /ClassSerializerInterceptor/.test(decorator.getText(sourceFile)));
}

function eachController(sourceFile, callback) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && hasDecorator(node, ["Controller"])) callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export { isEnvironmentSourced };
