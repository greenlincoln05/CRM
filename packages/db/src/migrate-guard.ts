/**
 * The amended-migration decision, on its own, with no I/O.
 *
 * Lives apart from migrate.ts because that file is a SCRIPT - importing it
 * runs a migration - and this has to be importable by the smoke suite. The
 * reason it must be importable is the whole point: the refuse branch is
 * unreachable locally, since with no DATABASE_URL the PGlite refusal in
 * migrate.ts exits before anything here is consulted, and there is no local
 * Postgres. Left inline, that branch's first execution would be a production
 * deploy. Here, both branches are asserted on a laptop.
 *
 * Same move as batchError in write/shared.ts, for the same reason.
 */

/**
 * What to do about amended migrations, as a pure decision.
 *
 * Split out from the I/O above for one reason: the refuse branch is
 * UNREACHABLE locally. With no DATABASE_URL the PGlite refusal at the top of
 * this file exits first, and there is no local Postgres — so left inside
 * reportAmendedMigrations() the first execution of that branch would be during
 * a real deploy. "Marked untested" is not good enough for code whose debut is
 * production. As a pure function both branches are asserted by the smoke suite
 * with no database involved, which is the same move that made batchError
 * testable.
 */
export type AmendmentAction = { level: 'none' | 'warn' | 'refuse'; text: string };

export function amendmentAction(tags: string[], isDeploy: boolean): AmendmentAction {
  if (!tags.length) return { level: 'none', text: '' };

  const detail =
    `${tags.length} already-applied migration(s) have been edited since this ` +
    `database ran them: ${tags.join(', ')}.
` +
    '[migrate] Those edits did NOT run and will not run, so this database is a ' +
    'different shape from the migration folder it was built from.';

  // Refuses in a deploy context, warns on a laptop, and the asymmetry is the
  // same one made for the PGlite check at the top of this file: locally a
  // pre-release amendment is legitimate and must not block a rebuild, while in
  // CI or on Vercel it means the target database does not match the folder
  // deployed alongside it. That is the same class of problem as migrating a
  // throwaway PGlite instead of the real one, and it earns the same refusal —
  // a warning in a build log is precisely the thing nobody reads.
  //
  // Silent on a FRESH deploy database, which has applied nothing. It speaks on
  // a re-deploy against an existing one, which is when it matters.
  return isDeploy
    ? { level: 'refuse', text: `[migrate] REFUSED: ${detail}
[migrate] Land the change as a NEW migration.` }
    : { level: 'warn', text: `[migrate] WARNING: ${detail}
[migrate] Rebuild it, or land the change as a NEW migration.` };
}
