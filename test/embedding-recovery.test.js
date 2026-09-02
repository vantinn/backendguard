import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openEmbeddingCache } from "../plugins/ctx/lib/embedding-scorer.js";

describe("embedding cache recovery", () => {
  it("quarantines malformed embedding cache files and recreates the database", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-embedding-recovery-"));
    const cachePath = path.join(dataDir, "embeddings.db");
    fs.writeFileSync(cachePath, "not a sqlite database");

    const cache = await openEmbeddingCache(dataDir);
    cache.close();

    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.readdirSync(dataDir).some((file) => file.startsWith("embeddings.db.corrupt-"))).toBe(true);
  }, 15000);
});
