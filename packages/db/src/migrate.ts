/**
 * Run pending migrations against whichever database is configured.
 *
 *   npm run db:migrate                 -> embedded PGlite at ./.pgdata
 *   DATABASE_URL=... npm run db:migrate -> real Postgres
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, loadRepoEnv } from './index.js';
import { type AmendmentAction, amendmentAction } from './migration-amendment.js';

loadRepoEnv();

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../migrations');

const handle = await createDb();
console.log(`[migrate] driver=${handle.driver} folder=${migrationsFolder}`);

/**
 * A deploy step that migrates the wrong database and exits 0 is worse than one
 * that fails.
 *
 * Without DATABASE_URL this command happily creates a throwaway PGlite
 * database in the build container, migrates that, prints "ok", and lets an
 * unmigrated production database take traffic — the only tell being
 * `driver=pglite` in a build log nobody reads.
 *
 * So: embedded is fine on a laptop (the quick start depends on it) and never
 * fine in a deploy or CI environment.
 */
const deployContext =
  process.env.VERCEL ?? process.env.CI ?? process.env.MIGRATE_REQUIRE_POSTGRES;

if (handle.driver === 'pglite' && deployContext) {
  await handle.close();
  console.error(
    '[migrate] REFUSED: no DATABASE_URL is set, so this would migrate an ' +
    'embedded PGlite database instead of the real one. Set DATABASE_URL.',
  );
  process.exit(1);
}

try {
  if (handle.driver === 'postgres') {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    await migrate(handle.db, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db, { migrationsFolder });
  }
  // "ok" only if it IS ok, and never a bare "ok" under a message saying the
  // database does not match its own migration folder.
  //
  // This guard exists to make "the only tell is [migrate] ok" untrue, so a
  // refusal printing ok underneath itself would defeat it entirely - exit code
  // 1, and the last line of the build log saying the opposite. A warning is
  // not a failure and the migrations really did apply, but a bare "ok" still
  // reads as all-clear and undercuts the line above it, so it is qualified.
  const level = await reportAmendedMigrations(handle);
  console.log(
    level === 'refuse' ? '[migrate] NOT ok'
    : level === 'warn' ? '[migrate] ok, with warnings above'
    : '[migrate] ok',
  );
} catch (err) {
  console.error('[migrate] FAILED');
  console.error(err);
  process.exitCode = 1;
} finally {
  await handle.close();
}

/**
 * Shout if an already-applied migration file has been edited since it ran.
 *
 * Drizzle decides what to run by comparing the journal's `when` timestamp
 * against the newest applied row — `pg-core/dialect.js`:
 *
 *   if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 *
 * It stores a sha256 of each file in `drizzle.__drizzle_migrations` and then
 * never reads it back. So editing a migration that a database has already
 * applied is a silent no-op on that database, and the only tell is "[migrate]
 * ok" followed by behaviour from the version that actually ran.
 *
 * This was measured rather than reasoned: `search_items()` was replaced with a
 * marker function, the real migrator was run against that database, and the
 * marker survived. Three commits' worth of edits to 0011 — a CHECK constraint,
 * two new functions, a unique index moved onto a normalized expression, and a
 * generated column's definition — would have reached nothing.
 *
 * It has cost nothing so far because the only database that has ever applied
 * 0011 is a local .pgdata that gets wiped several times a session. The first
 * time that stops being true it costs a production database that is quietly a
 * different shape from its own migration folder.
 *
 * The rule, which is now in CLAUDE.md: once a migration has been applied
 * anywhere it cannot be edited — write a new one, using CREATE OR REPLACE
 * FUNCTION for search changes. This is the check that makes breaking the rule
 * visible instead of silent. It warns rather than fails, because a legitimate
 * pre-release amendment (which 0011 was) should not block a rebuild.
 */
async function reportAmendedMigrations(h: { db: any }): Promise<AmendmentAction['level']> {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');

  let applied: Array<{ hash: string; created_at: string }>;
  try {
    const r = await h.db.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`,
    );
    applied = (r?.rows ?? r) as any[];
  } catch {
    // No migrations table yet, or a driver that names it differently. Nothing
    // to compare against, and this must never be the reason a migrate fails.
    return 'none';
  }

  const byMillis = new Map(applied.map((a) => [String(a.created_at), a.hash]));
  const journal = JSON.parse(
    readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };

  // Hashed BOTH ways, and only a mismatch on both counts as an amendment.
  //
  // Drizzle hashes the file byte for byte, and core.autocrlf rewrites LF to
  // CRLF on checkout — so `git checkout` of an untouched migration is enough
  // to change its hash. That produced a false positive the first time this
  // check ran. .gitattributes now pins *.sql to LF, which fixes it at the
  // source, but a clone made before that or with different git settings would
  // still trip it, and a guard that cries wolf gets ignored.
  //
  // THREE forms, and the third is the one that matters. The first version
  // compared `raw` against `CRLF -> LF`, which on a file that is already LF is
  // the same string twice — one comparison wearing two hats, and missing the
  // direction this repo is actually about to travel. Ten of the thirteen
  // migrations are CRLF in the working tree right now, so a database migrated
  // today recorded CRLF hashes for them; adding *.sql eol=lf converts those ten
  // to LF on the next checkout, and then neither of the first two forms
  // matches. That is ten warnings at once, on zero content change, which is
  // precisely the wolf-crying this hashing-both-ways was meant to avoid.
  // Reproduced against the real migrator before the third line was added.
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const amended = journal.entries.filter((e) => {
    const wasApplied = byMillis.get(String(e.when));
    if (!wasApplied) return false;
    const raw = readFileSync(resolve(migrationsFolder, `${e.tag}.sql`), 'utf8');
    const lf = raw.split('\r\n').join('\n');
    const crlf = lf.split('\n').join('\r\n');
    return sha(raw) !== wasApplied && sha(lf) !== wasApplied && sha(crlf) !== wasApplied;
  });

  return report(amendmentAction(amended.map((a) => a.tag), Boolean(deployContext)));
}

/** Print an action and hand its level back so the closing line can reflect it. */
function report(action: AmendmentAction): AmendmentAction['level'] {
  if (action.level === 'refuse') {
    console.error(action.text);
    process.exitCode = 1;
  } else if (action.level === 'warn') {
    console.warn(action.text);
  }
  return action.level;
}
