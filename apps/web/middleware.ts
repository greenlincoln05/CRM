import { NextResponse, type NextRequest } from 'next/server';

/**
 * A cheap gate in front of the counter pages.
 *
 * This checks only that a session cookie EXISTS. It deliberately does not
 * verify it: middleware runs on the edge runtime, where there is no database
 * driver and no node:crypto, and a check that cannot reach app_session is not a
 * security boundary. The real one is requireUser() in each server component,
 * which resolves the token against the database on every request.
 *
 * So this is a redirect for the ordinary case - nobody signed in yet - and
 * nothing more. A forged cookie gets past it and straight into requireUser().
 *
 * API routes are not matched. Redirecting a POST to an HTML login page gives
 * the caller a confusing 200 instead of a refusal, so those enforce their own
 * session and answer 401 in JSON. The technician endpoints under /api/tech are
 * likewise left alone.
 */

// Kept as a literal rather than imported from @lcp/db: that module pulls in the
// database driver, which does not belong in an edge bundle.
const SESSION_COOKIE = 'lcp_session';

export function middleware(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  // Where they were heading, so sign-in can finish the journey later.
  url.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/', '/customers/:path*', '/schedule/:path*'],
};
