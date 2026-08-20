/**
 * What to do when an already-applied migration file has been edited.
 *
 * The DECISION only — no imports, no I/O, nothing to stand up. The hashing
 * that discovers an amendment stays in `migrate.ts`, which is where the
 * database and the filesystem are.
 *
 * It lives in its own file because `migrate.ts` is a script: it calls
 * `loadRepoEnv()` and then `await createDb()` at the top level, so importing
 * it runs a migration. That matters more than it sounds, because the refuse
 * branch below is UNREACHABLE on this machine — with no DATABASE_URL the
 * PGlite refusal in `migrate.ts` exits before anything here is consulted, and
 * there is no local Postgres. Left inline, that branch's first execution would
 * have been a production deploy, and "marked untested" is not good enough for
 * code whose debut is production. As a pure function, both branches are
 * asserted by the smoke suite on a laptop.
 *
 * Same move, for the same reason, as `batchError` in `write/shared.ts`.
 */

export type AmendmentAction = { level: 'none' | 'warn' | 'refuse'; text: string };

export function amendmentAction(tags: string[], isDeploy: boolean): AmendmentAction {
  if (!tags.length) return { level: 'none', text: '' };

  const detail =
    `${tags.length} already-applied migration(s) have been edited since this ` +
    `database ran them: ${tags.join(', ')}.\n` +
    '[migrate] Those edits did NOT run and will not run, so this database is a ' +
    'different shape from the migration folder it was built from.';

  // Refuses in a deploy context and warns on a laptop. The asymmetry is the
  // same one `migrate.ts` already makes for its PGlite check: locally, a
  // pre-release amendment is legitimate and must not block a rebuild, while in
  // CI or on Vercel it means the target database does not match the folder
  // deployed alongside it. That is the same class of problem as migrating a
  // throwaway PGlite instead of the real database, and it earns the same
  // refusal — a warning in a build log is precisely the thing nobody reads.
  //
  // Silent on a FRESH deploy database, which has applied nothing. It speaks on
  // a re-deploy against an existing one, which is when it matters.
  //
  // Both messages name the migration. "Something was edited" sends someone
  // hunting through thirteen files.
  return isDeploy
    ? {
        level: 'refuse',
        text: `[migrate] REFUSED: ${detail}\n[migrate] Land the change as a NEW migration.`,
      }
    : {
        level: 'warn',
        text: `[migrate] WARNING: ${detail}\n[migrate] Rebuild it, or land the change as a NEW migration.`,
      };
}
