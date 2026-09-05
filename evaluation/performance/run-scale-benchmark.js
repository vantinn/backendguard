#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeProject } from "../../analysis/index.js";
import { detectStack } from "../../analysis/stack-detector.js";
import { buildSourceIndex } from "../../analysis/source-index.js";

/**
 * Scale benchmark: how long does analysis take on a non-trivial repository?
 *
 * A generated corpus is used rather than a checked-in one so the numbers are
 * reproducible on any machine and the repository stays small. The generated
 * modules are realistic in *shape* (controller + service + entity + DTO per
 * module, a fraction of them containing a planted defect), which is what
 * determines parser and analyzer cost.
 *
 * The output is wall-clock time on the machine that ran it. It is a regression
 * signal — "did this change make analysis ten times slower" — not a published
 * performance claim.
 */

const SIZES = [100, 500];

export function generateProject(root, moduleCount) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "scale-fixture",
    dependencies: { "@nestjs/core": "^10.4.0", "@nestjs/typeorm": "^10.0.2", typeorm: "^0.3.20", pg: "^8.12.0" }
  }, null, 2));

  for (let index = 0; index < moduleCount; index += 1) {
    const name = `mod${index}`;
    const dir = path.join(root, "src", name);
    fs.mkdirSync(dir, { recursive: true });
    // Every fifth module carries a defect, so the analyzers do real work rather
    // than early-exiting on clean files.
    const defective = index % 5 === 0;

    fs.writeFileSync(path.join(dir, `${name}.entity.ts`), `
import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class ${cap(name)} {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  ${defective ? "@Column()" : "@Index()\n  @Column({ unique: true })"}
  reference: string;

  @Column()
  passwordHash: string;
}
`);

    fs.writeFileSync(path.join(dir, `${name}.service.ts`), `
import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm";
import { ${cap(name)} } from "./${name}.entity";

@Injectable()
export class ${cap(name)}Service {
  constructor(private readonly ${name}Repo: Repository<${cap(name)}>) {}

  async list() {
    return this.${name}Repo.find(${defective ? "" : "{ take: 25, skip: 0 }"});
  }

  async findById(id: string) {
    const row = await this.${name}Repo.findOne({ where: { id } });
    return row;
  }
}
`);

    fs.writeFileSync(path.join(dir, `${name}.controller.ts`), `
import { Body, Controller, Get, Post${defective ? "" : ", UseGuards"} } from "@nestjs/common";
import { ${cap(name)}Service } from "./${name}.service";

@Controller("${name}")
${defective ? "" : "@UseGuards(AuthGuard)"}
export class ${cap(name)}Controller {
  constructor(private readonly service: ${cap(name)}Service) {}

  @Get()
  async list() {
    return this.service.list();
  }

  @Post()
  async create(@Body() body: ${defective ? "any" : `Create${cap(name)}Dto`}) {
    return body;
  }
}
`);

    fs.writeFileSync(path.join(dir, `create-${name}.dto.ts`), `
import { IsString } from "class-validator";

export class Create${cap(name)}Dto {
  @IsString()
  reference: string;
}
`);
  }
  return root;
}

function cap(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function timed(label, fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { label, ms: Math.round(ms), value };
}

export function runScaleBenchmark({ sizes = SIZES } = {}) {
  const rows = [];
  for (const moduleCount of sizes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `backendguard-scale-${moduleCount}-`));
    try {
      generateProject(root, moduleCount);
      const fileCount = moduleCount * 4;

      const stack = timed("stack detection", () => detectStack({ cwd: root }));
      const index = timed("parse + index", () => buildSourceIndex({ cwd: root }));
      const analysis = timed("full analysis", () => analyzeProject({ cwd: root, stack: stack.value }));

      rows.push({
        modules: moduleCount,
        files: fileCount,
        filesAnalyzed: analysis.value.filesAnalyzed,
        findings: analysis.value.findings.length,
        stackMs: stack.ms,
        indexMs: index.ms,
        analysisMs: analysis.ms,
        msPerFile: Number((analysis.ms / Math.max(analysis.value.filesAnalyzed, 1)).toFixed(2))
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  return { rows, node: process.version, platform: `${process.platform}/${process.arch}` };
}

export function formatScaleBenchmark(result) {
  const lines = [
    "Scale benchmark (generated NestJS + TypeORM corpus)",
    `Node ${result.node} on ${result.platform}`,
    ""
  ];
  lines.push("files  analyzed  findings  stack(ms)  index(ms)  analysis(ms)  ms/file");
  for (const row of result.rows) {
    lines.push([
      String(row.files).padEnd(7),
      String(row.filesAnalyzed).padEnd(10),
      String(row.findings).padEnd(10),
      String(row.stackMs).padEnd(11),
      String(row.indexMs).padEnd(11),
      String(row.analysisMs).padEnd(14),
      String(row.msPerFile)
    ].join(""));
  }
  lines.push("");
  lines.push("Wall-clock time on the machine that ran this. Use it to spot a regression,");
  lines.push("not as a published performance figure.");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runScaleBenchmark();
  console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : formatScaleBenchmark(result));
}
