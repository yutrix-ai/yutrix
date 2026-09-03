import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

export default defineConfig({
  schema: "./src/db/schema.pg.ts",
  out: "./drizzle/pg",
  dialect: "postgresql",
  verbose: true,
  strict: true,
});
