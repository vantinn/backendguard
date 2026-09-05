import ts from "typescript";

/**
 * Shared TypeScript-AST helpers used by every analyzer.
 *
 * These are deliberately syntax-level only: no `ts.Program`, no module
 * resolution, no type checker. Building a full Program over an arbitrary user
 * project is slow and fails on any project whose `tsconfig.json` doesn't
 * resolve cleanly, which is exactly the situation an analysis tool has to keep
 * working in. Cross-file relationships (entity <-> service <-> controller) are
 * instead resolved from decorators and declared parameter types by
 * `source-index.js`.
 */

export function forEachClass(sourceFile, callback) {
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function classProperties(classNode) {
  return classNode.members.filter((member) => ts.isPropertyDeclaration(member));
}

export function classMethods(classNode) {
  return classNode.members.filter((member) => ts.isMethodDeclaration(member));
}

export function propertyName(node) {
  const name = node?.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

export function getDecoratorList(node) {
  if (!node) return [];
  const modifiers = ts.canHaveDecorators?.(node) ? ts.getDecorators(node) : node.decorators;
  return modifiers ? [...modifiers] : [];
}

export function decoratorName(decorator) {
  const expression = decorator?.expression;
  if (!expression) return null;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) return expression.expression.text;
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

export function findDecorator(node, names) {
  return getDecoratorList(node).find((decorator) => names.includes(decoratorName(decorator)));
}

export function hasDecorator(node, names) {
  return Boolean(findDecorator(node, names));
}

export function decoratorArguments(decorator) {
  const expression = decorator?.expression;
  return expression && ts.isCallExpression(expression) ? [...expression.arguments] : [];
}

export function firstStringLiteralArg(decorator) {
  const [first] = decoratorArguments(decorator);
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

export function typeReferenceName(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) return typeNode.typeName.text;
  if (ts.isArrayTypeNode(typeNode)) return typeReferenceName(typeNode.elementType);
  return null;
}

export function firstTypeArgumentName(typeNode) {
  if (!ts.isTypeReferenceNode(typeNode) || !typeNode.typeArguments?.length) return null;
  return typeReferenceName(typeNode.typeArguments[0]);
}

export function unwrapAwait(expression) {
  return expression && ts.isAwaitExpression(expression) ? expression.expression : expression;
}

/**
 * Name of the object a method is called on: `this.userRepo.find()` → "userRepo",
 * `prisma.user.findMany()` → "user", `client.query()` → "client".
 */
export function callBaseName(expression) {
  if (!expression) return null;
  if (ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return expression.name.text;
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

/** Full dotted path of a call target: `this.prisma.user.findMany` → "prisma.user.findMany". */
export function callPath(expression) {
  const parts = [];
  let current = expression;
  while (current) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      current = null;
    } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
      current = null;
    } else {
      return null;
    }
  }
  return parts.length ? parts.join(".") : null;
}

export function isLoopLike(node) {
  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) return true;
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return true;
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ["forEach", "map", "flatMap", "filter"].includes(node.expression.name.text)
    && node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
}

export function objectLiteralHasKey(node, names) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => names.includes(propertyName(property)));
}

export function objectLiteralProperty(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  return node.properties.find((property) => propertyName(property) === name) || null;
}

/**
 * True when the expression reads from the environment or a config service
 * rather than being a literal — used by every "hardcoded value" check.
 */
export function isEnvironmentSourced(expression) {
  if (!expression) return false;
  const text = expression.getText?.() || "";
  return /process\s*\.\s*env\b/.test(text)
    || /\bconfig(Service)?\s*\.\s*get\b/i.test(text)
    || /\benv\s*\.\s*[A-Z_]/.test(text);
}

/** Enclosing function-like node, used to scope "per function" checks. */
export function isFunctionLike(node) {
  return ts.isMethodDeclaration(node)
    || ts.isFunctionDeclaration(node)
    || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isConstructorDeclaration(node);
}

export { ts };
