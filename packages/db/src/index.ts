import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export * as schema from './schema/index.js';
export * from './schema/index.js';

export type DbHandle = {
  db: any;
  driver: 'postgres' | 'pglite';
  close: () => Promise<void>;
};

/**
 * Two drivers, one schema.
 *
 * With DATABASE_URL set we talk to real Postgres - Neon in production, or a
 * Postgres instance on the shop server if the data has to stay on prem.
 * Without it we start embedded PGlite: genuine Postgres 17 compiled to WASM,
 * with the same extensions and the same migrations. That means the whole stack
 * runs on a laptop with nothing installed, which matters when the person
 * building it is also the person running the store.
 *
 * See docs/adr/0002-database.md.
 */
export async function createDb(
  opts: { url?: string; pgliteDir?: string } = {},
): Promise<DbHandle> {
  const url = opts.url ?? process.env.DATABASE_URL;

  if (url) {
    const client = postgres(url, { max: 10, prepare: false });
    return {
      db: drizzlePg(client, { schema }),
      driver: 'postgres',
      close: async () => { await client.end({ timeout: 5 }); },
    };
  }

  // Dynamic import keeps the PGlite WASM bundle out of production builds.
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const { fuzzystrmatch } = await import('@electric-sql/pglite/contrib/fuzzystrmatch');

  // Anchored to the repo, not the working directory: every workspace package
  // and every script must reach the SAME dev database, whatever it was run from.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? resolve(repoRoot, '.pgdata');
  const client = await PGlite.create(dir, {
    extensions: { pg_trgm, unaccent, fuzzystrmatch },
  });

  return {
    db: drizzlePglite(client, { schema }),
    driver: 'pglite',
    close: async () => { await client.close(); },
  };
}
export * from './crypto.js';
export * from './env.js';
