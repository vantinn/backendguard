import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  enhanceRuleScoresWithEmbeddings,
  searchIndexedEmbeddings,
  warmIndexedEmbeddings
} from "../retrieval/embedding-scorer.js";
import { fusedProjectQuery, workspacePackagePaths } from "../analysis/project-profiler.js";

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_SKILLS = 2000;
const DEFAULT_EMBEDDING_CANDIDATES = 120;
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION_CHARS = 500;
const SKILL_EMBEDDING_THRESHOLD = 0.45;
const DEFAULT_SKILL_TIMEOUT_MS = 2000;
const DEFAULT_ROUTER_THRESHOLD = 0.35;

const scanCache = new Map();

export function clearSkillScanCache() {
  scanCache.clear();
}

export function skillSearchRoots({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return [
    path.join(cwd, ".codex", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".gemini", "skills"),
    path.join(cwd, ".gemini", "antigravity", "skills"),
    path.join(cwd, ".gemini", "antigravity-cli", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".config", "skillshare", "skills"),
    path.join(home, ".gemini", "skills"),
    path.join(home, ".gemini", "antigravity", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "skills")
  ];
}

export function parseSkillFrontmatter(content = "", { fallbackName = "", skillPath = "" } = {}) {
  const text = String(content || "");
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const fields = frontmatter ? parseYamlishFields(frontmatter[1]) : {};
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const fallbackDescription = firstParagraph(body);
  return {
    name: fields.name || fallbackName || path.basename(path.dirname(skillPath)),
    description: truncateDescription(fields.description || fallbackDescription),
    path: skillPath
  };
}

export function parseSkillMarkdownAst(content = "") {
  const root = { type: "root", children: [] };
  let currentSection = null;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const node = {
        type: "heading",
        depth: heading[1].length,
        title: heading[2].trim(),
        items: [],
        paragraphs: []
      };
      root.children.push(node);
      currentSection = node;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && currentSection) {
      currentSection.items.push(bullet[1].trim());
      continue;
    }
    if (currentSection) currentSection.paragraphs.push(line);
  }
  return root;
}

export function skillSchemaFromMarkdownAst(ast = {}) {
  const schema = {
    intent: [],
    positivePrompts: [],
    files: [],
    dependencies: [],
    workflows: [],
    relatedSkills: [],
    dependsOn: [],
    provides: [],
    requires: [],
    suggestedFiles: []
  };
  for (const section of ast.children || []) {
    const title = normalize(section.title || "");
    const items = [...(section.items || []), ...(section.paragraphs || [])].map(cleanMarkdownListItem).filter(Boolean);
    if (!items.length) continue;
    if (/\b(intent|intents|domain|domains)\b/.test(title)) schema.intent.push(...items);
    else if (/\b(trigger|triggers|prompt|prompts|keyword|keywords)\b/.test(title)) schema.positivePrompts.push(...items);
    else if (/\b(evidence|dependency|dependencies|package|packages)\b/.test(title)) {
      for (const item of items) {
        if (looksLikeFilePattern(item)) schema.files.push(item);
        else schema.dependencies.push(item);
      }
    } else if (/\b(file|files|suggested file|suggested files)\b/.test(title)) {
      schema.files.push(...items);
      schema.suggestedFiles.push(...items);
    } else if (/\b(workflow|workflows|steps|checklist)\b/.test(title)) schema.workflows.push(...items);
    else if (/\b(related|related skills)\b/.test(title)) schema.relatedSkills.push(...items);
    else if (/\b(depends on|depends|dependency skills)\b/.test(title)) schema.dependsOn.push(...items);
    else if (/\b(provides|capabilities)\b/.test(title)) schema.provides.push(...items);
    else if (/\b(requires|requirements)\b/.test(title)) schema.requires.push(...items);
  }
  return normalizeSkillMetadata(schema);
}

export function buildSkillGraph(skills = []) {
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();
  for (const skill of skills || []) {
    const id = skillGraphId(skill);
    if (!id) continue;
    const metadata = skill.metadata || {};
    nodes.push({
      id,
      name: skill.name,
      intent: metadata.intent || [],
      provides: metadata.provides || [],
      requires: metadata.requires || []
    });
    for (const target of metadata.relatedSkills || []) {
      addSkillGraphEdge(edges, seenEdges, id, target, "related_to");
    }
    for (const target of metadata.dependsOn || []) {
      addSkillGraphEdge(edges, seenEdges, id, target, "depends_on");
    }
    for (const target of metadata.requires || []) {
      addSkillGraphEdge(edges, seenEdges, id, target, "requires");
    }
  }
  return { nodes, edges };
}

export function expandSkillGraphSuggestions({ seeds = [], catalog = [], maxDepth = 1, maxRelated = 6 } = {}) {
  if (!seeds.length || !catalog.length || maxDepth < 1) return [];
  const graph = buildSkillGraph(catalog);
  const byId = new Map(catalog.map((skill) => [skillGraphId(skill), skill]));
  const queued = seeds.map(skillGraphId).filter(Boolean);
  const visited = new Set(queued);
  const expanded = [];
  let depth = 0;
  while (queued.length && depth < maxDepth && expanded.length < maxRelated) {
    const levelSize = queued.length;
    for (let index = 0; index < levelSize; index += 1) {
      const current = queued.shift();
      for (const edge of graph.edges.filter((candidate) => candidate.from === current)) {
        const target = skillGraphId({ name: edge.to });
        if (!target || visited.has(target)) continue;
        visited.add(target);
        queued.push(target);
        const skill = byId.get(target);
        if (skill) {
          expanded.push(skillScoreFromGraph(skill, current, edge.type));
          if (expanded.length >= maxRelated) break;
        }
      }
      if (expanded.length >= maxRelated) break;
    }
    depth += 1;
  }
  return expanded;
}

