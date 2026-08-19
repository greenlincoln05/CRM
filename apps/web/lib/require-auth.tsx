/**
 * Server-side auth gate for pages.
 *
 * The middleware redirects unauthenticated visitors when Clerk is configured,
 * but pages carry their own check so the app stays closed when it is not —
 * a keyless build inlines the middleware into a permanent passthrough, and
 * these page-level checks are what hold in that state (see lib/auth.ts).
 *
 * When Clerk is live this screen is rarely seen: the middleware redirects to
 * sign-in first. It exists for the misconfigured deployment, where the honest
 * answer is "this system is not set up," not a customer list.
 */
import { currentAppUser, type AuthedUser } from './auth';

export async function requirePageUser(): Promise<
  { user: AuthedUser; denied: null } | { user: null; denied: React.ReactNode }
> {
  const user = await currentAppUser();
  if (user) return { user, denied: null };
  return {
    user: null,
    denied: (
      <div className="card" style={{ margin: '4rem auto', maxWidth: '28rem', textAlign: 'center' }}>
        <h2>Sign in required</h2>
        <p className="sub">
          This system is not accepting anonymous access. If you expected to be
          signed in, authentication is not configured for this deployment.
        </p>
      </div>
    ),
  };
}
