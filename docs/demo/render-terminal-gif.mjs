#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , inputPath, outputPath = "docs/demo/backendguard-demo.gif"] = process.argv;
if (!inputPath) {
  console.error("Usage: node docs/demo/render-terminal-gif.mjs <terminal-log> [output.gif]");
  process.exit(1);
}

const width = 960;
const height = 540;
const marginX = 52;
const marginY = 54;
const lineHeight = 18;
const maxLines = 22;
const maxColumns = 100;
const frameStep = 5;

const raw = fs.readFileSync(inputPath, "utf8");
const lines = clean(raw)
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter((line) => line && !line.includes("Script started") && !line.includes("Script done"));

const displayLines = wrapLines(lines, maxColumns).slice(0, 110);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-demo-frames-"));
const frames = [];

for (let count = 1; count <= displayLines.length; count += frameStep) {
  frames.push(writeFrame({ tmpDir, index: frames.length, lines: displayLines.slice(0, count) }));
}
frames.push(writeFrame({ tmpDir, index: frames.length, lines: displayLines }));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
execFileSync("convert", ["-limit", "time", "120", "-delay", "12", "-loop", "0", ...frames, outputPath], { stdio: "inherit" });
console.log(`Wrote ${outputPath}`);

function writeFrame({ tmpDir, index, lines }) {
  const visible = lines.slice(-maxLines);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#0f1419"/>`,
    `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="16" fill="#151b22" stroke="#34404d"/>`,
    `<circle cx="56" cy="50" r="6" fill="#ff6b6b"/><circle cx="78" cy="50" r="6" fill="#ffd166"/><circle cx="100" cy="50" r="6" fill="#70d88b"/>`,
    `<text x="124" y="57" fill="#9aa6b2" font-family="DejaVu Sans Mono, Consolas, monospace" font-size="15">BackendGuard actual terminal demo</text>`,
    `<text x="${marginX}" y="${marginY + 30}" fill="#d8dee9" font-family="DejaVu Sans Mono, Consolas, monospace" font-size="15">`
  ];
  visible.forEach((line, offset) => {
    const y = offset === 0 ? 0 : lineHeight;
    svg.push(`<tspan x="${marginX}" dy="${y}" fill="${colorForLine(line)}">${escapeXml(line)}</tspan>`);
  });
  svg.push("</text></svg>");
  const filePath = path.join(tmpDir, `frame-${String(index).padStart(4, "0")}.svg`);
  fs.writeFileSync(filePath, svg.join(""));
  return filePath;
}

function clean(value) {
  return String(value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, "\n");
}

function wrapLines(sourceLines, widthLimit) {
  const wrapped = [];
  for (const line of sourceLines) {
    if (line.length <= widthLimit) {
      wrapped.push(line);
      continue;
    }
    for (let index = 0; index < line.length; index += widthLimit) {
      wrapped.push(`${index === 0 ? "" : "  "}${line.slice(index, index + widthLimit)}`);
    }
  }
  return wrapped;
}

function colorForLine(line) {
  if (line.startsWith("$ ")) return "#8bd5ff";
  if (/^(BackendGuard debug|BackendGuard report|Final additionalContext|Suggested files|Suggested workflows)/.test(line)) return "#ffd166";
  if (/^(hook:|mcp:)/.test(line)) return "#9ad97f";
  if (/^(codex|user|OpenAI Codex)/.test(line)) return "#c792ea";
  if (/^#|^[-—]+$/.test(line)) return "#8a96a3";
  return "#d8dee9";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
