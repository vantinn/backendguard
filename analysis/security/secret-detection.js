/**
 * Deciding whether a string literal is actually a credential.
 *
 * The previous rule was "a property named `secret`/`apiKey`/`password` holding
 * any string literal of 4+ characters is a hardcoded secret, at `certain`
 * confidence". That is wrong for the single most common config shape in real
 * backends — a map from a config key to the *name* of the environment variable
 * that supplies it:
 *
 *   export const ENV_KEYS = { secret: "JWT_SIGNING_SECRET", apiKey: "PARTNER_API_KEY" };
 *
 * An adversarial audit against realistic fixtures produced 4 false positives
 * for every true positive on that shape, all at the highest confidence tier.
 *
 * The rule here is inverted: a value is a credential only on **positive
 * evidence** — a recognised credential format, a URI carrying embedded
 * credentials, or enough entropy that it cannot be a name. Everything that
 * looks like an identifier, an environment variable name, a header name, or a
 * placeholder is not a credential.
 *
 * A false negative here costs one missed finding. A false positive costs the
 * user's trust in every `certain` finding the tool produces.
 */

/** Formats that are unambiguously credentials, whatever they are assigned to. */
const KNOWN_CREDENTIAL_FORMATS = [
  { pattern: /^sk_(live|test)_[A-Za-z0-9]{8,}$/, what: "a Stripe secret key" },
  { pattern: /^rk_(live|test)_[A-Za-z0-9]{8,}$/, what: "a Stripe restricted key" },
  { pattern: /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/, what: "a GitHub token" },
  { pattern: /^github_pat_[A-Za-z0-9_]{20,}$/, what: "a GitHub fine-grained token" },
  { pattern: /^glpat-[A-Za-z0-9_-]{15,}$/, what: "a GitLab token" },
  { pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, what: "a Slack token" },
  { pattern: /^(AKIA|ASIA)[A-Z0-9]{16}$/, what: "an AWS access key id" },
  { pattern: /^AIza[A-Za-z0-9_-]{35}$/, what: "a Google API key" },
  { pattern: /^npm_[A-Za-z0-9]{30,}$/, what: "an npm token" },
  { pattern: /^SG\.[A-Za-z0-9_-]{20,}$/, what: "a SendGrid key" },
  { pattern: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a PEM private key" },
  { pattern: /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: "a JWT" }
];

/** `scheme://user:password@host` — a connection string with credentials in it. */
const URI_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/**
 * Shapes that are names, not values. Checked before entropy, because a long
 * SCREAMING_SNAKE_CASE env var name can otherwise look random enough.
 */
const NAME_SHAPES = [
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/,                 // ENV_VAR_NAME
  /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/,           // dotted.config.key
  /^[a-z][a-zA-Z0-9]*$/,                            // camelCase identifier
  /^[A-Za-z][A-Za-z0-9]*(_[a-z0-9]+)+$/,            // snake_case identifier
  /^[\w.-]+\/[\w./-]+$/,                            // a path or module specifier
  /^\$\{[^}]*\}$/,                                  // ${INTERPOLATED}
  /^%[A-Z_]+%$/                                     // %WINDOWS_VAR%
];

/**
 * Hyphenated text is a name only when it is *short with few segments*
 * (`X-Auth-Password`, `content-type`). A long hyphenated string assigned to a
 * `secret:` property — `super-secret-jwt-signing-key-2024` — is a credential
 * someone typed by hand, and treating every hyphenated value as a name missed
 * exactly that case.
 */
const HYPHENATED = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/;
const MAX_NAME_LENGTH = 24;
const MAX_NAME_SEGMENTS = 3;

function isHyphenatedName(text) {
  if (!HYPHENATED.test(text)) return false;
  return text.length <= MAX_NAME_LENGTH && text.split("-").length <= MAX_NAME_SEGMENTS;
}

/** Obvious non-values: empty, placeholder, or documentation filler. */
const PLACEHOLDER = /^(|\s*|changeme|change-me|changeit|your[-_ ]?(secret|key|password|token)|xxx+|todo|tbd|placeholder|<[^>]*>|example|test|dummy|sample|redacted|secret|password|\*+|\.{3,})$/i;

const MIN_CREDENTIAL_LENGTH = 12;

