#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package lifecycle verification.
 *
 * Running the CLI from a source checkout proves nothing about what npm
 * actually publishes: `package.json#files` decides that, and a directory left
 * out of it produces a package that installs cleanly and then fails on first
 * use. This script does the real thing — `npm pack`, install the tarball into
 * an empty project, and run the CLI from the installed copy.
 *
 * Run with `npm run test:package`. It is a script rather than a vitest suite
 * because it shells out to npm and takes tens of seconds.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "backendguard-pack-"));

let failures = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error: error.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split("\n")[0]}`);
  }
}

function npm(args, options = {}) {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}


/**
 * Template literals are stripped before scanning for imports: the benchmark
 * generators embed example TypeScript source as template strings, and the
 * `import` statements inside them are data, not imports of this package.
 */
function scannableSource(text) {
  return String(text).replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``");
}

console.log("BackendGuard package lifecycle\n");
console.log(`Work directory: ${workDir}\n`);

// ---------------------------------------------------------------------------
// 1. npm pack --dry-run: what would be published?
// ---------------------------------------------------------------------------
console.log("1. npm pack --dry-run");
const dryRun = JSON.parse(npm(["pack", "--dry-run", "--json"], { cwd: repoRoot }));
const manifest = dryRun[0];
const packedPaths = manifest.files.map((entry) => entry.path);

check("packs the CLI entrypoint", () => {
  assert.ok(packedPaths.includes("cli/backendguard.js"), "cli/backendguard.js missing from the tarball");
});

check("packs every source domain the CLI imports", () => {
  const required = ["rules/", "retrieval/", "analysis/", "compliance/", "agent-context/", "integrations/", "runtime/", "evaluation/"];
  for (const prefix of required) {
    assert.ok(packedPaths.some((entry) => entry.startsWith(prefix)), `no files packed under ${prefix}`);
  }
});

check("packs the agent plugin and its manifests", () => {
  for (const required of [
    "plugins/backendguard/.codex-plugin/plugin.json",
    "plugins/backendguard/hooks.json",
    "plugins/backendguard/.mcp.json",
    "plugins/backendguard/mcp/server.js",
    ".agents/plugins/marketplace.json"
  ]) {
    assert.ok(packedPaths.includes(required), `${required} missing from the tarball`);
  }
});

check("packs the shipped skill packs", () => {
  assert.ok(packedPaths.some((entry) => entry.startsWith("skills/")), "no skill packs packed");
});

check("packs the licence and security policy", () => {
  for (const required of ["LICENSE", "README.md", "SECURITY.md", "CHANGELOG.md"]) {
    assert.ok(packedPaths.includes(required), `${required} missing from the tarball`);
  }
});

check("does not pack tests, fixtures, or local state", () => {
  const forbidden = packedPaths.filter((entry) =>
    entry.startsWith("tests/")
    || entry.startsWith(".backendguard/")
    || entry.startsWith(".vscode/")
    || entry.endsWith(".bak")
    || entry.includes("node_modules/"));
  assert.deepEqual(forbidden, [], `unexpected files in the tarball: ${forbidden.join(", ")}`);
});

check("does not pack anything that looks like a secret", () => {
  const suspicious = packedPaths.filter((entry) => /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|\.npmrc$/.test(entry));
  assert.deepEqual(suspicious, [], `possible secret material in the tarball: ${suspicious.join(", ")}`);
});

check("stays within a reasonable published size", () => {
  // A CLI that ships tens of megabytes of incidental files is a smell, and the
  // number is worth failing on rather than noticing after publish.
  const megabytes = manifest.unpackedSize / 1024 / 1024;
  assert.ok(megabytes < 25, `unpacked size is ${megabytes.toFixed(1)} MB`);
});

console.log(`   ${packedPaths.length} files, ${(manifest.unpackedSize / 1024 / 1024).toFixed(2)} MB unpacked\n`);

// ---------------------------------------------------------------------------
// 2. npm pack: produce the real tarball
// ---------------------------------------------------------------------------
console.log("2. npm pack");
const tarballName = npm(["pack", "--pack-destination", workDir], { cwd: repoRoot }).trim().split("\n").pop();
const tarballPath = path.join(workDir, tarballName);
check("produces a tarball on disk", () => {
  assert.ok(fs.existsSync(tarballPath), `${tarballPath} does not exist`);
});
console.log(`   ${tarballName}\n`);

// ---------------------------------------------------------------------------
// 3. Install into a clean project
// ---------------------------------------------------------------------------
console.log("3. clean install");
const consumer = path.join(workDir, "consumer");
fs.mkdirSync(consumer, { recursive: true });
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }, null, 2));

let installed = false;
check("installs from the packed tarball", () => {
  npm(["install", tarballPath, "--no-audit", "--no-fund"], { cwd: consumer, timeout: 600_000 });
  installed = true;
});

const installedBin = path.join(consumer, "node_modules", ".bin", "backendguard");
const installedRoot = path.join(consumer, "node_modules", "@vantin", "backendguard");

function cli(args, options = {}) {
  return execFileSync(process.execPath, [path.join(installedRoot, "cli", "backendguard.js"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BACKENDGUARD_NO_UPDATE_CHECK: "1" },
    ...options
  });
}

if (installed) {
  check("links the backendguard binary", () => {
    assert.ok(fs.existsSync(installedBin), "node_modules/.bin/backendguard was not created");
  });

  check("runs --version from the installed copy", () => {
    const version = cli(["--version"]).trim();
    assert.match(version, /^\d+\.\d+\.\d+/, `unexpected version output: ${version}`);
  });

  check("runs --help from the installed copy", () => {
    assert.match(cli(["--help"]), /BackendGuard/);
  });

  check("detects a stack from the installed copy", () => {
    const project = path.join(workDir, "sample");
    fs.mkdirSync(path.join(project, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
      name: "sample", dependencies: { "@nestjs/core": "^10.0.0", "@prisma/client": "^5.0.0" }
    }));
    fs.writeFileSync(path.join(project, "prisma", "schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
    const output = cli(["stack"], { cwd: project });
    assert.match(output, /NestJS/);
    assert.match(output, /Prisma/);
    assert.match(output, /PostgreSQL/);
  });

  check("analyzes a project from the installed copy", () => {
    const project = path.join(workDir, "analyzed");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
      name: "analyzed", dependencies: { "@nestjs/core": "^10.0.0", typeorm: "^0.3.0", pg: "^8.0.0" }
    }));
    // A recognisable credential format, so this asserts the shipped detector
    // rather than the old "any string on a secret-named property" rule.
    fs.writeFileSync(path.join(project, "src", "auth.module.ts"), 'export const options = { secret: "sk_test_51H8xQ2KpL9mN3vR7wT4yU6iO" };\n');
    const output = cli(["analyze", "--json"], { cwd: project });
    const payload = JSON.parse(output);
    assert.ok(payload.findings.some((finding) => finding.id === "SEC-003"), "SEC-003 not reported from the installed copy");
  });

  check("ships the skill packs the rule library reads", () => {
    const skillsDir = path.join(installedRoot, "skills");
    assert.ok(fs.existsSync(skillsDir), "skills/ missing from the installed package");
    const packs = fs.readdirSync(skillsDir).filter((entry) => fs.existsSync(path.join(skillsDir, entry, "SKILL.md")));
    assert.ok(packs.length >= 8, `only ${packs.length} skill packs installed`);
  });

  check("ships a runnable MCP server entrypoint", () => {
    for (const required of ["integrations/mcp/server.js", "plugins/backendguard/mcp/server.js"]) {
      assert.ok(fs.existsSync(path.join(installedRoot, required)), `${required} missing from the installed package`);
    }
  });

  check("resolves every relative import in the installed package", () => {
    // The failure mode this catches: a domain directory left out of
    // package.json#files installs fine and then throws ERR_MODULE_NOT_FOUND on
    // first use.
    const broken = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.(js|mjs)$/.test(entry.name)) {
          const source = scannableSource(fs.readFileSync(full, "utf8"));
          for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)(["'])(\.[^"']+)\1/g)) {
            if (!fs.existsSync(path.resolve(path.dirname(full), match[2]))) {
              broken.push(`${path.relative(installedRoot, full)} → ${match[2]}`);
            }
          }
        }
      }
    };
    walk(installedRoot);
    assert.deepEqual(broken, [], `broken imports in the installed package:\n${broken.join("\n")}`);
  });

  check("declares every runtime dependency it imports", () => {
    const declared = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8")).dependencies || {}));
    const used = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (/\.(js|mjs)$/.test(entry.name)) {
          const source = scannableSource(fs.readFileSync(full, "utf8"));
          for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)(["'])([^."'][^"']*)\1/g)) {
            const specifier = match[2];
            if (specifier.startsWith("node:")) continue;
            used.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
          }
        }
      }
    };
    walk(installedRoot);
    const missing = [...used].filter((name) => !declared.has(name));
    assert.deepEqual(missing, [], `imported but not declared as dependencies: ${missing.join(", ")}`);
  });
}

console.log("");
console.log(`${results.filter((entry) => entry.ok).length}/${results.length} package checks passed`);
if (failures) {
  console.log(`\n${failures} check(s) failed. The package is NOT ready to publish.`);
} else {
  console.log("\nPackage lifecycle verified: pack, clean install, and CLI all work.");
}

try {
  fs.rmSync(workDir, { recursive: true, force: true });
} catch {
  console.log(`(left ${workDir} in place)`);
}

process.exitCode = failures ? 1 : 0;
