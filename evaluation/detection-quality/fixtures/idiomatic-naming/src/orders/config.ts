// SECURE control: a config map holding environment-variable NAMES, plus a
// header name and a dotted config key. None of these are credentials.
export const ENV_KEYS = {
  secret: "JWT_SIGNING_SECRET",
  apiKey: "PARTNER_API_KEY",
  password: "DB_PASSWORD"
};

export const HEADERS = { password: "X-Auth-Password" };
export const KEYS = { secret: "config.jwt.secret" };