export function parseSkillMetadata(content = "") {
  const lines = String(content || "").split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length || 0;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseScalar(line.slice(2)));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue) {
      parent[key] = parseScalar(rawValue);
      continue;
    }

    const next = nextMeaningfulLine(lines, rawLine);
    parent[key] = next?.trim().startsWith("- ") ? [] : {};
    stack.push({ indent, value: parent[key] });
  }

  return normalizeSkillMetadata(root);
}

function truncateDescription(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
}

function parseYamlishFields(frontmatter) {
  const fields = {};
  const lines = String(frontmatter || "").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    value = value.replace(/^["']|["']$/g, "");
    fields[key] = value;
  }
  return fields;
}

function firstParagraph(body) {
  return String(body || "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean) || "";
}

export function scanSkills({ cwd = process.cwd(), roots = skillSearchRoots({ cwd }), maxSkills = DEFAULT_MAX_SKILLS } = {}) {
  const cacheKey = `${path.resolve(cwd)}\0${maxSkills}\0${roots.map((root) => path.resolve(root)).join("\0")}`;
  const cached = scanCache.get(cacheKey);
  if (cached && monotonicNow() - cached.createdAt < SCAN_CACHE_TTL_MS) {
    return cached.skills;
  }

  const skills = [];
  const seen = new Set();
  for (const root of roots) {
    for (const skillPath of findSkillFiles(root)) {
      if (skills.length >= maxSkills) return cacheAndReturnSkills(cacheKey, skills);
      const realPath = safeRealpath(skillPath) || skillPath;
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      let content = "";
      try {
        content = fs.readFileSync(skillPath, "utf8");
      } catch {
        continue;
      }
      const skill = parseSkillFrontmatter(content, {
        fallbackName: path.basename(path.dirname(skillPath)),
        skillPath
      });
      if (!skill.name || !skill.description) continue;
      const metadata = readSkillMetadata({ skillPath, skill, content });
      skills.push(enrichSkill({
        ...skill,
        metadata,
        root,
        scope: isInsidePath(skillPath, cwd) ? "project" : "global",
        relativePath: path.relative(cwd, skillPath)
      }));
    }
  }
  return cacheAndReturnSkills(cacheKey, skills);
}

function monotonicNow() {
  return globalThis.performance?.now?.() || Date.now();
}

function cacheAndReturnSkills(cacheKey, skills) {
  const deduped = dedupeSkills(skills);
  scanCache.set(cacheKey, { createdAt: monotonicNow(), skills: deduped });
  return deduped;
}

function findSkillFiles(root) {
  const files = [];
  walk(root, 0, files);
  return files;
}

function walk(directory, depth, files) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1, files);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(fullPath);
    }
  }
}

function safeRealpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isInsidePath(filePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(filePath));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function suggestSkills({
  prompt = "",
  skills = [],
  dataDir,
  cwd = process.cwd(),
  limit = DEFAULT_LIMIT,
  timeoutMs = Number(process.env.BACKENDGUARD_SKILL_EMBEDDING_TIMEOUT_MS || process.env.BACKENDGUARD_EMBEDDING_TIMEOUT_MS || DEFAULT_SKILL_TIMEOUT_MS),
  indexedSearcher = searchIndexedEmbeddings,
  embeddingEnhancer = enhanceRuleScoresWithEmbeddings,
  embeddingsEnabled = true
} = {}) {
  if (!String(prompt || "").trim() || !skills.length) return [];
  const catalog = dedupeSkills(skills);
  const query = skillQuery({ prompt, cwd, dataDir });
  const byId = new Map(catalog.map((skill) => [skillIndexId(skill), skill]));
  const explicitSkills = explicitSkillSuggestions({ prompt, byId });
  const projectEvidence = detectProjectEvidence({ cwd });
  if (!embeddingsEnabled) {
    const candidates = [
      ...explicitSkills,
      ...lightweightSkillSuggestions({ catalog, prompt, projectEvidence })
    ];
    return finalizeSkillScores(withGraphExpansion({ candidates, catalog }), limit, { cwd, prompt, projectEvidence });
  }

  if (dataDir) {
    const indexed = await searchSkillIndexes({ cwd, query, dataDir, timeoutMs, indexedSearcher });
    if (indexed.status === "enabled" && indexed.items.length) {
      const candidates = [
        ...explicitSkills,
        ...indexed.items
        .map((item) => {
          const skill = byId.get(item.id);
          if (!skill) return null;
          return skillScoreFromEmbedding(skill, item.embeddingScore, [`embedding:${Number(item.embeddingScore || 0).toFixed(2)}`]);
        })
        .filter(Boolean)
      ];
      return finalizeSkillScores(withGraphExpansion({ candidates, catalog }), limit, { cwd, prompt, projectEvidence });
    }
  }

  if (catalog.length > DEFAULT_EMBEDDING_CANDIDATES) {
    return finalizeSkillScores(withGraphExpansion({ candidates: explicitSkills, catalog }), limit, { cwd, prompt, projectEvidence });
  }

  const embeddingCandidates = catalog.map((skill, index) => skillRule({ skill, index }));
  if (!embeddingCandidates.length) return finalizeSkillScores(explicitSkills, limit, { cwd, prompt, projectEvidence });

  const embedding = await embeddingEnhancer(embeddingCandidates, query, {
    dataDir,
    sources: embeddingCandidates.map((skill) => skill.path).filter(Boolean),
    timeoutMs,
    allowRemote: false
  });

  return finalizeSkillScores(withGraphExpansion({ candidates: [...explicitSkills, ...embedding.rules], catalog }), limit, { cwd, prompt, projectEvidence });
}

