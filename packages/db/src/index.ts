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
    const client = postgres(url, {
      /**
       * Pool size is per process, and on Vercel a "process" is one serverless
       * instance handling one request at a time. Ten connections each,
       * multiplied by however many instances traffic spins up, is how a small
       * app exhausts a Postgres connection limit. One per instance is right
       * there; the long-lived ETL on the shop server wants the larger pool.
       *
       * Point DATABASE_URL at Neon's POOLED endpoint (the `-pooler` host) in
       * production: pgbouncer fronts these and is what makes the arithmetic
       * work at all. `prepare: false` is not optional with it — prepared
       * statements do not survive transaction-mode pooling.
       */
      // `||` not `??`: DB_POOL_MAX= (empty, the shape a commented .env line
      // becomes) parses to 0, and a zero-connection pool queues every query
      // forever. Any falsy or non-numeric value falls back to the default.
      max: Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 1 : 10),
      idle_timeout: Number(process.env.DB_IDLE_TIMEOUT) || 20,
      connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT) || 10,
      prepare: false,
    });
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
// kms.js is intentionally NOT re-exported: it is reached only through
// crypto.js's dynamic import. At runtime under Node that means the AWS SDK is
// never loaded unless a wrapped key is configured; under webpack it becomes a
// lazy chunk rather than a true exclusion, which is why next.config.mjs also
// lists @aws-sdk/client-kms as an external package.

export * from './env.js';
export * from './auth.js';
export * from './write/index.js';

/**
 * The selling-channel port: types and one interface, no implementation.
 * Exported so an adapter that speaks HTTP — which belongs in its own package,
 * with its own credentials and retry policy — can implement it from outside.
 *
 * channels/fake.js is intentionally NOT re-exported. It is a test double, and
 * the one place it should ever be reachable from is a test that imports it by
 * path. A fake selling channel wired into the app by an incautious
 * auto-import would push the catalogue into a Map and report success.
 */
export * from './channels/port.js';
