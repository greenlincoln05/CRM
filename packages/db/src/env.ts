import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Load the repo-root .env from whichever workspace package is running.
 *
 * Node reads .env only when told to; every entry point here (ETL CLI, Next.js,
 * migrations) starts from a different directory, so the path is anchored to
 * this file rather than to cwd.
 */
export function loadRepoEnv() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    (process as any).loadEnvFile(resolve(repoRoot, '.env'));
  } catch {
    // No .env is fine until something actually needs a secret, and the errors
    // at that point say exactly which variable is missing.
  }
}
