/**
 * The rule engine: parsing `AGENTS.md` (and the files it chains to) into
 * discrete rules, filtering out the ones that carry no instruction, and scoring
 * the rest against a task.
 *
 * File retrieval — deciding which *source files* a task touches — is a separate
 * job and lives in `retrieval/file-retriever.js`; the two share only the
 * tokenizer exported here.
 */

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "cho", "co", "cua", "do", "fix", "for",
  "from", "in", "is", "it", "la", "of", "on", "or", "sua", "task", "the", "to", "trong",
  "tra", "va", "with"
]);

const IMPORTANT_WORDS = [
  "always", "never", "must", "required", "important", "strictly", "mandatory",
  "luon", "khong bao gio", "bat buoc", "quan trong"
];

const SEMANTIC_ALIASES = {
  duyet: ["moderation", "moderate", "review", "approve", "approval", "approved", "reject", "rejected"],
  kiem: ["check", "verify", "validation", "validate"],
  "kiem-duyet": ["moderation", "moderate", "review", "approve", "approval", "reject"],
  kiemduyet: ["moderation", "moderate", "review", "approve", "approval", "reject"],
  moderation: ["duyet", "kiemduyet", "review", "approval", "reject"],
  moderate: ["duyet", "kiemduyet", "review", "approval", "reject"],
  review: ["duyet", "moderation", "moderate"],
  approve: ["duyet", "approval", "approved"],
  approval: ["duyet", "approve", "approved"],
  reject: ["duyet", "rejected", "rejection"],
  flow: ["workflow", "pipeline", "process"],
  workflow: ["flow", "pipeline", "process"],
  tai: ["upload", "uploaded", "resource"],
  "tai-len": ["upload", "uploaded", "resource"],
  tailen: ["upload", "uploaded", "resource"],
  upload: ["tai", "tailen", "resource", "uploaded"],
  xac: ["confirm", "verify", "verification"],
  nhan: ["confirm", "confirmation"],
  "xac-nhan": ["confirm", "confirmation", "verify", "verification"],
  xacnhan: ["confirm", "confirmation", "verify", "verification"],
  thong: ["notification", "notify", "message"],
  bao: ["notification", "notify", "message"],
  "thong-bao": ["notification", "notify", "message"],
  thongbao: ["notification", "notify", "message"],
  authen: ["auth", "authentication", "login"],
  authentication: ["auth", "authen", "login"],
  recheck: ["check", "verify", "review"]
};

const SYSTEM_USER_RULE_PATTERNS = [
  /\ball\s+shell\s+commands?\s+must\s+run\s+as\b/i,
  /\bcommands?\s+must\s+run\s+as\b/i,
  /\bstrictly\s+follow\s+this\s+sequence\b/i,
  /\bswitch\s+the\s+user\s+context\b/i,
  /\bdo\s+not\s+prefix\b.*\bsudo\s+-u\b/i,
  /\bsudo\s+su\s+-\s*[a-z_][a-z0-9_-]*\b/i,
  /\bsudo\s+-i\s+-u\s+[a-z_][a-z0-9_-]*\b/i,
  /\bsudo\s+-u\s+[a-z_][a-z0-9_-]*\b/i,
  /\bsu\s+-\s+[a-z_][a-z0-9_-]*\b/i
];

const DOCUMENTATION_HEADING_PATTERNS = [
  /^mcp\s+tools?\s*:/i,
  /^key\s+tools?$/i,
  /^workflow$/i,
  /^tools?$/i
];

const TOOL_REFERENCE_TOKENS = new Set([
  "detect_changes",
  "get_review_context",
  "get_impact_radius",
  "get_affected_flows",
  "query_graph",
  "semantic_search_nodes",
  "get_architecture_overview",
  "refactor_tool",
  "list_communities"
]);

