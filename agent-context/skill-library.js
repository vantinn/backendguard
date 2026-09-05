import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import os from "node:os";

/**
 * Curated skill library sources, mapped by agent.
 *
 * Each source provides a GitHub repo with a README that lists available skills.
 * We fetch the README, parse skill entries, and let the user pick from a
 * multi-select panel after agent selection in `backendguard install` or `backendguard setup`.
 */

const SKILL_LIBRARIES = [
  {
    id: "antigravity-awesome",
    name: "Antigravity Awesome Skills",
    repo: "sickn33/antigravity-awesome-skills",
    url: "https://github.com/sickn33/antigravity-awesome-skills",
    rawReadmeUrl: "https://raw.githubusercontent.com/sickn33/antigravity-awesome-skills/main/README.md",
    agents: ["agy", "claude", "codex", "copilot"],   // universal library
    description: "1,400+ agentic skills for all agents",
    install: {
      type: "npx",
      fullInstall: "npx antigravity-awesome-skills",
      agentFlags: {
        codex: "npx antigravity-awesome-skills --codex",
        claude: "npx antigravity-awesome-skills --claude",
        agy: "npx antigravity-awesome-skills --antigravity",
        copilot: "npx antigravity-awesome-skills --cursor",
        gemini: "npx antigravity-awesome-skills --gemini"
      },
      verify: 'test -d ~/.agents/skills && echo "Skills installed in ~/.agents/skills"'
    }
  },
  {
    id: "awesome-claude",
    name: "Awesome Claude Skills",
    repo: "ComposioHQ/awesome-claude-skills",
    url: "https://github.com/ComposioHQ/awesome-claude-skills",
    rawReadmeUrl: "https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master/README.md",
    agents: ["claude"],
    description: "Curated Claude Code skills & workflows",
    install: {
      type: "git-clone",
      clone: "git clone https://github.com/ComposioHQ/awesome-claude-skills.git",
      skillDir: "~/.claude/skills",
      copyCommand: (skillName) =>
        `cp -r awesome-claude-skills/${skillName} ~/.claude/skills/${skillName}`,
      fullInstall: [
        "git clone https://github.com/ComposioHQ/awesome-claude-skills.git",
        "mkdir -p ~/.claude/skills",
        'for d in awesome-claude-skills/*/; do [ -f "$d/SKILL.md" ] && cp -r "$d" ~/.claude/skills/; done'
      ].join(" && "),
      verify: 'ls ~/.claude/skills/'
    }
  },
  {
    id: "awesome-codex",
    name: "Awesome Codex Skills",
    repo: "ComposioHQ/awesome-codex-skills",
    url: "https://github.com/ComposioHQ/awesome-codex-skills",
    rawReadmeUrl: "https://raw.githubusercontent.com/ComposioHQ/awesome-codex-skills/master/README.md",
    agents: ["codex"],
    description: "Practical Codex CLI skills & automations",
    install: {
      type: "git-clone-python",
      clone: "git clone https://github.com/ComposioHQ/awesome-codex-skills.git",
      skillDir: "~/.codex/skills",
      installScript: (skillName) =>
        `python awesome-codex-skills/skill-installer/scripts/install-skill-from-github.py --repo ComposioHQ/awesome-codex-skills --path ${skillName}`,
      fullInstall: [
        "git clone https://github.com/ComposioHQ/awesome-codex-skills.git",
        "cd awesome-codex-skills",
        "mkdir -p ~/.codex/skills",
        'for d in */; do [ -f "$d/SKILL.md" ] && [ "$d" != "skill-installer/" ] && cp -r "$d" ~/.codex/skills/; done'
      ].join(" && "),
      verify: 'ls ~/.codex/skills/'
    }
  },
  {
    id: "awesome-copilot",
    name: "Awesome Copilot",
    repo: "github/awesome-copilot",
    url: "https://github.com/github/awesome-copilot",
    rawReadmeUrl: "https://raw.githubusercontent.com/github/awesome-copilot/main/README.md",
    agents: ["copilot"],
    description: "Community GitHub Copilot instructions & agents",
    install: {
      type: "manual",
      fullInstall: null,
      instructions: "Browse the repository and copy relevant .instructions.md files to your .github/ directory.",
      url: "https://github.com/github/awesome-copilot"
    }
  }
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// ────────────────────────────── HTTP fetch ────────────────────────────────

/** A README is tens of kilobytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * Fetches a skill-library README.
 *
 * Redirects are followed, but bounded and restricted to https: an unbounded
 * recursive follow means a server answering 302 with its own URL recurses
 * until the stack runs out, and following a redirect to http would silently
 * downgrade the transport. The body is capped for the same reason a timeout
 * exists — this runs against a third-party host BackendGuard does not control.
 */
function fetchUrl(url, timeoutMs = 10000, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid skill library URL: ${url}`));
      return;
    }
    if (target.protocol !== "https:") {
      reject(new Error(`Refusing to fetch a skill library over ${target.protocol.replace(":", "")}: ${url}`));
      return;
    }

    const req = https.get(target, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(res.headers.location, target).toString();
        fetchUrl(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error(`Response from ${url} exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on("error", reject);
  });
}

