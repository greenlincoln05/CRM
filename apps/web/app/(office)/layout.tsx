import { getSessionUser } from '@/lib/session';
import { signOutAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Desktop back-office chrome. Not applied to /tech.
 *
 * Who is signed in stays visible at all times. This is a shared machine behind
 * a counter and people walk away from it mid-task; every note saved from here
 * carries that name permanently, so the name belongs on screen rather than
 * behind a menu.
 */
export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <div className="shell">
      <div className="topbar">
        <h1>Lake Champlain Pools, Spas &amp; Stoves</h1>
        <span className="sub">Phase 2 &middot; service &amp; dispatch</span>

        <div className="who-bar">
          <a className="sub" href="/schedule">Schedule →</a>
          <a className="sub" href="/tech">Technician app →</a>
          {user && (
            <>
              <span className="whoami" title={user.email}>
                {user.label}
                {user.role !== 'staff' && <span className="badge">{user.role}</span>}
              </span>
              <form action={signOutAction}>
                <button type="submit" className="linkish">Sign out</button>
              </form>
            </>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
