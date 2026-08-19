/**
 * Who is making this request?
 *
 * Same shape as the database layer's two-driver pattern (ADR 0002) and the
 * field key's dev fallback (crypto.ts): a real provider when configured, a
 * frictionless dev identity on the embedded database, and a hard refusal to
 * run half-configured against real data.
 *
 *   Clerk configured (CLERK_SECRET_KEY set)   -> real sign-in, real user id
 *   No Clerk, embedded PGlite dev database    -> auto-provisioned dev user
 *   No Clerk, DATABASE_URL set                -> every request is anonymous
 *
 * That last row is the enforcement ADR 0003 asks for. Every data surface —
 * the pages, the search API, the gate code reveal — resolves the user through
 * this function server-side, so a deployment that forgot (or half-configured)
 * auth rejects all of them rather than serving the customer database to
 * anonymous callers. The middleware is convenience (redirects to sign-in);
 * these checks are the enforcement, and they hold even if a build inlined the
 * middleware into passthrough mode. Failing closed is the entire point.
 *
 * Provisioning: the first authenticated request from a Clerk user creates the
 * app_user mirror row (role 'staff'; an admin promotes in the app or the
 * database). This is deliberate — ~30 employees, zero onboarding friction —
 * and it is safe ONLY because the Clerk instance is invite-only. Keep it that
 * way: anyone who can sign in to Clerk gets a staff account here.
 */
import { sql } from 'drizzle-orm';
import { getDb } from './db';

export type AuthedUser = {
  id: string;          // app_user.id — what goes in sensitive_access_log.user_id
  email: string;
  displayName: string;
  role: string;        // admin | manager | staff | tech
};

const rows = (r: any) => (r?.rows ?? r) as any[];

/**
 * Resolve the current request's user, or null if anonymous.
 *
 * Inactive users resolve to null: deactivating the app_user row locks someone
 * out even while their Clerk account still exists. Offboarding is one UPDATE.
 */
export async function currentAppUser(): Promise<AuthedUser | null> {
  const secret = !!process.env.CLERK_SECRET_KEY;
  const publishable = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (secret && publishable) return clerkUser();
  // Half-configured is its own failure mode: with only the secret key set the
  // middleware never ran and Clerk's auth() would throw a 500 per request.
  // One shared rule — both keys or Clerk does not exist — and the mismatched
  // state fails closed instead of half-working.
  if (secret || publishable) return null;
  if (process.env.DATABASE_URL) return null;  // real database, no auth: fail closed
  if (process.env.NODE_ENV === 'production') return null; // dev identity never serves production
  return devUser();
}

async function clerkUser(): Promise<AuthedUser | null> {
  // Dynamic import: this module never loads Clerk in keyless dev (the
  // middleware bundle still contains it — that import is static).
  const { auth, currentUser } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  if (!userId) return null;

  const { db } = await getDb();
  const found = rows(await db.execute(sql`
    SELECT id, email, display_name, role, active
    FROM app_user WHERE external_id = ${userId}`))[0];

  if (found) {
    if (!found.active) return null;
    return { id: found.id, email: found.email, displayName: found.display_name, role: found.role };
  }

  // First sign-in: create the mirror row. currentUser() costs a Clerk API
  // call, so it runs only on this provisioning path, never per-request.
  const cu = await currentUser();
  const email =
    cu?.primaryEmailAddress?.emailAddress ?? cu?.emailAddresses?.[0]?.emailAddress;
  if (!email) return null;
  const displayName =
    [cu?.firstName, cu?.lastName].filter(Boolean).join(' ') || email;

  // Upsert on external_id (unique, migration 0007): two concurrent first
  // requests cannot mint two mirrors of one person.
  const created = rows(await db.execute(sql`
    INSERT INTO app_user (external_id, email, display_name, role)
    VALUES (${userId}, ${email}, ${displayName}, 'staff')
    ON CONFLICT (external_id) DO UPDATE
      SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
    RETURNING id, email, display_name, role, active`))[0];

  if (!created?.active) return null;
  return { id: created.id, email: created.email, displayName: created.display_name, role: created.role };
}

/**
 * The dev identity, embedded database only. One stable app_user row so
 * sensitive_access_log carries a real foreign key in development instead of
 * the old 'unauthenticated-dev' free-text label.
 */
async function devUser(): Promise<AuthedUser | null> {
  const { db } = await getDb();
  const row = rows(await db.execute(sql`
    INSERT INTO app_user (external_id, email, display_name, role)
    VALUES ('dev-local', 'dev@lcp.local', 'Dev (local)', 'admin')
    ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
    RETURNING id, email, display_name, role, active`))[0];
  if (!row?.active) return null; // deactivating the dev row locks it out, same as anyone
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
}
