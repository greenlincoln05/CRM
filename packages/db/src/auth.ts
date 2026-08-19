import {
  createHash, randomBytes, scrypt as scryptCb, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';

/**
 * Staff sign-in.
 *
 * ADR 0005. This is deliberately an interim scheme: a PIN typed at a counter,
 * hashed with scrypt, exchanged for a server-side session. The real answer is
 * an identity provider, and app_user.external_id is already sitting there
 * waiting for it. What could not wait is the requirement underneath it - that
 * every write carries a name - because Sprint 2 is the sprint where staff stop
 * reading the database and start changing it.
 *
 * The threat model is a shop, not the internet. The realistic failures are a
 * browser left open on the counter, a laptop that went home in a bag, and a
 * seasonal hire who finished in October. Everything here is aimed at those:
 * short sessions, server-side revocation, and a lockout that makes guessing a
 * four-digit PIN pointless.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: Buffer, keylen: number,
) => Promise<Buffer>;

/** Cost parameters. ~100ms per hash on the shop machine, which is the point. */
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const SESSION_COOKIE = 'lcp_session';

/**
 * Twelve hours: long enough to cover the longest shift without a re-login in
 * the middle of a customer, short enough that a machine left on overnight is
 * signed out by morning.
 */
export const SESSION_TTL_HOURS = 12;

/** Guessing stops being viable well before this matters. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export type Actor = {
  userId: string;
  /** Denormalized for timeline rows, so a feed stays readable if a user is removed. */
  label: string;
  role: string;
};

export type SessionUser = Actor & {
  email: string;
  sessionId: string;
};

const rows = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

// ── PIN hashing ────────────────────────────────────────────────────────────

/**
 * Format: scrypt$<salt base64>$<hash base64>.
 *
 * The scheme name is stored rather than assumed, so moving to argon2 later is a
 * matter of branching on the prefix instead of guessing what old rows are.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(pin.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPinHash(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pin.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * A PIN typed on a counter keypad, so the bar is deliberately low - but not so
 * low that half the staff pick 1234. The lockout does the real work; this only
 * removes the choices that make the lockout irrelevant.
 */
export function validatePin(pin: string): string | null {
  if (!/^\d{4,12}$/.test(pin)) return 'PIN must be 4 to 12 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be the same digit repeated.';

  const ascending = '01234567890';
  const descending = '09876543210';
  if (ascending.includes(pin) || descending.includes(pin)) {
    return 'PIN cannot be a run of consecutive digits.';
  }
  return null;
}

// ── Users ──────────────────────────────────────────────────────────────────

export type NewUser = {
  email: string;
  displayName: string;
  role?: 'admin' | 'manager' | 'staff' | 'tech';
  pin: string;
};

export async function createUser(db: any, input: NewUser): Promise<{ id: string }> {
  const problem = validatePin(input.pin);
  if (problem) throw new Error(problem);

  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    throw new Error(`Not a valid email address: "${input.email}"`);
  }

  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('A display name is required - it is what the timeline shows.');

  const pinHash = await hashPin(input.pin);

  const r = rows<{ id: string }>(await db.execute(sql`
    INSERT INTO app_user (email, display_name, role, pin_hash, pin_set_at)
    VALUES (${email}, ${displayName}, ${input.role ?? 'staff'}, ${pinHash}, now())
    RETURNING id
  `));
  return r[0]!;
}

export async function setPin(db: any, userId: string, pin: string): Promise<void> {
  const problem = validatePin(pin);
  if (problem) throw new Error(problem);

  const pinHash = await hashPin(pin);
  await db.execute(sql`
    UPDATE app_user
       SET pin_hash = ${pinHash}, pin_set_at = now(),
           failed_attempts = 0, locked_until = NULL
     WHERE id = ${userId}::uuid
  `);

  // A PIN change is a good moment to end every session opened with the old one.
  await revokeAllSessions(db, userId);
}

// ── Sign in ────────────────────────────────────────────────────────────────

export type SignInResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; error: string };

/**
 * A single dummy verification, used when the email does not exist.
 *
 * Without it, "unknown email" returns in a millisecond while "wrong PIN" takes
 * a hundred, and the difference tells anyone who cares which addresses are real
 * accounts. Both paths now cost the same scrypt.
 */
const DUMMY_HASH_PROMISE = hashPin('000000');

