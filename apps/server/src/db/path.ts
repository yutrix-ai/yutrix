import path from 'path';

/**
 * Resolves a database file path relative to the given working directory.
 * Shared between production db/index.ts and test helpers to ensure
 * consistent path resolution.
 *
 * Rules:
 * - Absolute paths are returned as-is.
 * - When cwd ends with "server" (monorepo sub-package), resolve relative
 *   to the monorepo root (../../).
 * - Otherwise resolve relative to cwd directly.
 */
export function resolveDbFilePath(dbFile: string, cwd: string): string {
  if (path.isAbsolute(dbFile)) return dbFile;
  if (cwd.endsWith('server')) {
    return path.join(cwd, '../../', dbFile);
  }
  return path.join(cwd, dbFile);
}