// ────────────────────────────── README parser ─────────────────────────────

/**
 * Parse a GitHub awesome-list README and extract skill entries.
 *
 * Looks for markdown links in list items:
 *   - [Skill Name](url) - Description
 *   - **[Skill Name](url)** — Description
 *
 * Returns: Array<{ name, url, description }>
 */
export function parseSkillEntries(readmeContent) {
  const entries = [];
  const lines = readmeContent.split("\n");
  // Match list items with markdown links
  const linkPattern = /^[-*]\s+\**\[([^\]]+)\]\(([^)]+)\)\**\s*[-–—:]*\s*(.*)/;
  for (const line of lines) {
    const match = line.match(linkPattern);
    if (!match) continue;
    const [, name, url, description] = match;
    // Skip non-skill links (images, badges, section headers)
    if (/\.(png|jpg|svg|gif)$/i.test(url)) continue;
    if (url.startsWith("#")) continue;
    entries.push({
      name: name.trim(),
      url: url.trim(),
      description: (description || "").replace(/^\s*[-–—:]+\s*/, "").trim()
    });
  }
  return entries;
}

// ────────────────────────────── Cache layer ────────────────────────────────

function cacheDir(dataDir) {
  return path.join(dataDir, "skill-library-cache");
}

function cacheFilePath(dataDir, libraryId) {
  return path.join(cacheDir(dataDir), `${libraryId}.json`);
}

function readCache(dataDir, libraryId) {
  const filePath = cacheFilePath(dataDir, libraryId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - (data.fetchedAt || 0) < CACHE_TTL_MS) {
      return data.entries || [];
    }
  } catch { /* cache miss */ }
  return null;
}

function writeCache(dataDir, libraryId, entries) {
  const dir = cacheDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const data = { fetchedAt: Date.now(), entries };
  fs.writeFileSync(cacheFilePath(dataDir, libraryId), JSON.stringify(data, null, 2));
}

// ────────────────────────────── Public API ─────────────────────────────────

/**
 * Get libraries relevant to selected agents.
 */
export function getLibrariesForAgents(selectedAgents) {
  const normalized = selectedAgents.map((a) => a.toLowerCase().replace("antigravity", "agy"));
  return SKILL_LIBRARIES.filter((lib) =>
    lib.agents.some((agent) => normalized.includes(agent))
  );
}

/**
 * Fetch skill entries from a library (with caching).
 */
export async function fetchLibrarySkills(library, { dataDir, forceRefresh = false } = {}) {
  if (dataDir && !forceRefresh) {
    const cached = readCache(dataDir, library.id);
    if (cached) return { entries: cached, source: "cache" };
  }

  try {
    const readme = await fetchUrl(library.rawReadmeUrl);
    const entries = parseSkillEntries(readme);
    if (dataDir && entries.length > 0) {
      writeCache(dataDir, library.id, entries);
    }
    return { entries, source: "network" };
  } catch (error) {
    // Try cache even if expired on network failure
    if (dataDir) {
      try {
        const filePath = cacheFilePath(dataDir, library.id);
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        return { entries: data.entries || [], source: "stale-cache" };
      } catch { /* no cache at all */ }
    }
    return { entries: [], source: "error", error: error.message };
  }
}

/**
 * Fetch skills from all relevant libraries for selected agents.
 * Returns a flat list grouped by library.
 */
export async function fetchSkillsForAgents(selectedAgents, { dataDir } = {}) {
  const libraries = getLibrariesForAgents(selectedAgents);
  const results = [];

  for (const lib of libraries) {
    const { entries, source } = await fetchLibrarySkills(lib, { dataDir });
    results.push({
      library: lib,
      entries,
      source,
      count: entries.length
    });
  }

  return results;
}

