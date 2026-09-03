import fs from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import { db, initDb } from "../db";
import { chatLogs } from "../db/schema";

const CONFIRM_VALUE = "YES";

function resolveDbPath() {
  const dbPath = process.env.DB_FILE || "data/promptgate.sqlite";
  if (path.isAbsolute(dbPath)) return dbPath;
  if (process.cwd().endsWith("server")) {
    return path.join(process.cwd(), "../../", dbPath);
  }
  return path.join(process.cwd(), dbPath);
}

async function countChatLogs() {
  const rows = await db.select({ count: sql<number>`COUNT(*)` }).from(chatLogs);
  return Number(rows[0]?.count || 0);
}

function backupDatabaseFile() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    console.warn(`[chat-log-cleanup] DB file not found at ${dbPath}; skipping file backup.`);
    return null;
  }

  const backupPath = `${dbPath}.chat-log-cleanup.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

async function run() {
  await initDb();
  const beforeCount = await countChatLogs();
  const confirmed = process.env.CONFIRM_CLEAR_CHAT_LOGS === CONFIRM_VALUE;
  const shouldVacuum = process.env.VACUUM_AFTER_CLEAR === "true";

  console.log(`[chat-log-cleanup] Target table: chat_logs`);
  console.log(`[chat-log-cleanup] Rows currently stored: ${beforeCount}`);

  if (!confirmed) {
    console.log(`[chat-log-cleanup] Dry run only. Set CONFIRM_CLEAR_CHAT_LOGS=${CONFIRM_VALUE} to delete chat audit logs.`);
    process.exit(0);
  }

  const backupPath = backupDatabaseFile();
  if (backupPath) {
    console.log(`[chat-log-cleanup] Backup created: ${backupPath}`);
  }

  await db.delete(chatLogs);
  const afterCount = await countChatLogs();
  console.log(`[chat-log-cleanup] Deleted rows: ${beforeCount - afterCount}`);
  console.log(`[chat-log-cleanup] Rows remaining: ${afterCount}`);

  if (shouldVacuum) {
    console.log("[chat-log-cleanup] Running VACUUM. This can briefly lock the SQLite database.");
    await db.run(sql`VACUUM`);
    console.log("[chat-log-cleanup] VACUUM complete.");
  } else {
    console.log("[chat-log-cleanup] VACUUM skipped. Set VACUUM_AFTER_CLEAR=true if you need to reclaim file space immediately.");
  }

  process.exit(0);
}

run().catch((error) => {
  console.error("[chat-log-cleanup] Failed:", error);
  process.exit(1);
});
