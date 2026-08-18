/**
 * Run pending migrations against whichever database is configured.
 *
 *   npm run db:migrate                 -> embedded PGlite at ./.pgdata
 *   DATABASE_URL=... npm run db:migrate -> real Postgres
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDb } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../migrations');

const handle = await createDb();
console.log(`[migrate] driver=${handle.driver} folder=${migrationsFolder}`);

try {
  if (handle.driver === 'postgres') {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    await migrate(handle.db, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db, { migrationsFolder });
  }
  console.log('[migrate] ok');
} catch (err) {
  console.error('[migrate] FAILED');
  console.error(err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
