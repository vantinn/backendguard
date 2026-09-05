import { DataSource } from "typeorm";

export const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  // INSECURE: schema is rewritten to match the entities on every boot.
  synchronize: true,
  entities: ["dist/**/*.entity.js"]
});