function skillQuery({ prompt = "", cwd = process.cwd(), dataDir } = {}) {
  const focusedPrompt = String(prompt || "").trim();
  const fused = fusedProjectQuery({ prompt, cwd, dataDir });
  return [focusedPrompt, focusedPrompt, fused].filter(Boolean).join("\n");
}

function explicitSkillSuggestions({ prompt = "", byId = new Map() } = {}) {
  const names = extractExplicitSkillNames(prompt);
  return names
    .map((name, index) => ({ skill: byId.get(normalize(name)), index }))
    .filter(({ skill }) => Boolean(skill))
    .map(({ skill, index }) => skillScoreFromEmbedding(skill, 1 - index * 0.0001, ["explicit-skill"]));
}

function lightweightSkillSuggestions({ catalog = [], prompt = "", projectEvidence = {} } = {}) {
  const promptTokens = new Set(meaningfulSkillTokens(prompt));
  if (!promptTokens.size) return [];

  return catalog
    .map((skill) => {
      const enriched = skill.searchTokens ? skill : enrichSkill(skill);
      const metadata = enriched.metadata || inferSkillMetadata(enriched);
      const promptMatch = matchTextTriggers(prompt, metadata.positivePrompts);
      const dependencyEvidence = matchList(projectEvidence.dependencies, metadata.dependencies);
      const fileEvidence = matchFiles(projectEvidence.files, metadata.files);
      const negativeDependencies = matchList(projectEvidence.dependencies, metadata.negativeDependencies);
      const negativeFiles = matchFiles(projectEvidence.files, metadata.negativeFiles);
      const negativePrompts = matchTextTriggers(prompt, metadata.negativePrompts);
      const negativePenalty = Math.max(negativeDependencies.score, negativeFiles.score, negativePrompts.score);
      const nameMatches = meaningfulSkillTokens(enriched.name).filter((token) => promptTokens.has(token));
      const tokenMatches = meaningfulSkillTokens(`${enriched.name} ${enriched.description}`).filter((token) => promptTokens.has(token));
      const hasRouterEvidence = Boolean(
        promptMatch.matches.length
        || dependencyEvidence.matches.length
        || fileEvidence.matches.length
      );
      const genericPromptOnly = promptMatch.matches.length > 0
        && promptMatch.matches.every((item) => genericPromptTrigger(normalize(item)))
        && !nameMatches.length
        && !tokenMatches.length
        && !dependencyEvidence.matches.length
        && !fileEvidence.matches.length;
      if (!hasRouterEvidence && !nameMatches.length && tokenMatches.length < 2) return null;
      if (genericPromptOnly) return null;

      const ecosystemPenalty = irrelevantEcosystemPenalty(enriched, { promptTokens, projectEvidence });
      const lexicalScore = Math.min(1,
        nameMatches.length * 0.20
        + Math.min(tokenMatches.length, 5) * 0.08
        + promptMatch.score * 0.45
        + dependencyEvidence.score * 0.20
        + fileEvidence.score * 0.12
        + skillSourceBoostScore(enriched) * 0.03
        - negativePenalty * 0.25
        - ecosystemPenalty
      );
      if (lexicalScore < 0.35) return null;

      const reasons = [
        `lightweight:${lexicalScore.toFixed(2)}`,
        ...nameMatches.slice(0, 3).map((item) => `name:${item}`),
        ...tokenMatches.slice(0, 5).map((item) => `token:${item}`)
      ];
      return skillScoreFromEmbedding(enriched, lexicalScore, reasons);
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.embeddingScore || 0) - Number(a.embeddingScore || 0)
      || scopePriority(b.scope) - scopePriority(a.scope)
      || a.name.localeCompare(b.name));
}

