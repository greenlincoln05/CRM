import '../office.css';
import OfficeNav from '../ui/OfficeNav';
import { NAV } from '@/lib/nav';
import { getSessionUser } from '@/lib/session';
import { signOutAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The office shell: icon rail, section panel, top bar, content.
 *
 * Who is signed in stays visible at all times — this is a shared machine
 * behind a counter and people walk away from it mid-task; every note saved
 * from here carries that name permanently, so the name lives in the top
 * bar, never behind a menu. (Unchanged rule from the previous shell.)
 *
 * The top-bar search is an entry point, not a second implementation: a
 * plain GET to "/", where CustomerSearch picks the query up. "/" focuses
 * it from anywhere (OfficeNav owns the key handler).
 */
export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <div className="office o-frame">
      <OfficeNav sections={NAV} />
      <div className="o-body">
        <div className="o-topbar">
          <form className="o-search" action="/" method="get">
            <input id="global-search" type="search" name="q"
              placeholder="Search customers…  ( / )" aria-label="Search customers" />
          </form>
          <div className="who-bar">
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
        <main className="o-main">{children}</main>
      </div>
    </div>
  );
}
