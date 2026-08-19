import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE, SESSION_TTL_HOURS, signIn, signOut, verifySession,
  type SessionUser,
} from '@lcp/db';
import { getDb } from './db';

/**
 * Who is at the keyboard.
 *
 * Every server component and every action goes through here. The cookie is
 * httpOnly and the token in it is meaningless without the app_session row it
 * hashes to, so nothing about the signed-in user is inferable from the browser
 * side alone.
 */

export type { SessionUser };

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return null;

  const { db } = await getDb();
  return verifySession(db, token);
}

/**
 * The same thing, but it does not return without one.
 *
 * Server components cannot set cookies, so this redirects rather than trying to
 * clear a stale one; the login page does the clearing.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  return user;
}

/** Managers and admins can hide timeline entries. Everyone else cannot. */
export function canRedact(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'manager';
}

export async function startSession(
  email: string, pin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { db } = await getDb();
  const h = await headers();

  const result = await signIn(db, {
    email,
    pin,
    ip: h.get('x-forwarded-for'),
    userAgent: h.get('user-agent'),
  });

  if (!result.ok) return { ok: false, error: result.error };

  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    // The shop runs this over plain HTTP on the counter machine today. Secure
    // would make the cookie unusable there; behind TLS it should be on.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });

  return { ok: true };
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) {
    const { db } = await getDb();
    await signOut(db, token);
  }
  jar.delete(SESSION_COOKIE);
}