function cleanMarkdownListItem(value) {
  return String(value || "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^`|`$/g, "")
    .trim();
}

function looksLikeFilePattern(value) {
  const text = String(value || "");
  return /[./*\\]|package\.json|dockerfile|config|controller|service|route|page|component|\.tsx?$|\.jsx?$|\.ya?ml$|\.json$/i.test(text);
}

function extractExplicitSkillNames(prompt = "") {
  const names = [];
  const seen = new Set();
  const pattern = /(?:^|[\s([{,])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/g;
  let match;
  while ((match = pattern.exec(String(prompt || "")))) {
    const name = match[1];
    const key = normalize(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export async function diagnoseSkills({
  prompt = "",
  skills = [],
  dataDir,
  cwd = process.cwd(),
  limit = 10,
  ...options
} = {}) {
  const suggestions = await suggestSkills({ prompt, skills, dataDir, cwd, limit, ...options });
  const projectEvidence = detectProjectEvidence({ cwd });
  return {
    prompt,
    cwd,
    projectEvidence,
    skills: suggestions
  };
}

function finalizeSkillScores(skills, limit, { cwd = process.cwd(), prompt = "", projectEvidence = detectProjectEvidence({ cwd }) } = {}) {
  const ranked = skills
    .map((rule) => hybridSkillScore(rule, { prompt, projectEvidence }))
    .filter((skill) => skill.explicit || Number(skill.rankScore || 0) >= DEFAULT_ROUTER_THRESHOLD)
    .sort((a, b) => b.rankScore - a.rankScore
      || b.score - a.score
      || scopePriority(b.scope) - scopePriority(a.scope)
      || a.name.localeCompare(b.name));
  const seen = new Set();
  return ranked
    .filter((skill) => {
      const key = normalize(skill.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function scopePriority(scope) {
  return scope === "project" ? 1 : 0;
}

export async function warmSkillEmbeddings({
  cwd = process.cwd(),
  dataDir,
  allowRemote = true,
  skills = scanSkills({ cwd })
} = {}) {
  if (!dataDir || !skills.length) return { count: 0, cachePath: null };
  const catalog = dedupeSkills(skills);
  const workspaceResult = await warmIndexedEmbeddings({
    kind: skillIndexKind(cwd),
    items: catalog.map((skill) => ({
      id: skillIndexId(skill),
      text: skillEmbeddingText(skill)
    })),
    task: fusedProjectQuery({ prompt: "skill discovery semantic retrieval", cwd, dataDir }),
    dataDir,
    sources: catalog.map((skill) => skill.path).filter(Boolean),
    allowRemote
  });
  if (workspaceResult.status === "missing-model" || workspaceResult.status === "warm-failed") return workspaceResult;
  await warmIndexedEmbeddings({
    kind: sharedSkillIndexKind(),
    items: catalog.map((skill) => ({
      id: skillIndexId(skill),
      text: skillEmbeddingText(skill)
    })),
    task: fusedProjectQuery({ prompt: "skill discovery semantic retrieval", cwd, dataDir }),
    dataDir,
    sources: catalog.map((skill) => skill.path).filter(Boolean),
    allowRemote
  });
  return workspaceResult;
}

function skillRule({ skill, index }) {
  const enriched = skill.searchTokens ? skill : enrichSkill(skill);
  return {
    id: skillIndexId(enriched),
    name: enriched.name,
    description: enriched.description,
    path: enriched.path,
    scope: enriched.scope,
    content: skillEmbeddingText(enriched),
    score: 0,
    originalOrder: index
  };
}

function skillScoreFromEmbedding(skill, embeddingScore, reasons = []) {
  const score = Math.min(1, Number(embeddingScore || 0));
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
    metadata: skill.metadata,
    score,
    embeddingScore: score,
    reasons
  };
}

function skillScoreFromGraph(skill, source, type) {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
    metadata: skill.metadata,
    score: 0.62,
    embeddingScore: 0.62,
    graphRelationshipScore: 1,
    reasons: [`skill-graph:${type}:${source}`]
  };
}

function withGraphExpansion({ candidates = [], catalog = [] } = {}) {
  const expanded = expandSkillGraphSuggestions({ seeds: candidates, catalog });
  return [...candidates, ...expanded];
}

function dedupeSkills(skills) {
  const byName = new Map();
  for (const skill of skills || []) {
    const enriched = skill.searchTokens ? skill : enrichSkill(skill);
    const key = normalize(enriched.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing || skillSourcePriority(enriched) > skillSourcePriority(existing)) {
      byName.set(key, enriched);
    }
  }
  return [...byName.values()];
}

function skillSourcePriority(skill) {
  let priority = 0;
  if (skill.scope === "project") priority += 100;
  const skillPath = String(skill.path || "");
  if (skillPath.includes(`${path.sep}.codex${path.sep}skills${path.sep}`)) priority += 30;
  if (skillPath.includes(`${path.sep}.config${path.sep}skillshare${path.sep}skills${path.sep}`)) priority += 20;
  if (skillPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)) priority += 10;
  return priority;
}

function skillIndexKind(cwd) {
  return `skill:${path.resolve(cwd)}`;
}

function sharedSkillIndexKind() {
  return "skill:global";
}

async function searchSkillIndexes({ cwd, query, dataDir, timeoutMs, indexedSearcher }) {
  const workspace = await indexedSearcher({
    kind: skillIndexKind(cwd),
    task: query,
    dataDir,
    timeoutMs,
    allowRemote: false
  });
  if (workspace.status === "enabled" && workspace.items.length) return workspace;
  const shared = await indexedSearcher({
    kind: sharedSkillIndexKind(),
    task: query,
    dataDir,
    timeoutMs,
    allowRemote: false
  });
  if (shared.status === "enabled" && shared.items.length) return shared;
  return workspace.status === "enabled" ? workspace : shared;
}

function skillIndexId(skill) {
  return normalize(skill.name);
}

function skillEmbeddingText(skill) {
  const metadata = skill.metadata || {};
  return [
    skill.name,
    skill.description,
    ...(metadata.intent || []),
    ...(metadata.positivePrompts || []),
    ...(metadata.dependencies || []),
    ...(metadata.files || []),
    ...(metadata.provides || []),
    ...(metadata.requires || []),
    ...(metadata.relatedSkills || [])
  ].filter(Boolean).join("\n");
}

export function projectSkillHints({ cwd = process.cwd() } = {}) {
  const hints = new Set();
  const packagePaths = workspacePackagePaths(cwd);

  for (const packagePath of packagePaths) {
    const packageDir = path.dirname(packagePath);
    const packageJson = readJson(packagePath);
    addHintText(hints, JSON.stringify({
      name: packageJson?.name,
      description: packageJson?.description,
      keywords: packageJson?.keywords || [],
      scripts: packageJson?.scripts || {},
      dependencies: Object.keys(packageJson?.dependencies || {}),
      devDependencies: Object.keys(packageJson?.devDependencies || {})
    }));
    for (const fileName of ["app.json", "app.config.js", "app.config.ts", "eas.json"]) {
      if (fs.existsSync(path.join(packageDir, fileName))) addHintText(hints, fileName);
    }
  }
  return [...hints];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readSkillMetadata({ skillPath, skill, content = "" }) {
  const skillDir = path.dirname(skillPath);
  const inferredMetadata = inferSkillMetadata(skill);
  const markdownMetadata = skillSchemaFromMarkdownAst(parseSkillMarkdownAst(stripFrontmatter(content)));
  for (const fileName of ["skill.yaml", "skill.yml"]) {
    const metadataPath = path.join(skillDir, fileName);
    if (!fs.existsSync(metadataPath)) continue;
    try {
      return {
        ...mergeSkillMetadata(inferredMetadata, markdownMetadata, parseSkillMetadata(fs.readFileSync(metadataPath, "utf8"))),
        sourcePath: metadataPath
      };
    } catch {
      return mergeSkillMetadata(inferredMetadata, markdownMetadata);
    }
  }
  return mergeSkillMetadata(inferredMetadata, markdownMetadata);
}

function normalizeSkillMetadata(metadata = {}) {
  const positive = metadata.positive_triggers || metadata.triggers || {};
  const negative = metadata.negative_triggers || {};
  const evidence = metadata.evidence || {};
  return {
    id: metadata.id,
    name: metadata.name,
    intent: asArray(metadata.intent),
    positivePrompts: uniqueValues(positive.prompts || positive.keywords || metadata.positivePrompts || metadata.keywords),
    files: uniqueValues([
      ...asArray(positive.files || metadata.files),
      ...asArray(evidence.files),
      ...asArray(metadata.suggested_files || metadata.suggestedFiles)
    ]),
    dependencies: uniqueValues([
      ...asArray(positive.dependencies || metadata.dependencies),
      ...asArray(evidence.dependencies)
    ]),
    negativePrompts: asArray(negative.prompts || negative.keywords),
    negativeFiles: asArray(negative.files),
    negativeDependencies: asArray(negative.dependencies),
    workflows: asArray(metadata.workflow || metadata.workflows),
    relatedSkills: uniqueValues(metadata.related_skills || metadata.relatedSkills || metadata.related),
    dependsOn: uniqueValues(metadata.depends_on || metadata.dependsOn),
    provides: uniqueValues(metadata.provides),
    requires: uniqueValues(metadata.requires),
    suggestedFiles: uniqueValues(metadata.suggested_files || metadata.suggestedFiles)
  };
}

function inferSkillMetadata(skill = {}) {
  const text = normalize(`${skill.name || ""} ${skill.description || ""}`);
  const metadata = {
    positivePrompts: [],
    files: [],
    dependencies: [],
    negativePrompts: [],
    negativeFiles: [],
    negativeDependencies: [],
    relatedSkills: []
  };
  if (/\b(eas|expo|react native|mobile deployment|app store)\b/.test(text)) {
    metadata.positivePrompts.push("eas", "expo build", "deployed", "deploy", "submit", "android", "ios", "mobile release", "qr", "connect");
    metadata.files.push("eas.json", "app.json", "app.config.js", "app.config.ts", ".github/workflows/*");
    metadata.dependencies.push("expo", "eas-cli", "expo-router", "react-native");
    metadata.negativeDependencies.push("next", "vite");
    metadata.negativeFiles.push("vercel.json");
  }
  if (/\bgithub actions|ci cd|cicd\b/.test(text)) {
    metadata.positivePrompts.push("deploy", "deployed", "ci", "workflow", "github actions", "build failed");
    metadata.files.push(".github/workflows/*");
  }
  if (/\benv|secret|credential|api key\b/.test(text)) {
    metadata.positivePrompts.push("secret", "env", "environment", "api key", "deploy", "deployed");
    metadata.files.push(".env", ".env.example", ".github/workflows/*");
  }
  if (/\bbuild log|debugging|debug|error|failed|failure\b/.test(text)) {
    metadata.positivePrompts.push("error", "failed", "failure", "fix", "debug", "build", "deployed");
  }
  if (/\bvercel\b/.test(text)) {
    metadata.positivePrompts.push("vercel", "deploy", "deployed");
    metadata.files.push("vercel.json", "next.config.js", "next.config.ts");
    metadata.dependencies.push("next", "vercel");
    metadata.negativeDependencies.push("expo", "react-native");
    metadata.negativeFiles.push("eas.json");
  }
  if (/\bnext|app router\b/.test(text)) {
    metadata.dependencies.push("next", "react");
    metadata.positivePrompts.push("frontend", "ui", "role", "dashboard", "app router", "page", "webapp");
  }
  if (/\b(frontend|react|ui|component|layout|design)\b/.test(text)) {
    metadata.dependencies.push("react");
    metadata.positivePrompts.push("frontend", "ui", "component", "page", "layout", "button", "modal");
  }
  if (/\b(forum|chat|realtime|websocket|socket)\b/.test(text)) {
    metadata.positivePrompts.push("forum", "topic", "new topic", "trending", "chat", "chatting", "message", "realtime", "websocket");
    metadata.files.push("package.json", "webapp/package.json", "services/*/package.json");
    metadata.dependencies.push("next", "react", "socket.io", "ws", "@nestjs/websockets");
  }
  return metadata;
}

function mergeSkillMetadata(...metadataList) {
  const merged = {};
  for (const metadata of metadataList) {
    if (!metadata) continue;
    if (!merged.id && metadata.id) merged.id = metadata.id;
    if (!merged.name && metadata.name) merged.name = metadata.name;
    for (const key of [
      "intent",
      "positivePrompts",
      "files",
      "dependencies",
      "negativePrompts",
      "negativeFiles",
      "negativeDependencies",
      "workflows",
      "relatedSkills",
      "dependsOn",
      "provides",
      "requires",
      "suggestedFiles"
    ]) {
      merged[key] = uniqueValues([...(merged[key] || []), ...asArray(metadata[key])]);
    }
  }
  return merged;
}

function hybridSkillScore(skill, { prompt, projectEvidence }) {
  const semanticScore = Math.min(1, Number(skill.embeddingScore || skill.score || 0));
  const metadata = skill.metadata || inferSkillMetadata(skill);
  const hasRouterSignals = metadataHasSignals(metadata);
  const promptMatch = matchTextTriggers(prompt, metadata.positivePrompts);
  const dependencyEvidence = matchList(projectEvidence.dependencies, metadata.dependencies);
  const fileEvidence = matchFiles(projectEvidence.files, metadata.files);
  const negativeDependencies = matchList(projectEvidence.dependencies, metadata.negativeDependencies);
  const negativeFiles = matchFiles(projectEvidence.files, metadata.negativeFiles);
  const negativePrompts = matchTextTriggers(prompt, metadata.negativePrompts);
  const negativePenalty = Math.max(negativeDependencies.score, negativeFiles.score, negativePrompts.score);
  const projectEvidenceScore = dependencyEvidence.score;
  const fileConfigScore = fileEvidence.score;
  const importGraphScore = 0;
  const sourceBoostScore = skillSourceBoostScore(skill);
  const skillGraphScore = Math.max(0, Math.min(1, Number(skill.graphRelationshipScore || 0)));
  const externalGraphScore = 0;
  const memoryScore = 0;
  const hybridScore = Math.max(0, Math.min(1,
    semanticScore * 0.25
    + promptMatch.score * 0.20
    + projectEvidenceScore * 0.25
    + fileConfigScore * 0.10
    + importGraphScore * 0.10
    + skillGraphScore * 0.10
    + sourceBoostScore * 0.05
    + externalGraphScore * 0.03
    + memoryScore * 0.02
    - negativePenalty * 0.20
  ));
  const explicit = (skill.reasons || []).includes("explicit-skill");
  const finalScore = hasRouterSignals ? hybridScore : semanticScore;
  const calibratedConfidence = calibrateSkillConfidence(finalScore, {
    prompt,
    promptMatch,
    dependencyEvidence,
    fileEvidence,
    negativePenalty,
    explicit,
    semanticScore
  });
  const evidence = [...new Set([
    ...(skill.reasons || []),
    ...promptMatch.matches.map((item) => `prompt:${item}`),
    ...dependencyEvidence.matches.map((item) => `dependency:${item}`),
    ...fileEvidence.matches.map((item) => `file:${item}`),
    ...(skillGraphScore ? [`skill-graph:${skillGraphScore.toFixed(2)}`] : []),
    ...(sourceBoostScore ? [`source:${skillSourceLabel(skill)}`] : [])
  ])];
  const negativeEvidence = [
    ...negativeDependencies.matches.map((item) => `dependency:${item}`),
    ...negativeFiles.matches.map((item) => `file:${item}`),
    ...negativePrompts.matches.map((item) => `prompt:${item}`)
  ];
  const rankScore = explicit ? semanticScore : finalScore;
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
    score: finalScore,
    confidence: calibratedConfidence,
    confidenceBand: confidenceBand(calibratedConfidence),
    embeddingScore: semanticScore,
    semanticScore,
    promptTriggerScore: promptMatch.score,
    projectEvidenceScore,
    fileConfigScore,
    importGraphScore,
    skillGraphScore,
    sourceBoostScore,
    externalGraphScore,
    memoryScore,
    graphScore: externalGraphScore,
    negativePenalty,
    rankScore,
    explicit,
    evidence,
    negativeEvidence,
    reasons: skill.reasons || []
  };
}