export async function signIn(
  db: any,
  input: { email: string; pin: string; ip?: string | null; userAgent?: string | null },
): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase();

  const user = rows<{
    id: string; email: string; display_name: string; role: string;
    active: boolean; pin_hash: string | null; locked_until: string | null;
    failed_attempts: number;
  }>(await db.execute(sql`
    SELECT id, email, display_name, role, active, pin_hash, locked_until, failed_attempts
    FROM app_user WHERE lower(email) = ${email}
  `))[0];

  if (!user) {
    await verifyPinHash(input.pin, await DUMMY_HASH_PROMISE);
    return { ok: false, error: 'That email and PIN do not match an account.' };
  }

  if (!user.active) {
    return { ok: false, error: 'That account is no longer active.' };
  }

  const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;

  if (lockedUntil && lockedUntil > new Date()) {
    const mins = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
    return { ok: false, error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }

  if (!await verifyPinHash(input.pin, user.pin_hash)) {
    // A lockout that has already elapsed starts the count over. Without this the
    // counter stays at the threshold that triggered it, so the first typo after
    // serving a 15-minute lockout re-locks for another 15 - and the account
    // becomes recoverable only by getting the PIN right on the very first try.
    const servedLockout = lockedUntil !== null && lockedUntil <= new Date();
    const attempts = (servedLockout ? 0 : Number(user.failed_attempts)) + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await db.execute(sql`
      UPDATE app_user
         SET failed_attempts = ${attempts},
             locked_until = ${lock ? sql`now() + interval '${sql.raw(String(LOCKOUT_MINUTES))} minutes'` : sql`NULL`}
       WHERE id = ${user.id}::uuid
    `);
    return {
      ok: false,
      error: lock
        ? `Too many attempts. Locked for ${LOCKOUT_MINUTES} minutes.`
        : 'That email and PIN do not match an account.',
    };
  }

  // The token exists only in the cookie and in this return value. What lands in
  // the database is its hash, so a leaked backup cannot be replayed as a login.
  const token = randomBytes(32).toString('base64url');

  const session = rows<{ id: string }>(await db.execute(sql`
    INSERT INTO app_session (user_id, token_hash, expires_at, ip, user_agent)
    VALUES (${user.id}::uuid, ${hashToken(token)},
            now() + interval '${sql.raw(String(SESSION_TTL_HOURS))} hours',
            ${input.ip ?? null}, ${input.userAgent ?? null})
    RETURNING id
  `))[0]!;

  await db.execute(sql`
    UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_seen_at = now()
     WHERE id = ${user.id}::uuid
  `);

  return {
    ok: true,
    token,
    user: {
      userId: user.id,
      email: user.email,
      label: user.display_name,
      role: user.role,
      sessionId: session.id,
    },
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Resolve a cookie token to the person holding it, or null.
 *
 * Every request runs this, so it is one indexed lookup and one cheap write. The
 * write is the sliding last_seen_at, which is what makes "who is signed in
 * right now" answerable without guessing.
 */
export async function verifySession(db: any, token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const found = rows<{
    session_id: string; user_id: string; email: string;
    display_name: string; role: string;
  }>(await db.execute(sql`
    SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name, u.role
      FROM app_session s
      JOIN app_user u ON u.id = s.user_id
     WHERE s.token_hash = ${hashToken(token)}
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.active
  `))[0];

  if (!found) return null;

  await db.execute(sql`
    UPDATE app_session SET last_seen_at = now() WHERE id = ${found.session_id}::uuid
  `);

  return {
    sessionId: found.session_id,
    userId: found.user_id,
    email: found.email,
    label: found.display_name,
    role: found.role,
  };
}

export async function signOut(db: any, token: string | null | undefined): Promise<void> {
  if (!token) return;
  await db.execute(sql`
    UPDATE app_session SET revoked_at = now()
     WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
  `);
}

/** For a lost device, a PIN change, or an employee who has left. */
export async function revokeAllSessions(db: any, userId: string): Promise<number> {
  const r = rows<{ n: number }>(await db.execute(sql`
    WITH revoked AS (
      UPDATE app_session SET revoked_at = now()
       WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
       RETURNING 1
    )
    SELECT count(*)::int AS n FROM revoked
  `));
  return Number(r[0]?.n ?? 0);
}
