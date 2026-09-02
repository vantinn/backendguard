import fs from "node:fs";
import { resolveHookCwd } from "../../lib/hook-io.js";

export function antigravityCwd(payload) {
  return payload.cwd
    || payload.working_directory
    || payload.workspacePath
    || payload.workspacePaths?.[0]
    || resolveHookCwd(payload);
}

function textFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (typeof value.message === "string") return value.message;
  if (typeof value.userMessage === "string") return value.userMessage;
  if (Array.isArray(value.parts)) return textFromValue(value.parts);
  if (Array.isArray(value.content)) return textFromValue(value.content);
  return "";
}

function looksUserAuthored(record) {
  const role = String(record.role || record.author || record.type || record.sender || "").toLowerCase();
  return !role || role.includes("user") || role.includes("human");
}

export function extractPromptFromAntigravityPayload(payload) {
  const direct = payload.prompt || payload.userPrompt || payload.userMessage || payload.message;
  if (direct) return textFromValue(direct);

  const transcriptPath = payload.transcriptPath || payload.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";

  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-200);
    for (const line of lines.reverse()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!looksUserAuthored(record)) continue;
      const text = textFromValue(record.prompt || record.userPrompt || record.userMessage || record.message || record.content || record.parts);
      if (text.trim()) return text.trim();
    }
  } catch {
    return "";
  }

  return "";
}
