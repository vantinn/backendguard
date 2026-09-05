import path from "node:path";

import { readAgentsChain } from "../rules/agents-file-reader.js";
import { filterActionableRules, parseRules, scoreRules } from "../rules/rule-engine.js";
import { findRelevantFiles } from "./file-retriever.js";
import { enhanceRuleScoresWithEmbeddings } from "./embedding-scorer.js";
import { scanSkills, suggestSkills } from "../agent-context/skill-discoverer.js";
import { scanWorkflows, suggestWorkflows } from "../agent-context/workflow-discoverer.js";

export async function scoreContext({
  cwd = process.cwd(),
  prompt = "",
  openFiles = [],
  dataDir,
  maxFiles = 5,
  maxSkills = 3,
  maxWorkflows = 2,
  skills = null,
  workflows = null,
  embeddingTimeoutMs = 5000,
  fileEmbeddingTimeoutMs = Number(process.env.BACKENDGUARD_FILE_EMBEDDING_TIMEOUT_MS || 1000),
  skillEmbeddingTimeoutMs = Number(process.env.BACKENDGUARD_SKILL_EMBEDDING_TIMEOUT_MS || embeddingTimeoutMs),
  sectionTimeoutMs = Number(process.env.BACKENDGUARD_SECTION_TIMEOUT_MS || 0),
  skillSearchOptions = {},
  allowEmbeddings = true
} = {}) {
  const started = Date.now();
  const warnings = [];
  const ruleInputsPromise = Promise.resolve().then(() => {
    const merged = readAgentsChain({ cwd });
    const rawRules = parseRules(merged.content);
    const parsedRules = filterActionableRules(rawRules);
    return {
      merged,
      rawRules,
      parsedRules,
      baseScoredRules: scoreRules(parsedRules, prompt, openFiles)
    };
  });

  const rulesPromise = withSectionTimeout(ruleInputsPromise.then(({ merged, baseScoredRules }) => {
    if (!allowEmbeddings) {
      return {
        rules: baseScoredRules,
        status: "disabled",
        model: null,
        cachePath: dataDir
      };
    }
    return enhanceRuleScoresWithEmbeddings(baseScoredRules, prompt, {
      dataDir,
      sources: merged.sources,
      timeoutMs: embeddingTimeoutMs,
      allowRemote: false
    });
  }), sectionTimeoutMs, "rules_timeout", async () => {
    const { baseScoredRules } = await ruleInputsPromise;
    return {
      rules: baseScoredRules,
      status: "rules_timeout",
      model: null,
      cachePath: dataDir
    };
  }, warnings);

  const filesPromise = withSectionTimeout(ruleInputsPromise.then(({ baseScoredRules }) => {
    return findRelevantFiles({
      cwd,
      task: prompt,
      rules: baseScoredRules,
      dataDir,
      limit: maxFiles,
      fileEmbeddingTimeoutMs,
      fileEmbeddingOptions: {
        enabled: allowEmbeddings,
        allowRemote: false
      }
    });
  }), sectionTimeoutMs, "files_timeout", () => [], warnings);

  const skillsPromise = withSectionTimeout(Promise.resolve().then(async () => {
    const catalog = Array.isArray(skills) ? skills : scanSkills({ cwd });
    return {
      catalog,
      suggestions: await suggestSkills({
        cwd,
        prompt,
        skills: catalog,
        dataDir,
        limit: maxSkills,
        timeoutMs: skillEmbeddingTimeoutMs,
        embeddingsEnabled: allowEmbeddings,
        ...skillSearchOptions
      })
    };
  }), sectionTimeoutMs, "skills_timeout", () => ({
    catalog: Array.isArray(skills) ? skills : [],
    suggestions: []
  }), warnings);

  const workflowsPromise = withSectionTimeout(Promise.resolve().then(async () => {
    const catalog = Array.isArray(workflows) ? workflows : scanWorkflows({ cwd });
    return {
      catalog,
      suggestions: await suggestWorkflows({ prompt, workflows: catalog, dataDir, limit: maxWorkflows, embeddingsEnabled: allowEmbeddings })
    };
  }), sectionTimeoutMs, "workflows_timeout", () => ({
    catalog: Array.isArray(workflows) ? workflows : [],
    suggestions: []
  }), warnings);

  const [ruleInputs, embedding, suggestedFiles, skillResult, workflowResult] = await Promise.all([
    ruleInputsPromise,
    rulesPromise,
    filesPromise,
    skillsPromise,
    workflowsPromise
  ]);
  const { merged, rawRules, parsedRules } = ruleInputs;
  const scoredRules = embedding.rules;
  const skillCatalog = skillResult.catalog;
  const suggestedSkills = skillResult.suggestions;
  const workflowCatalog = workflowResult.catalog;
  const suggestedWorkflows = workflowResult.suggestions;

  return {
    cwd,
    prompt,
    scoredRules,
    suggestedFiles,
    suggestedSkills,
    suggestedWorkflows,
    telemetry: {
      elapsedMs: Date.now() - started,
      modelStatus: embedding.status,
      model: embedding.model,
      cachePath: embedding.cachePath,
      rulesParsed: parsedRules.length,
      rulesFiltered: rawRules.length - parsedRules.length,
      rulesInjected: scoredRules.filter((rule) => Number(rule.score || 0) >= 0.1).length,
      filesSuggested: suggestedFiles.length,
      skillsScanned: skillCatalog.length,
      skillsSuggested: suggestedSkills.length,
      workflowsScanned: workflowCatalog.length,
      workflowsSuggested: suggestedWorkflows.length,
      warnings,
      partial: warnings.length > 0,
      sources: merged.sources.map((source) => path.relative(cwd, source))
    }
  };
}

function withSectionTimeout(promise, timeoutMs, warning, fallback, warnings) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(async () => {
        warnings.push(warning);
        resolve(typeof fallback === "function" ? await fallback() : fallback);
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}
