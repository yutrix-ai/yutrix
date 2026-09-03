#!/usr/bin/env node
import { runCopyPipeline } from "./pipeline";
import { loadDbConfig } from "../config";

async function main() {
  const args = process.argv.slice(2);
  let toUrl = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--to-url=")) {
      toUrl = arg.slice("--to-url=".length);
    } else if (arg === "--to-url" && i + 1 < args.length) {
      toUrl = args[i + 1];
      i++;
    }
  }

  if (!toUrl) {
    console.error("Error: --to-url is required.");
    console.error("Usage: pnpm db:copy --to-url postgres://user:password@host:port/dbname");
    process.exit(1);
  }

  console.log("==================================================");
  console.log("  Yutrix SQLite -> PostgreSQL Migration Pipeline  ");
  console.log("==================================================");

  const currentConfig = loadDbConfig();
  console.log(`Source Driver: ${currentConfig.driver}`);
  console.log(`Target PostgreSQL URL: ${toUrl.replace(/:[^:@]+@/, ":****@")}`);
  console.log("");

  try {
    const result = await runCopyPipeline({
      targetPgUrl: toUrl,
      batchSize: 1000,
      onProgress: (prog) => {
        if (prog.stage === "copying_tables" && prog.currentTable) {
          const t = prog.tables[prog.currentTable];
          if (t) {
            process.stdout.write(
              `\r[Copying] ${prog.currentTable}: ${t.copied}/${t.total} rows (${prog.copiedRows}/${prog.totalRows} overall)...`
            );
          }
        } else if (prog.stage === "migrating_pg") {
          console.log("[Pipeline] Migrating PostgreSQL target schema...");
        } else if (prog.stage === "verifying") {
          console.log("\n[Pipeline] Verifying table row counts and data integrity...");
        }
      },
    });

    console.log("\n");
    console.log("Migration completed successfully!");
    console.log(`Tables copied: ${result.totalTables}`);
    console.log(`Total rows copied: ${result.copiedRows}`);
    console.log(`Verification: ${result.verified ? "PASSED" : "FAILED"}`);
    console.log("Configuration updated in data/yutrix.config.json.");
    console.log("Please restart your server process to apply the new database configuration.");
    process.exit(0);
  } catch (err: any) {
    console.error("\nMigration failed:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
