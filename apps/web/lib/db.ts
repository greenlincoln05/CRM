import { createDb, loadRepoEnv, type DbHandle } from '@lcp/db';

loadRepoEnv();

/**
 * One database handle per process, cached across hot reloads.
 *
 * PGlite is a single-writer embedded database: a second connection to the same
 * directory fails. Next.js recreates modules on every hot reload, so without
 * this the dev server would try to open a new one on each edit.
 *
 * Practical consequence in development: stop the dev server before running
 * `npm run etl`. In production DATABASE_URL points at real Postgres and this is
 * an ordinary connection pool.
 */
const globalForDb = globalThis as unknown as { __lcpDb?: Promise<DbHandle> };

export function getDb(): Promise<DbHandle> {
  globalForDb.__lcpDb ??= createDb();
  return globalForDb.__lcpDb;
}
