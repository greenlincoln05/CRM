import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoEnv } from '@lcp/db';

loadRepoEnv();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * ETL configuration.
 *
 * The legacy connection is READ-ONLY by policy and by credential. Nothing in
 * this package issues a write against the on-prem server - the account it
 * connects with should not even have permission. Evosus stays authoritative
 * for money and inventory until the day it does not, and an ETL bug must never
 * be able to damage the live system the business is still running on.
 */
export const config = {
  legacy: {
    source: 'evosus',
    host: process.env.LEGACY_MSSQL_HOST ?? '',
    port: Number(process.env.LEGACY_MSSQL_PORT ?? 1433),
    database: process.env.LEGACY_MSSQL_DATABASE ?? '',
    user: process.env.LEGACY_MSSQL_USER ?? '',
    password: process.env.LEGACY_MSSQL_PASSWORD ?? '',
    encrypt: (process.env.LEGACY_MSSQL_ENCRYPT ?? 'true') === 'true',
    trustServerCertificate:
      (process.env.LEGACY_MSSQL_TRUST_SERVER_CERT ?? 'true') === 'true',
  },
  /** Anchored to the repo root so every workspace package agrees on one path. */
  dataDir: resolve(repoRoot, process.env.ETL_DATA_DIR ?? './data'),
  /** Rows per batch when streaming out of SQL Server. */
  batchSize: Number(process.env.ETL_BATCH_SIZE ?? 2000),
};

export function assertLegacyConfigured() {
  const missing = (['host', 'database', 'user', 'password'] as const)
    .filter((k) => !config.legacy[k]);
  if (missing.length) {
    throw new Error(
      `Legacy SQL Server not configured. Missing: ${missing.join(', ')}.\n` +
      `Copy .env.example to .env and fill in the read-only credentials.`,
    );
  }
}