function calibrateSkillConfidence(score, {
  prompt = "",
  promptMatch,
  dependencyEvidence,
  fileEvidence,
  negativePenalty = 0,
  explicit = false,
  semanticScore = 0
} = {}) {
  let confidence = Math.max(0, Math.min(1, Number(score || 0)));
  const hasDependencyEvidence = Boolean(dependencyEvidence?.matches?.length);
  const hasFileEvidence = Boolean(fileEvidence?.matches?.length);
  const hasPromptEvidence = Boolean(promptMatch?.matches?.length);
  const hasProjectEvidence = hasDependencyEvidence || hasFileEvidence;

  if (!hasProjectEvidence && !explicit) {
    confidence = Math.min(confidence, 0.62);
  }
  if (!hasProjectEvidence && hasPromptEvidence && Number(semanticScore || 0) >= 0.75 && !explicit) {
    confidence = Math.max(confidence, 0.56);
  }
  if (isAmbiguousPrompt(prompt) && !(hasDependencyEvidence && hasFileEvidence) && !explicit) {
    confidence = Math.min(confidence, 0.64);
  }
  if (hasPromptEvidence && hasProjectEvidence && confidence >= 0.45) {
    confidence = Math.max(confidence, 0.68);
  }
  if (hasDependencyEvidence && hasFileEvidence) {
    confidence = Math.max(confidence, 0.88);
  }
  if (negativePenalty > 0) {
    confidence = Math.min(confidence, 0.74);
  }
  return Math.max(0, Math.min(1, confidence));
}

