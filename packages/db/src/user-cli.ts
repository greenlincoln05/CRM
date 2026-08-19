/**
 * Staff accounts, from the command line.
 *
 *   npm run db:user -- add --email dana@example.com --name "Dana Whitcomb" --role manager
 *   npm run db:user -- list
 *   npm run db:user -- pin --email dana@example.com
 *   npm run db:user -- deactivate --email dana@example.com
 *
 * There is no self-service signup and no first-run wizard on purpose: the set
 * of people who work at the store changes a few times a year, and an admin
 * screen for it would be a login page nobody guards. This is the whole of user
 * administration until the identity provider lands (ADR 0005).
 *
 * Pass the PIN in LCP_PIN rather than --pin unless you want it in your shell
 * history forever.
 */
import { loadRepoEnv } from './env.js';
import { createDb } from './index.js';
import { createUser, setPin, revokeAllSessions, validatePin, ROLES, type Role } from './auth.js';
import { sql } from 'drizzle-orm';

loadRepoEnv();

const rows = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function requireArg(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return v;
}

function requirePin(): string {
  const pin = arg('pin') ?? process.env.LCP_PIN;
  if (!pin) {
    console.error('Missing PIN. Pass --pin 4417, or set LCP_PIN to keep it out of your shell history.');
    process.exit(1);
  }
  const problem = validatePin(pin);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  return pin;
}

const command = process.argv[2];
const { db, close } = await createDb();

try {
  switch (command) {
    case 'add': {
      const { id } = await createUser(db, {
        email: requireArg('email'),
        displayName: requireArg('name'),
        // Not cast. createUser checks the set, and a cast here would only
        // silence the compiler about the one input that fails open.
        role: (arg('role') ?? 'staff') as Role,
        pin: requirePin(),
      });
      console.log(`Created ${arg('email')} (${arg('role') ?? 'staff'})  id=${id}`);
      break;
    }

    case 'list': {
      const users = rows<{
        email: string; display_name: string; role: string; active: boolean;
        has_pin: boolean; last_seen_at: string | null; live_sessions: number;
      }>(await db.execute(sql`
        SELECT u.email, u.display_name, u.role, u.active,
               (u.pin_hash IS NOT NULL) AS has_pin, u.last_seen_at,
               (SELECT count(*)::int FROM app_session s
                 WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())
                 AS live_sessions
          FROM app_user u ORDER BY u.active DESC, u.display_name
      `));

      if (users.length === 0) {
        console.log('No staff accounts yet. Add one with:\n');
        console.log('  npm run db:user -- add --email you@example.com --name "Your Name" --role admin\n');
        break;
      }

      for (const u of users) {
        const bits = [
          u.active ? '' : 'INACTIVE',
          u.has_pin ? '' : 'NO PIN SET',
          u.live_sessions > 0 ? `${u.live_sessions} signed in` : '',
        ].filter(Boolean).join(', ');
        console.log(
          `${u.display_name.padEnd(24)} ${u.email.padEnd(30)} ${u.role.padEnd(8)}` +
          `${bits ? `  (${bits})` : ''}`,
        );
      }
      break;
    }

    case 'pin': {
      const email = requireArg('email').toLowerCase();
      const user = rows<{ id: string }>(await db.execute(sql`
        SELECT id FROM app_user WHERE lower(email) = ${email}
      `))[0];
      if (!user) {
        console.error(`No account for ${email}`);
        process.exitCode = 1;
        break;
      }
      await setPin(db, user.id, requirePin());
      console.log(`PIN updated for ${email}. Any existing sessions were signed out.`);
      break;
    }

    case 'deactivate': {
      const email = requireArg('email').toLowerCase();
      const user = rows<{ id: string }>(await db.execute(sql`
        UPDATE app_user SET active = false WHERE lower(email) = ${email} RETURNING id
      `))[0];
      if (!user) {
        console.error(`No account for ${email}`);
        process.exitCode = 1;
        break;
      }
      const ended = await revokeAllSessions(db, user.id);
      console.log(`${email} deactivated. ${ended} session(s) ended.`);
      break;
    }

    default:
      console.log(`Unknown command: ${command ?? '(none)'}

  add         --email E --name N [--role ${ROLES.join('|')}] [--pin P]
  list
  pin         --email E [--pin P]
  deactivate  --email E

Set LCP_PIN instead of passing --pin to keep it out of your shell history.
`);
      process.exitCode = 1;
  }
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exitCode = 1;
} finally {
  await close();
}
