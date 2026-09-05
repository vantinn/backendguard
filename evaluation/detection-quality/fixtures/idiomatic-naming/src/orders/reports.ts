import { pool } from "./pool";

// INSECURE: SQL injection by string concatenation.
export async function byStatus(status: string) {
  return pool.query("SELECT id FROM orders WHERE status = '" + status + "'");
}

// SECURE control: bound parameters.
export async function byCustomer(id: string) {
  return pool.query("SELECT id FROM orders WHERE customer_id = $1 LIMIT 100", [id]);
}