function skillSourceBoostScore(skill = {}) {
  if (skill.scope === "project") return 1;
  if (isCommunitySkill(skill)) return 0.4;
  return 0;
}

function skillSourceLabel(skill = {}) {
  if (skill.scope === "project") return "project";
  if (isCommunitySkill(skill)) return "community";
  return "global";
}

function isCommunitySkill(skill = {}) {
  return String(skill.path || "").includes(`${path.sep}.config${path.sep}skillshare${path.sep}skills${path.sep}`);
}

function confidenceBand(confidence) {
  const value = Number(confidence || 0);
  if (value >= 0.85) return "high";
  if (value >= 0.65) return "medium";
  return "low";
}

function isAmbiguousPrompt(prompt = "") {
  const tokens = normalize(prompt).split(" ").filter(Boolean);
  if (tokens.length <= 2) return true;
  const generic = new Set(["fix", "add", "update", "debug", "deploy", "deployed", "auth", "cache", "test", "error"]);
  return tokens.length <= 4 && tokens.every((token) => generic.has(token));
}

function meaningfulSkillTokens(value) {
  const stop = new Set([
    "the", "and", "for", "with", "this", "that", "from", "into", "using", "use",
    "task", "create", "update", "implement", "build", "fix", "debug", "page",
    "app", "src", "file", "files", "skill", "skills", "suggested", "suggest", "new"
  ]);
  return normalize(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stop.has(token));
}

