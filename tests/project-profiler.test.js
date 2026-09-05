import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fusedProjectQuery, projectProfile } from "../analysis/project-profiler.js";

describe("project profiler", () => {
  it("builds an embeddable project signal from package metadata and recent git files", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-project-profile-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-project-profile-data-"));
    fs.mkdirSync(path.join(cwd, "services", "api", "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["services/*"],
      dependencies: {
        fastify: "^5.0.0",
        prisma: "^6.0.0"
      }
    }));
    fs.writeFileSync(path.join(cwd, "services", "api", "package.json"), JSON.stringify({
      dependencies: {
        "@nestjs/platform-fastify": "^11.0.0",
        redis: "^5.0.0"
      },
      devDependencies: {
        typescript: "^5.0.0",
        vitest: "^3.0.0"
      }
    }));
    fs.writeFileSync(path.join(cwd, "services", "api", "src", "upload.service.ts"), "export class UploadService {}\n");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ctx@example.com"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "BackendGuard"], { cwd, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });

    const profile = projectProfile({ cwd, dataDir });
    const query = fusedProjectQuery({ prompt: "kiểm tra flow kiểm duyệt upload", cwd, dataDir });

    expect(profile.embeddableString).toContain("fastify");
    expect(profile.embeddableString).toContain("prisma");
    expect(profile.embeddableString).toContain("@nestjs/platform-fastify");
    expect(profile.embeddableString).toContain("TypeScript");
    expect(profile.embeddableString).toContain("upload.service.ts");
    expect(query).toContain("kiểm tra flow kiểm duyệt upload");
    expect(query).toContain("[project packages:");
  });
});