/**
 * Format skill library results as multi-select options.
 * Groups by library with a header option (disabled).
 */
export function formatAsSelectOptions(libraryResults) {
  const options = [];
  for (const result of libraryResults) {
    if (result.entries.length === 0) continue;
    // Add library header as separator
    options.push({
      label: `── ${result.library.name} (${result.count} skills) ──`,
      value: `__header__${result.library.id}`,
      disabled: true,
      isHeader: true
    });
    // Add top skills (limit to prevent overwhelming the user)
    const topEntries = result.entries.slice(0, 30);
    for (const entry of topEntries) {
      const desc = entry.description ? ` — ${entry.description.slice(0, 60)}` : "";
      options.push({
        label: `${entry.name}${desc}`,
        value: entry.url,
        selected: false,
        libraryId: result.library.id,
        skillName: entry.name
      });
    }
    if (result.entries.length > 30) {
      options.push({
        label: `  ... and ${result.entries.length - 30} more at ${result.library.url}`,
        value: `__more__${result.library.id}`,
        disabled: true,
        isHeader: true
      });
    }
  }
  return options;
}

/**
 * Print a compact recommendation panel to the terminal.
 * Used after agent selection in `backendguard install` and `backendguard setup`.
 */
export function printSkillRecommendations(libraryResults, { logger = console.log } = {}) {
  const DIM = "\x1B[2m";
  const RESET = "\x1B[0m";
  const CYAN = "\x1B[36m";
  const GREEN = "\x1B[32m";
  const YELLOW = "\x1B[33m";
  const BOLD = "\x1B[1m";

  const hasSkills = libraryResults.some((r) => r.entries.length > 0);
  if (!hasSkills) return;

  logger("");
  logger(`${CYAN}◇${RESET} ${BOLD}Community skill libraries available:${RESET}`);
  logger(`${DIM}│${RESET}  Browse and install curated skills from the community.`);
  logger(`${DIM}│${RESET}`);

  for (const result of libraryResults) {
    if (result.entries.length === 0) continue;
    const badge = result.source === "cache" ? `${DIM}(cached)${RESET}` : "";
    logger(`${DIM}│${RESET}  ${GREEN}●${RESET} ${BOLD}${result.library.name}${RESET} ${badge}`);
    logger(`${DIM}│${RESET}    ${result.count} skills · ${result.library.description}`);
    logger(`${DIM}│${RESET}    ${DIM}${result.library.url}${RESET}`);

    // Show top 5 skills as preview
    const preview = result.entries.slice(0, 5);
    for (const skill of preview) {
      const desc = skill.description ? ` ${DIM}— ${skill.description.slice(0, 50)}${RESET}` : "";
      logger(`${DIM}│${RESET}      ${YELLOW}▸${RESET} ${skill.name}${desc}`);
    }
    if (result.entries.length > 5) {
      logger(`${DIM}│${RESET}      ${DIM}... and ${result.entries.length - 5} more${RESET}`);
    }
    logger(`${DIM}│${RESET}`);
  }

  logger(`${DIM}│${RESET}  ${DIM}Run ${CYAN}backendguard rules${RESET}${DIM} to browse and install backend rule packs.${RESET}`);
}

/**
 * Get all library definitions.
 */
export function getAllLibraries() {
  return SKILL_LIBRARIES;
}

/**
 * Get install commands for a specific library.
 * @param {string} libraryId
 * @param {string} [agent] - optional agent to target
 * @returns {{ fullInstall: string|null, agentInstall: string|null, verify: string|null, instructions: string|null, type: string }}
 */
export function getInstallCommands(libraryId, agent) {
  const lib = SKILL_LIBRARIES.find((l) => l.id === libraryId);
  if (!lib || !lib.install) return null;

  const inst = lib.install;
  const result = {
    type: inst.type,
    fullInstall: typeof inst.fullInstall === "string" ? inst.fullInstall : null,
    agentInstall: null,
    verify: inst.verify || null,
    instructions: inst.instructions || null,
    url: inst.url || lib.url
  };

  // Agent-specific install (only for npx-based libs)
  if (agent && inst.agentFlags) {
    const normalized = agent.toLowerCase().replace("antigravity", "agy");
    result.agentInstall = inst.agentFlags[normalized] || null;
  }

  return result;
}
