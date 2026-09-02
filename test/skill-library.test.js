import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseSkillEntries,
  getLibrariesForAgents,
  fetchLibrarySkills,
  fetchSkillsForAgents,
  formatAsSelectOptions,
  printSkillRecommendations,
  getAllLibraries
} from "../plugins/ctx/lib/skill-library.js";

describe("skill-library", () => {
  describe("parseSkillEntries", () => {
    it("extracts markdown link list items", () => {
      const readme = `
# Awesome Skills

## Category A

- [Skill One](https://github.com/org/skill-one) - First skill description
- [Skill Two](https://example.com/skill-two) — Second skill
- **[Bold Skill](https://example.com/bold)** - Bold description
- [Image Link](https://example.com/image.png) - Should be skipped
- [Section Link](#section) - Should be skipped
* [Asterisk Item](https://example.com/ast) - Asterisk style
`;
      const entries = parseSkillEntries(readme);
      expect(entries.length).toBe(4);
      expect(entries[0]).toMatchObject({ name: "Skill One", url: "https://github.com/org/skill-one" });
      expect(entries[0].description).toContain("First skill description");
      expect(entries[1].name).toBe("Skill Two");
      expect(entries[2].name).toBe("Bold Skill");
      expect(entries[3].name).toBe("Asterisk Item");
    });

    it("handles empty readme", () => {
      expect(parseSkillEntries("")).toEqual([]);
      expect(parseSkillEntries("# Just a title\n\nNo links here.")).toEqual([]);
    });

    it("skips image and anchor links", () => {
      const readme = `
- [Badge](https://img.shields.io/badge.svg) - badge
- [Section](#installation) - link to section
- [Real Skill](https://github.com/org/real) - real one
`;
      const entries = parseSkillEntries(readme);
      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe("Real Skill");
    });
  });

  describe("getLibrariesForAgents", () => {
    it("returns all libraries for all agents", () => {
      const libs = getLibrariesForAgents(["codex", "claude", "agy", "copilot"]);
      expect(libs.length).toBe(4);
    });

    it("returns antigravity-awesome for any agent (universal)", () => {
      const libs = getLibrariesForAgents(["codex"]);
      const ids = libs.map((l) => l.id);
      expect(ids).toContain("antigravity-awesome");
      expect(ids).toContain("awesome-codex");
    });

    it("returns claude-specific libraries for claude", () => {
      const libs = getLibrariesForAgents(["claude"]);
      const ids = libs.map((l) => l.id);
      expect(ids).toContain("awesome-claude");
      expect(ids).toContain("antigravity-awesome"); // universal
    });

    it("returns copilot-specific libraries for copilot", () => {
      const libs = getLibrariesForAgents(["copilot"]);
      const ids = libs.map((l) => l.id);
      expect(ids).toContain("awesome-copilot");
    });

    it("normalizes 'antigravity' to 'agy'", () => {
      const libs = getLibrariesForAgents(["antigravity"]);
      expect(libs.length).toBeGreaterThan(0);
    });

    it("returns empty for unknown agent", () => {
      const libs = getLibrariesForAgents(["unknown"]);
      // antigravity-awesome is universal for known agents only
      // actually antigravity-awesome matches agy/codex/claude/copilot, not "unknown"
      expect(libs.length).toBe(0);
    });
  });

  describe("getAllLibraries", () => {
    it("returns 4 library definitions", () => {
      const libs = getAllLibraries();
      expect(libs.length).toBe(4);
      expect(libs.every((l) => l.id && l.name && l.url && l.rawReadmeUrl)).toBe(true);
    });
  });

  describe("fetchLibrarySkills", () => {
    let tmp;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-lib-"));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("reads from cache when available", async () => {
      const cacheDir = path.join(tmp, "skill-library-cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      const cacheData = {
        fetchedAt: Date.now(),
        entries: [
          { name: "Cached Skill", url: "https://example.com", description: "From cache" }
        ]
      };
      fs.writeFileSync(path.join(cacheDir, "test-lib.json"), JSON.stringify(cacheData));

      const lib = { id: "test-lib", rawReadmeUrl: "https://example.com/readme" };
      const result = await fetchLibrarySkills(lib, { dataDir: tmp });
      expect(result.source).toBe("cache");
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].name).toBe("Cached Skill");
    });

    it("returns empty on network error without cache", async () => {
      const lib = {
        id: "nonexistent",
        rawReadmeUrl: "https://localhost:1/nonexistent-readme"
      };
      const result = await fetchLibrarySkills(lib, { dataDir: tmp });
      expect(result.source).toBe("error");
      expect(result.entries).toEqual([]);
    });
  });

  describe("formatAsSelectOptions", () => {
    it("formats library results as select options with headers", () => {
      const results = [{
        library: { id: "test", name: "Test Library", url: "https://example.com" },
        entries: [
          { name: "Skill A", url: "https://a.com", description: "First" },
          { name: "Skill B", url: "https://b.com", description: "Second" }
        ],
        count: 2
      }];

      const options = formatAsSelectOptions(results);
      expect(options.length).toBe(3); // 1 header + 2 skills
      expect(options[0].isHeader).toBe(true);
      expect(options[0].disabled).toBe(true);
      expect(options[1].value).toBe("https://a.com");
      expect(options[2].value).toBe("https://b.com");
    });

    it("limits entries to 30 per library", () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        name: `Skill ${i}`, url: `https://s${i}.com`, description: ""
      }));
      const results = [{
        library: { id: "big", name: "Big Library", url: "https://big.com" },
        entries,
        count: 50
      }];

      const options = formatAsSelectOptions(results);
      // 1 header + 30 skills + 1 "more" footer
      expect(options.length).toBe(32);
      expect(options[31].label).toContain("20 more");
    });

    it("skips empty libraries", () => {
      const results = [{
        library: { id: "empty", name: "Empty", url: "https://empty.com" },
        entries: [],
        count: 0
      }];
      expect(formatAsSelectOptions(results)).toEqual([]);
    });
  });

  describe("printSkillRecommendations", () => {
    it("prints nothing when no skills available", () => {
      const lines = [];
      printSkillRecommendations([], { logger: (msg) => lines.push(msg) });
      expect(lines.length).toBe(0);
    });

    it("prints recommendations for available libraries", () => {
      const lines = [];
      const results = [{
        library: {
          id: "test",
          name: "Test Skills",
          url: "https://example.com",
          description: "Test library"
        },
        entries: [
          { name: "Skill A", url: "https://a.com", description: "First skill" }
        ],
        source: "cache",
        count: 1
      }];

      printSkillRecommendations(results, { logger: (msg) => lines.push(msg) });
      const joined = lines.join("\n");
      expect(joined).toContain("Community skill libraries");
      expect(joined).toContain("Test Skills");
      expect(joined).toContain("Skill A");
      expect(joined).toContain("backendguard rules");
    });
  });
});
