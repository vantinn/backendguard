import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillMetadata } from "../agent-context/skill-discoverer.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const communitySkillsDir = path.join(repoRoot, "skills");
const expectedSeeds = ["eas", "jwt-auth", "nestjs", "oauth-google", "postgresql", "prisma", "redis", "security", "typeorm", "vercel"];

describe("community skill packs", () => {
  it("ships the initial seed packs", () => {
    const entries = fs.readdirSync(communitySkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => entry.name)
      .sort();

    expect(entries).toEqual(expectedSeeds);
  });

  it("keeps each pack on the routing contract", () => {
    for (const skillId of expectedSeeds) {
      const skillDir = path.join(communitySkillsDir, skillId);
      const skillPath = path.join(skillDir, "SKILL.md");
      const metadataPath = path.join(skillDir, "skill.yaml");
      const rawMetadata = fs.readFileSync(metadataPath, "utf8");
      const metadata = parseSkillMetadata(rawMetadata);

      expect(fs.existsSync(skillPath), `${skillId} missing SKILL.md`).toBe(true);
      expect(metadata.id).toBe(skillId);
      expect(metadata.name).toBeTruthy();
      expect(metadata.positivePrompts.length, `${skillId} missing prompt triggers`).toBeGreaterThan(0);
      expect(
        metadata.files.length + metadata.dependencies.length,
        `${skillId} missing project evidence triggers`
      ).toBeGreaterThan(0);
      expect(
        metadata.negativePrompts.length + metadata.negativeFiles.length + metadata.negativeDependencies.length,
        `${skillId} missing negative triggers`
      ).toBeGreaterThan(0);
      expect(rawMetadata).toMatch(/^evidence:/m);
      expect(rawMetadata).toMatch(/^workflow:/m);
    }
  });
});
