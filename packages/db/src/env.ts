/**
 * Repo-root .env loading, without a dotenv dependency.
 *
 * Every entry point that needs configuration — the web app, the ETL, the
 * migration runner — calls loadRepoEnv() first. The file is anchored to the
 * repository root the same way the PGlite data directory is (see index.ts):
 * whatever directory a script was launched from, every workspace package reads
 * the SAME .env, because half the "it works in one terminal and not the other"
 * class of bug is two processes reading two different environments.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** packages/db/src -> repo root. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

let loaded = false;

/**
 * Read `<repo>/.env` into process.env. Idempotent, and it never overrides a
 * variable that is already set — a real environment (Vercel, a scheduled task
 * on the shop server) always wins over the local file.
 */
export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;

  let text: string;
  try {
    text = readFileSync(resolve(repoRoot(), '.env'), 'utf8');
  } catch {
    return; // No .env is a normal state: quick start runs entirely without one.
  }

  // Notepad writes a BOM; left in place it silently corrupts the first key.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes; .env files written by hand have them.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