const ACTION_TOKENS = new Set([
  "add", "avoid", "call", "check", "derive", "ensure", "filter", "follow", "prefer", "run",
  "use", "validate", "verify", "write", "never", "always", "must", "should", "do"
]);

export function tokenize(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/kiem\s+duyet/g, "kiem-duyet")
    .replace(/tai\s+len/g, "tai-len")
    .replace(/xac\s+nhan/g, "xac-nhan")
    .replace(/thong\s+bao/g, "thong-bao");

  return normalized
    .split(/[^a-z0-9_.-]+/g)
    // Interior separators are meaningful ("user.service.ts", "rate-limit"), but
    // a trailing period is sentence punctuation: without this, "notifications."
    // never matched "notifications" anywhere in scoring or retrieval.
    .map((word) => word.replace(/^[._-]+/, "").replace(/[._-]+$/, ""))
    .flatMap(splitCompoundToken)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function splitCompoundToken(token) {
  const parts = String(token || "").split(/[_.-]+/g).filter(Boolean);
  return parts.length > 1 ? [token, ...parts] : [token];
}

function expandSemanticTokens(tokens) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const alias of SEMANTIC_ALIASES[token] || []) expanded.add(alias);
  }
  return expanded;
}

function sourceFromLine(line) {
  const match = line.match(/^## Source:\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function cleanRuleLine(line) {
  return line
    .replace(/^\s{0,3}[-*+]\s+/, "")
    .replace(/^\s{0,3}\d+[.)]\s+/, "")
    .replace(/^#+\s+/, "")
    .trim();
}

export function parseRules(markdown) {
  const rules = [];
  let sourcePath = "unknown";
  let paragraph = [];

  const flushParagraph = () => {
    const content = cleanRuleLine(paragraph.join(" ").replace(/\s+/g, " "));
    paragraph = [];
    if (content.length < 20) return;
    rules.push({
      id: `r${rules.length + 1}`,
      sourcePath,
      content,
      originalOrder: rules.length
    });
  };

  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const nextSource = sourceFromLine(line);
    if (nextSource) {
      flushParagraph();
      sourcePath = nextSource;
      continue;
    }
    if (!line || /^-{3,}$/.test(line)) {
      flushParagraph();
      continue;
    }
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(rawLine) || /^#{1,6}\s+/.test(rawLine)) {
      flushParagraph();
      const content = cleanRuleLine(rawLine);
      if (content.length >= 4) {
        rules.push({
          id: `r${rules.length + 1}`,
          sourcePath,
          content,
          originalOrder: rules.length
        });
      }
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return dedupeRules(rules);
}

export function filterActionableRules(rules = []) {
  return rules
    .filter((rule) => !isSystemUserRule(rule))
    .filter((rule) => !isDocumentationOnlyRule(rule))
    .map((rule, index) => ({ ...rule, id: `r${index + 1}`, originalOrder: index }));
}

export function isSystemUserRule(rule) {
  const content = typeof rule === "string" ? rule : rule?.content;
  return SYSTEM_USER_RULE_PATTERNS.some((pattern) => pattern.test(String(content || "")));
}

export function isDocumentationOnlyRule(rule) {
  const content = String(typeof rule === "string" ? rule : rule?.content || "").trim();
  const normalized = stripMarkdownEmphasis(content);
  if (!normalized) return true;
  if (/^<!--.*-->$/.test(normalized)) return true;
  if (isFileReferenceOnlyRule(normalized)) return true;
  if (DOCUMENTATION_HEADING_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (isMarkdownTableRule(normalized)) return true;
  if (isGenericHeading(normalized)) return true;
  return false;
}

/**
 * A bullet that is nothing but a path or an `@file` include (the convention
 * several agent tools use to pull in another rules file) carries no instruction
 * of its own — the included file's rules are read separately by the chain
 * reader. Injecting the bare path wastes context budget and, worse, its path
 * segments become spurious scoring tokens.
 */
export function isFileReferenceOnlyRule(content) {
  const value = String(content || "").trim().replace(/^[-*+]\s+/, "");
  if (!value || /\s/.test(value.replace(/^@/, ""))) return false;
  return /^@?[~./]?[\w./~@-]+\.(md|markdown|mdc|txt|json|ya?ml|toml)$/i.test(value);
}

function stripMarkdownEmphasis(content) {
  return String(content || "")
    .replace(/^#+\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .trim();
}

function isMarkdownTableRule(content) {
  if (!content.includes("|")) return false;
  const pipeCount = (content.match(/\|/g) || []).length;
  if (pipeCount < 4) return false;
  const lower = content.toLowerCase();
  const toolReferenceCount = [...TOOL_REFERENCE_TOKENS].filter((token) => lower.includes(token)).length;
  return /\btool\b/.test(lower) && /\buse\s+when\b/.test(lower) && toolReferenceCount >= 2;
}

function isGenericHeading(content) {
  if (content.length > 80 || /[`.:;]/.test(content)) return false;
  const tokens = tokenize(content);
  if (tokens.length > 4) return false;
  return !tokens.some((token) => ACTION_TOKENS.has(token));
}

function dedupeRules(rules) {
  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.sourcePath}:${rule.content.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((rule, index) => ({ ...rule, id: `r${index + 1}`, originalOrder: index }));
}

export function scoreRules(rules, task, openFiles = []) {
  const rawTaskTokens = new Set(tokenize(task));
  const openFileText = Array.isArray(openFiles) ? openFiles.join(" ") : String(openFiles || "");
  const openFileTokens = new Set(tokenize(openFileText));

  return rules.map((rule) => {
    const ruleTokens = new Set(tokenize(rule.content));
    const exactOverlap = [...rawTaskTokens].filter((token) => ruleTokens.has(token));
    const semanticOverlap = [];
    for (const token of rawTaskTokens) {
      for (const alias of SEMANTIC_ALIASES[token] || []) {
        if (!rawTaskTokens.has(alias) && ruleTokens.has(alias)) semanticOverlap.push(`${token}->${alias}`);
      }
    }
    const reasons = [];
    let score = rawTaskTokens.size
      ? (exactOverlap.length + semanticOverlap.length * 0.5) / Math.max(rawTaskTokens.size, 1)
      : 0;

    if (exactOverlap.length) reasons.push(`task:${exactOverlap.join("/")}`);
    if (semanticOverlap.length) reasons.push(`semantic:${semanticOverlap.join("/")}`);

    // The imperative-language bonus ("always"/"never"/"must"...) is meant to nudge
    // an ALREADY task-relevant rule higher, not to single-handedly make an
    // unrelated rule "relevant" — nearly every well-written AGENTS.md rule uses
    // this language, so applying the bonus unconditionally made every rule clear
    // the selection threshold regardless of the task (see
    // docs/implementation-gap-analysis.md, Gap 10). Skip the bonus only when a
    // real task was given and it has zero overlap (exact or semantic) with this
    // rule; an empty/no-task query keeps the old "show important rules" behavior.
    const hasTaskOverlap = exactOverlap.length > 0 || semanticOverlap.length > 0 || rawTaskTokens.size === 0;
    const lowerRule = rule.content.toLowerCase();
    if (hasTaskOverlap && IMPORTANT_WORDS.some((word) => lowerRule.includes(word))) {
      score += 0.5;
      reasons.push("imperative");
    }

    const fileMentions = [...ruleTokens].filter((token) => /[./]/.test(token) || /\.[a-z0-9]+$/.test(token));
    if (fileMentions.some((token) => openFileTokens.has(token) || openFileText.includes(token))) {
      score += 0.2;
      reasons.push("open-file");
    }

    return {
      ...rule,
      score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
      reasons
    };
  }).sort((a, b) => b.score - a.score || a.originalOrder - b.originalOrder);
}