function genericPromptTrigger(trigger) {
  return new Set(["frontend", "ui", "component", "page", "layout", "button", "modal"]).has(trigger);
}

function irrelevantEcosystemPenalty(skill = {}, { promptTokens = new Set(), projectEvidence = {} } = {}) {
  const text = normalize(`${skill.name || ""} ${skill.description || ""}`);
  const dependencies = new Set((projectEvidence.dependencies || []).map(normalizeDependency));
  const ecosystems = [
    { token: "azure", deps: ["@azure", "azure"], prompts: ["azure"] },
    { token: "aws", deps: ["aws-sdk", "@aws-sdk"], prompts: ["aws"] },
    { token: "java", deps: ["java"], prompts: ["java"] },
    { token: "dotnet", deps: ["dotnet", "aspnet"], prompts: ["dotnet", "csharp"] },
    { token: "python", deps: ["python"], prompts: ["python"] },
    { token: "angular", deps: ["@angular/core", "angular"], prompts: ["angular"] }
  ];
  let penalty = 0;
  for (const ecosystem of ecosystems) {
    if (!text.includes(ecosystem.token)) continue;
    const promptHas = ecosystem.prompts.some((token) => promptTokens.has(token));
    const projectHas = ecosystem.deps.some((dependency) => [...dependencies].some((value) => value.includes(dependency)));
    if (!promptHas && !projectHas) penalty += 0.55;
  }
  return Math.min(0.7, penalty);
}

function detectProjectEvidence({ cwd = process.cwd() } = {}) {
  const dependencies = new Set();
  const scripts = new Set();
  const files = new Set();
  for (const packagePath of workspacePackagePaths(cwd)) {
    const packageDir = path.dirname(packagePath);
    const packageJson = readJson(packagePath);
    files.add(normalizeFile(path.relative(cwd, packagePath) || "package.json"));
    for (const name of Object.keys({
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
      ...(packageJson?.peerDependencies || {})
    })) dependencies.add(normalizeDependency(name));
    for (const name of Object.keys(packageJson?.scripts || {})) scripts.add(normalize(name));
    for (const fileName of knownProjectConfigFiles()) {
      if (fs.existsSync(path.join(packageDir, fileName))) files.add(normalizeFile(path.relative(cwd, path.join(packageDir, fileName))));
    }
  }
  for (const fileName of knownProjectConfigFiles()) {
    if (fs.existsSync(path.join(cwd, fileName))) files.add(normalizeFile(fileName));
  }
  const pubspecPath = path.join(cwd, "pubspec.yaml");
  if (fs.existsSync(pubspecPath)) {
    files.add("pubspec.yaml");
    for (const dependency of readPubspecDependencies(pubspecPath)) dependencies.add(normalizeDependency(dependency));
  }
  collectExistingFiles(cwd, [".github/workflows"], files);
  return {
    dependencies: [...dependencies],
    scripts: [...scripts],
    files: [...files]
  };
}

