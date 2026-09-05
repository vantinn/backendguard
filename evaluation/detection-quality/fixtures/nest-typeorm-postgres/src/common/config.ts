// SECURE control: secret-shaped names that read from the environment.
export const jwtConfig = {
  secret: process.env.JWT_SECRET,
  apiKey: process.env.PAYMENTS_API_KEY
};

// AMBIGUOUS: a secret-shaped name with an obvious placeholder value.
export const localDefaults = {
  secret: "changeme"
};
