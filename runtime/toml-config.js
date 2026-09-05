import { parse } from "smol-toml";

export function readMcpServersFromToml(content) {
  const config = parseToml(content);
  const servers = config.mcp_servers && typeof config.mcp_servers === "object"
    ? config.mcp_servers
    : {};

  return Object.entries(servers)
    .filter(([, server]) => server && typeof server.command === "string")
    .map(([name, server]) => ({
      name,
      command: server.command,
      args: Array.isArray(server.args) ? server.args.map(String) : []
    }));
}

export function updateMcpServerFields(content, name, fields) {
  parseToml(content);
  const lines = String(content || "").split(/\r?\n/);
  const section = findMcpServerSection(lines, name);
  if (!section) return content;

  let body = lines.slice(section.start + 1, section.end);
  for (const [key, value] of Object.entries(fields)) {
    body = replaceOrInsertField(body, key, formatTomlValue(value));
  }
  lines.splice(section.start + 1, section.end - section.start - 1, ...body);
  return lines.join("\n");
}

export function formatTomlValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
  return JSON.stringify(String(value));
}

function parseToml(content) {
  return parse(String(content || ""));
}

function findMcpServerSection(lines, name) {
  for (let index = 0; index < lines.length; index += 1) {
    const sectionName = mcpServerNameFromHeader(lines[index]);
    if (sectionName !== name) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s*\[/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return { start: index, end };
  }
  return null;
}

function mcpServerNameFromHeader(line) {
  const match = String(line || "").match(/^\s*\[mcp_servers\.([^\]]+)\]\s*(?:#.*)?$/);
  if (!match || match[1].includes(".tools.")) return null;
  const raw = match[1].trim();
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function replaceOrInsertField(body, key, value) {
  const next = [...body];
  const start = next.findIndex((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line));
  const line = `${key} = ${value}`;
  if (start < 0) {
    next.unshift(line);
    return next;
  }

  let end = start + 1;
  if (valueForField(next[start]).trimStart().startsWith("[")) {
    while (end < next.length && !isBalancedTomlArray(next.slice(start, end).join("\n"))) end += 1;
  }
  next.splice(start, Math.max(1, end - start), line);
  return next;
}

function valueForField(line) {
  return String(line || "").slice(String(line || "").indexOf("=") + 1);
}

function isBalancedTomlArray(value) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of String(value || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
  }
  return depth <= 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
