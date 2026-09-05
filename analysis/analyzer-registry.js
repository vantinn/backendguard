/**
 * The extensibility seam.
 *
 * An analyzer is a plain object — no base class, no DI container:
 *
 *   {
 *     id: "prisma",
 *     title: "Prisma",
 *     categories: ["Database", "Performance"],
 *     // Optional: skip the analyzer entirely when the project doesn't use the
 *     // technology. Keeps runtime down and, more importantly, keeps a project
 *     // that has never heard of Prisma from receiving Prisma findings.
 *     appliesTo: ({ stack, index }) => boolean,
 *     // Required: return Finding[].
 *     analyze: ({ index, cwd, stack, changedFiles }) => Finding[]
 *   }
 *
 * Adding support for a new framework/ORM/database means writing one such object
 * and registering it here. Nothing else in the codebase changes.
 */

import { dedupeFindings } from "./finding.js";

export function createRegistry(analyzers = []) {
  const byId = new Map();
  for (const analyzer of analyzers) register(byId, analyzer);

  return {
    register(analyzer) {
      register(byId, analyzer);
      return this;
    },
    get(id) {
      return byId.get(id) || null;
    },
    list() {
      return [...byId.values()];
    },
    /** Analyzers whose `appliesTo` accepts this project (or that declare none). */
    applicable(context) {
      return [...byId.values()].filter((analyzer) => {
        if (typeof analyzer.appliesTo !== "function") return true;
        try {
          return Boolean(analyzer.appliesTo(context));
        } catch {
          return false;
        }
      });
    },
    /**
     * Runs every applicable analyzer. One analyzer throwing must not lose the
     * findings of the others, so failures are collected and reported rather
     * than propagated — a crash in the Prisma checks should not hide a
     * hardcoded credential found by the security checks.
     */
    run(context) {
      const findings = [];
      const errors = [];
      const ran = [];
      for (const analyzer of this.applicable(context)) {
        try {
          const produced = analyzer.analyze(context) || [];
          for (const finding of produced) {
            findings.push(finding.analyzer ? finding : { ...finding, analyzer: analyzer.id });
          }
          ran.push(analyzer.id);
        } catch (error) {
          errors.push({ analyzer: analyzer.id, message: error.message });
        }
      }
      return { findings: dedupeFindings(findings), ran, errors };
    }
  };
}

function register(byId, analyzer) {
  if (!analyzer || typeof analyzer.id !== "string" || !analyzer.id) {
    throw new Error("An analyzer must have a non-empty string id.");
  }
  if (typeof analyzer.analyze !== "function") {
    throw new Error(`Analyzer "${analyzer.id}" must implement analyze().`);
  }
  if (byId.has(analyzer.id)) {
    throw new Error(`Analyzer "${analyzer.id}" is already registered.`);
  }
  byId.set(analyzer.id, analyzer);
}
