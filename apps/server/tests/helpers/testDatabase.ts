import fs from 'fs';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolveDbFilePath } from '../../src/db/path';
import path from 'path';

export interface TestDatabaseConfig {
  dbFilePath: string;
}

export async function initTestDatabase(config: TestDatabaseConfig) {
  const fullPath = resolveDbFilePath(config.dbFilePath, process.cwd());

  cleanupTestDatabaseFilesSync(fullPath);

  process.env.DB_FILE = config.dbFilePath;

  const { db, client, initDb } = await import('../../src/db');
  await initDb();

  // Apply parallel-safe SQLite settings explicitly for test isolation
  await client.execute('PRAGMA journal_mode = WAL;');
  await client.execute('PRAGMA busy_timeout = 5000;');

  const migrationsFolder = path.resolve(
    process.cwd(),
    process.cwd().endsWith('server') ? './drizzle' : 'apps/server/drizzle',
  );
  await migrate(db, { migrationsFolder });

  try {
    const { bootstrap } = await import('../../src/bootstrap');
    await bootstrap();
  } catch (err: any) {
    if (
      err?.code === 'SQLITE_CONSTRAINT' ||
      err?.message?.includes('UNIQUE constraint') ||
      err?.cause?.message?.includes('UNIQUE constraint')
    ) {
      // Already bootstrapped, ignore
    } else {
      throw err;
    }
  }

  return { db, client };
}

export async function closeAndCleanup(client: any, dbFilePath: string) {
  const fullPath = resolveDbFilePath(dbFilePath, process.cwd());
  const { closeDb } = await import('../../src/db');
  await closeDb();
  try {
    if (client && typeof client.close === 'function') {
      await client.close();
    }
  } catch {}
  cleanupTestDatabaseFilesSync(fullPath);
}

export function cleanupTestDatabaseFilesSync(fullPath: string) {
  const targets = [fullPath, `${fullPath}-wal`, `${fullPath}-shm`];
  for (const t of targets) {
    if (fs.existsSync(t)) {
      fs.unlinkSync(t);
    }
  }
}

// Keep backward compat
export async function cleanupTestDatabaseFiles(dbFilePath: string) {
  const fullPath = resolveDbFilePath(dbFilePath, process.cwd());
  cleanupTestDatabaseFilesSync(fullPath);
}