function knownProjectConfigFiles() {
  return [
    "eas.json",
    "app.json",
    "app.config.js",
    "app.config.ts",
    "vercel.json",
    "next.config.js",
    "next.config.ts",
    "firebase.json",
    "railway.json",
    "render.yaml",
    "Dockerfile",
    "docker-compose.yml",
    "jest.config.js",
    "jest.config.ts",
    "playwright.config.js",
    "playwright.config.ts"
  ];
}

function readPubspecDependencies(filePath) {
  const dependencies = [];
  let inDependencies = false;
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (/^dependencies:\s*$/.test(line)) {
        inDependencies = true;
        continue;
      }
      if (inDependencies && /^\S/.test(line) && !/^dependencies:\s*$/.test(line)) break;
      const match = line.match(/^\s{2}([A-Za-z0-9_-]+):/);
      if (inDependencies && match) dependencies.push(match[1]);
    }
  } catch {
    return [];
  }
  return dependencies;
}

function collectExistingFiles(cwd, relativeDirs, files) {
  for (const relativeDir of relativeDirs) {
    const directory = path.join(cwd, relativeDir);
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    files.add(normalizeFile(relativeDir));
    for (const entry of entries) {
      if (entry.isFile()) files.add(normalizeFile(path.join(relativeDir, entry.name)));
    }
  }
}

function matchTextTriggers(text, triggers = []) {
  const normalizedText = normalize(text);
  const matches = [];
  for (const trigger of triggers || []) {
    const normalizedTrigger = normalize(trigger);
    if (!normalizedTrigger) continue;
    if (normalizedText.includes(normalizedTrigger)) matches.push(trigger);
  }
  return { score: matches.length ? 1 : 0, matches };
}

function matchList(values = [], triggers = []) {
  const valueSet = new Set(values.map(normalizeDependency));
  const matches = [];
  for (const trigger of triggers || []) {
    const normalizedTrigger = normalizeDependency(trigger);
    if (valueSet.has(normalizedTrigger)) matches.push(trigger);
  }
  return { score: matches.length ? 1 : 0, matches };
}

function matchFiles(files = [], triggers = []) {
  const normalizedFiles = files.map(normalizeFile);
  const matches = [];
  for (const trigger of triggers || []) {
    const normalizedTrigger = normalizeFile(trigger);
    if (!normalizedTrigger) continue;
    if (normalizedTrigger.endsWith("/*")) {
      const prefix = normalizedTrigger.slice(0, -1);
      if (normalizedFiles.some((file) => file.startsWith(prefix))) matches.push(trigger);
      continue;
    }
    if (normalizedFiles.some((file) => file === normalizedTrigger || file.endsWith(`/${normalizedTrigger}`))) matches.push(trigger);
  }
  return { score: matches.length ? 1 : 0, matches };
}

function metadataHasSignals(metadata = {}) {
  return [
    metadata.positivePrompts,
    metadata.files,
    metadata.dependencies,
    metadata.negativePrompts,
    metadata.negativeFiles,
    metadata.negativeDependencies,
    metadata.intent,
    metadata.relatedSkills,
    metadata.dependsOn,
    metadata.provides,
    metadata.requires
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function uniqueValues(value) {
  return [...new Set(asArray(value).map(String).map((item) => item.trim()).filter(Boolean))];
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function nextMeaningfulLine(lines, currentRawLine) {
  const start = lines.indexOf(currentRawLine);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.trimStart().startsWith("#")) return line;
  }
  return null;
}

function stripFrontmatter(content = "") {
  return String(content || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function skillGraphId(skill = {}) {
  return String(skill.metadata?.id || skill.name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function addSkillGraphEdge(edges, seenEdges, from, to, type) {
  const target = skillGraphId({ name: to });
  if (!from || !target) return;
  const key = `${from}\0${target}\0${type}`;
  if (seenEdges.has(key)) return;
  seenEdges.add(key);
  edges.push({ from, to: target, type });
}

function normalizeFile(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function normalizeDependency(value) {
  return String(value || "").toLowerCase().trim();
}

function addHintText(hints, value) {
  for (const token of normalize(value).split(/\s+/).filter(Boolean)) hints.add(token);
}

function enrichSkill(skill) {
  const name = String(skill.name || "");
  const description = truncateDescription(skill.description || "");
  const normalizedName = normalize(name);
  const searchTokens = [...new Set(normalize(`${name} ${description}`).split(/\s+/).filter(Boolean))];
  const nameTokens = normalizedName.split(/\s+/).filter((token) => token.length > 2);
  return {
    ...skill,
    description,
    normalizedName,
    nameTokens,
    searchTokens
  };
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
