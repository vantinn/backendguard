import { Pool } from "pg";

// SECURE control: sized pool with an idle timeout.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000
});
