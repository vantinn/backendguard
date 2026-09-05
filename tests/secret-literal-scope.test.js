import { describe, expect, it } from "vitest";

import { analyzeProject } from "../analysis/index.js";
import { makeFixture, writeFiles } from "./helpers/fixture.js";

/**
 * A value in an unambiguous credential format is a credential wherever it is
 * written.
 *
 * `KNOWN_CREDENTIAL_FORMATS` is documented as "formats that are unambiguously
 * credentials, whatever they are assigned to", but the analyzer only consulted
 * it for object property assignments whose *name* already matched a narrow
 * list. A committed Stripe live key was therefore reported only when it
 * happened to sit under a property called `secret` or `apiKey`, and missed as
 * `export const STRIPE_KEY = "sk_live_..."` — the shape a real leak takes.
 */

const PKG = JSON.stringify({
  name: "secrets-fixture",
  version: "1.0.0",
  dependencies: { "@nestjs/core": "^10.0.0", typeorm: "^0.3.20", pg: "^8.11.0" }
});

function findingsFor(source) {
  const dir = makeFixture("secret-scope");
  writeFiles(dir, { "package.json": PKG, "src/config.ts": source });
  const result = analyzeProject({ cwd: dir });
  return result.findings.filter((finding) => finding.id === "SEC-003");
}

/**
 * Credential-shaped test values are assembled at run time rather than written
 * out as literals. The analyzer sees the identical string, but the repository
 * never contains one, so this file does not trip GitHub push protection or the
 * secret scanners our own users run over their checkouts.
 */
const credential = (...parts) => parts.join("");

const STRIPE = credential("sk_", "live_", "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c");

describe("SEC-003 finds a credential-format literal wherever it is written", () => {
  const shapes = {
    "exported const": `export const STRIPE_KEY = "${STRIPE}";`,
    "module-level const": `const key = "${STRIPE}";\nexport function use() { return key; }`,
    "let binding": `export let k = "${STRIPE}";`,
    "class property": `export class Billing { private key = "${STRIPE}"; }`,
    "local const in a function": `export function f() { const k = "${STRIPE}"; return k; }`,
    "property with an unlisted name": `export const cfg = { stripeKey: "${STRIPE}" };`,
    "property with a listed name": `export const cfg = { apiKey: "${STRIPE}" };`,
    "array element": `export const keys = ["${STRIPE}"];`,
    "default parameter": `export function f(k = "${STRIPE}") { return k; }`
  };

  for (const [name, source] of Object.entries(shapes)) {
    it(`reports a Stripe live key as ${name}`, () => {
      const findings = findingsFor(source);
      expect(findings.length, `${name}: ${JSON.stringify(findings)}`).toBeGreaterThan(0);
      expect(findings[0].severity).toBe("HIGH");
      expect(findings[0].confidence).toBe("certain");
    });
  }

  it("reports other unambiguous credential formats too", () => {
    for (const [what, value] of [
      ["GitHub token", credential("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a")],
      ["AWS access key", credential("AKIA", "IOSFODNN7EXAMPLE")],
      ["Google API key", credential("AIza", "SyD-1234567890abcdefghijklmnopqrstu")],
      ["Slack token", credential("xoxb", "-123456789012-abcdefghijklmnop")],
      ["connection URI", credential("postgres://admin:", "hunter2", "@db.prod.example.com:5432/app")]
    ]) {
      const findings = findingsFor(`export const V = ${JSON.stringify(value)};`);
      expect(findings.length, what).toBeGreaterThan(0);
    }
  });

  it("reports each distinct literal once, not once per reference", () => {
    const findings = findingsFor(`export const A = "${STRIPE}";\nexport function use() { return A; }`);
    expect(findings.length).toBe(1);
  });
});

describe("SEC-003 stays quiet on values that are names, not credentials", () => {
  const quiet = {
    "env var names": `export const ENV = { secret: "JWT_SIGNING_SECRET", apiKey: "PARTNER_API_KEY" };`,
    "header names": `export const H = { apiKey: "x-api-key", auth: "Authorization" };`,
    "env reads": `export const c = { secret: process.env.JWT_SECRET };`,
    "localhost dsn": `export const url = "postgres://postgres:postgres@localhost:5432/dev";`,
    "placeholder": `export const k = "your-api-key-here";`,
    "short identifier": `export const mode = "production";`,
    "dotted config key": `export const k = "billing.stripe.key";`,
    "module path": `export const p = "@nestjs/common";`,
    "test-looking value": `export const t = "example";`
  };

  for (const [name, source] of Object.entries(quiet)) {
    it(`does not report ${name}`, () => {
      expect(findingsFor(source), name).toEqual([]);
    });
  }
});
