/**
 * A small, dependency-free parser for `schema.prisma`.
 *
 * Prisma Schema Language is not TypeScript, so the TS parser cannot help here.
 * The grammar this needs is narrow — datasource/generator/model/enum blocks and
 * their field lines — and a focused line parser is far more predictable than a
 * regex soup spread across the checks that consume it.
 *
 * Line numbers are preserved on every field and block so findings can point at
 * the exact line in the schema.
 */

const BLOCK_START = /^(datasource|generator|model|enum|type|view)\s+([A-Za-z_][\w]*)\s*\{/;
const ATTRIBUTE = /@@?[A-Za-z_][\w.]*(\([^)]*\))?/g;

/**
 * @returns {{
 *   datasources: Array<{name, provider, line, options}>,
 *   generators: Array<{name, provider, line, options}>,
 *   models: Array<Model>,
 *   enums: Array<{name, line, values: string[]}>,
 *   raw: string
 * }}
 */
export function parsePrismaSchema(text) {
  const lines = String(text || "").split(/\r?\n/);
  const schema = { datasources: [], generators: [], models: [], enums: [], raw: String(text || "") };

  let block = null;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (!block) {
      const match = line.match(BLOCK_START);
      if (match) {
        block = { kind: match[1], name: match[2], line: i + 1, fields: [], attributes: [], values: [], options: {} };
      }
      continue;
    }

    if (line === "}") {
      closeBlock(schema, block);
      block = null;
      continue;
    }

    if (block.kind === "enum") {
      block.values.push(line.split(/\s+/)[0]);
      continue;
    }

    if (block.kind === "datasource" || block.kind === "generator") {
      const [key, ...rest] = line.split("=");
      if (rest.length) block.options[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
      continue;
    }

    // model/type/view body: either a block attribute (@@index, @@unique, ...)
    // or a field declaration.
    if (line.startsWith("@@")) {
      block.attributes.push({ text: line, line: i + 1 });
      continue;
    }
    const field = parseField(line, i + 1);
    if (field) block.fields.push(field);
  }
  if (block) closeBlock(schema, block);
  return schema;
}

function closeBlock(schema, block) {
  if (block.kind === "datasource") {
    schema.datasources.push({ name: block.name, provider: block.options.provider || null, url: block.options.url || null, line: block.line, options: block.options });
  } else if (block.kind === "generator") {
    schema.generators.push({ name: block.name, provider: block.options.provider || null, line: block.line, options: block.options });
  } else if (block.kind === "enum") {
    schema.enums.push({ name: block.name, line: block.line, values: block.values });
  } else {
    schema.models.push({
      kind: block.kind,
      name: block.name,
      line: block.line,
      fields: block.fields,
      attributes: block.attributes
    });
  }
}

function parseField(line, lineNumber) {
  const match = line.match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(\[\])?(\?)?\s*(.*)$/);
  if (!match) return null;
  const [, name, type, list, optional, rest] = match;
  const attributes = rest.match(ATTRIBUTE) || [];
  return {
    name,
    type,
    isList: Boolean(list),
    isOptional: Boolean(optional),
    attributes,
    line: lineNumber,
    text: line
  };
}

function stripComment(line) {
  // `//` inside a string is not valid anywhere this parser cares about, so a
  // plain split is sufficient and keeps this readable.
  const index = line.indexOf("//");
  return index >= 0 ? line.slice(0, index) : line;
}

export function fieldHasAttribute(field, name) {
  return field.attributes.some((attribute) => attribute === `@${name}` || attribute.startsWith(`@${name}(`));
}

export function modelHasBlockAttribute(model, name, containing) {
  return model.attributes.some((attribute) =>
    attribute.text.startsWith(`@@${name}`) && (!containing || attribute.text.includes(containing)));
}

export function isScalarType(type) {
  return ["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"].includes(type);
}

/** Relation fields whose type refers to another model in the same schema. */
export function relationFields(schema, model) {
  const modelNames = new Set(schema.models.map((entry) => entry.name));
  return model.fields.filter((field) => modelNames.has(field.type));
}