/**
 * Property names whose value is *consumed as* a credential rather than naming
 * one. Nobody passes an environment-variable name to `secretOrKey` — it goes
 * straight into a signing call — so any non-placeholder literal there is a
 * finding regardless of shape.
 *
 * The looser names (`secret`, `apiKey`, `password`) are excluded deliberately:
 * those are exactly the keys a config map uses to hold env var names, header
 * names and defaults, and requiring credential-shaped evidence for them is what
 * removed the false-positive cluster this module exists for.
 */
const DIRECT_CREDENTIAL_PROPERTIES = /^(secretorkey|privatekey|private_key|clientsecret|client_secret|passphrase|accesskeyid|access_key_id)$/i;
const MIN_DIRECT_CREDENTIAL_LENGTH = 8;

export function isDirectCredentialProperty(name) {
  return DIRECT_CREDENTIAL_PROPERTIES.test(String(name || ""));
}

/**
 * A literal whose *format* identifies it as a credential, independent of what
 * it is assigned to.
 *
 * These patterns are issuer-defined and cannot collide with an environment
 * variable name, a header name or a path, which is why they need no
 * corroborating property name — and why the analyzer must consult them for
 * every string literal, not only for object properties whose key happened to
 * be on a short list. `export const STRIPE_KEY = "sk_live_..."`, the shape a
 * real leak actually takes, was silently ignored.
 *
 * @returns {{what: string}|null}
 */
export function matchesKnownCredentialFormat(value) {
  const text = String(value ?? "").trim();
  if (!text || PLACEHOLDER.test(text)) return null;
  for (const { pattern, what } of KNOWN_CREDENTIAL_FORMATS) {
    if (pattern.test(text)) return { what };
  }
  if (URI_WITH_CREDENTIALS.test(text) && !isLocalCredentialUri(text)) {
    return { what: "a connection URI with an embedded password" };
  }
  return null;
}

/**
 * `postgres://postgres:postgres@localhost:5432/dev` is a local development
 * default that appears in nearly every backend README. Reporting it as a
 * committed credential is the noise this module exists to avoid.
 */
function isLocalCredentialUri(text) {
  return /@(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal|db|postgres|mysql|redis|mongo)(:\d+)?([/?]|$)/i.test(text);
}

/**
 * @param {string} value the string literal assigned to a secret-named property
 * @param {{propertyName?: string}} context the property it was assigned to
 * @returns {{isCredential: boolean, confidence: "certain"|"high", reason: string}
 *          | {isCredential: false, reason: string}}
 */
export function classifySecretLiteral(value, { propertyName = "" } = {}) {
  const text = String(value ?? "").trim();

  if (!text || PLACEHOLDER.test(text)) {
    return { isCredential: false, reason: "placeholder or empty value" };
  }

  // A slot whose value is used directly as key material needs no shape
  // evidence: whatever is written there is the credential.
  if (isDirectCredentialProperty(propertyName) && text.length >= MIN_DIRECT_CREDENTIAL_LENGTH) {
    return {
      isCredential: true,
      confidence: "high",
      reason: `"${propertyName}" is used directly as key material and holds a literal value`
    };
  }

  for (const { pattern, what } of KNOWN_CREDENTIAL_FORMATS) {
    if (pattern.test(text)) {
      return { isCredential: true, confidence: "certain", reason: `the value matches the format of ${what}` };
    }
  }

  if (URI_WITH_CREDENTIALS.test(text)) {
    return { isCredential: true, confidence: "certain", reason: "the value is a connection URI with an embedded password" };
  }

  if (isHyphenatedName(text) || NAME_SHAPES.some((pattern) => pattern.test(text))) {
    return { isCredential: false, reason: "the value is shaped like a name or identifier, not a credential" };
  }

  if (text.length < MIN_CREDENTIAL_LENGTH) {
    return { isCredential: false, reason: `the value is only ${text.length} characters` };
  }

  if (shannonEntropyBits(text) >= 3.2 && characterClasses(text) >= 3) {
    return {
      isCredential: true,
      confidence: "high",
      reason: `the value is ${text.length} characters of mixed-class, high-entropy text`
    };
  }

  return { isCredential: false, reason: "the value has too little entropy to be a credential" };
}

/** Shannon entropy in bits per character. */
export function shannonEntropyBits(text) {
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/** How many of lower/upper/digit/symbol appear — a name rarely uses three. */
export function characterClasses(text) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(text)).length;
}
