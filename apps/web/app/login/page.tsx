import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import LoginForm from './LoginForm';
import { getDb } from '@/lib/db';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The only page that does not require a session.
 *
 * On a database with no staff accounts at all it explains how to make the first
 * one, because the alternative - a self-service signup on the machine that
 * holds every customer's gate code - is not a trade anyone should make for the
 * sake of a smoother first run.
 */
export default async function LoginPage() {
  if (await getSessionUser()) redirect('/');

  let staffCount = 0;
  let reachable = true;
  try {
    const { db } = await getDb();
    const r: any = await db.execute(sql`SELECT count(*)::int AS n FROM app_user WHERE active`);
    staffCount = Number((r.rows ?? r)[0]?.n ?? 0);
  } catch {
    reachable = false;
  }

  return (
    <div className="loginwrap">
      {reachable && staffCount === 0 ? (
        <div className="card">
          <h3>No staff accounts yet</h3>
          <p style={{ marginTop: 0 }}>
            Create the first one from the repository. There is deliberately no
            sign-up form.
          </p>
          <pre className="cmd">
            npm run db:user -- add --email you@example.com --name &quot;Your Name&quot; --role admin
          </pre>
          <p className="hint" style={{ margin: 0 }}>
            Set <code>LCP_PIN</code> in your environment to keep the PIN out of your
            shell history.
          </p>
        </div>
      ) : (
        <LoginForm />
      )}

      {!reachable && (
        <p className="empty">
          Database not reachable. Run <code>npm run db:migrate</code>.
        </p>
      )}
    </div>
  );
}
