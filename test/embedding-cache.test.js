import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isModelCacheReady, modelCacheDir, openEmbeddingCache } from "../plugins/ctx/lib/embedding-scorer.js";

describe("embedding model cache", () => {
  it("detects whether the required local MiniLM model files are present", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-model-cache-"));
    expect(isModelCacheReady(dataDir)).toBe(false);

    const modelDir = path.join(modelCacheDir(dataDir), "Xenova", "all-MiniLM-L6-v2");
    fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    for (const filePath of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      path.join("onnx", "model_quantized.onnx")
    ]) {
      fs.writeFileSync(path.join(modelDir, filePath), "{}");
    }

    expect(isModelCacheReady(dataDir)).toBe(true);
  });

  it("persists indexed document vectors for direct hot-path lookup", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-index-cache-"));
    let cache = await openEmbeddingCache(dataDir);
    cache.replaceIndex("file:/repo", [
      { id: "src/moderation.ts", text: "src moderation", vector: [0.1, 0.9] }
    ]);
    cache.close();

    cache = await openEmbeddingCache(dataDir);
    expect(cache.listIndexed("file:/repo")).toEqual([
      { id: "src/moderation.ts", text: "src moderation", vector: [0.1, 0.9] }
    ]);
    cache.close();
  });
});
