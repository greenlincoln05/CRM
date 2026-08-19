/**
 * Route protection, active only when Clerk is configured (ADR 0004).
 *
 * With keys present, every route requires sign-in — this is an internal tool
 * with no public pages, so there is no allowlist to maintain. Unauthenticated
 * page loads redirect to Clerk's hosted sign-in; unauthenticated API calls are
 * rejected (exact status to verify once a Clerk instance exists — the data
 * routes carry their own 401 regardless).
 *
 * This middleware is convenience, not the enforcement: NEXT_PUBLIC_* gates are
 * inlined at build time, so a keyless build ships passthrough permanently.
 * Every page and API route therefore resolves the user itself via
 * lib/auth.ts — the app stays closed even when this file is a no-op.
 *
 * Without keys (embedded PGlite dev), the middleware is a no-op and
 * lib/auth.ts supplies the dev identity instead.
 *
 * Middleware runs on the edge runtime, which cannot read the repo-root .env
 * (no filesystem). Locally, Clerk keys therefore belong in
 * apps/web/.env.local; on Vercel they come from the project environment.
 */
import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const clerkConfigured =
  !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default clerkConfigured
  ? clerkMiddleware(async (auth) => {
      await auth.protect();
    })
  : function passthrough() {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    '/((?!_next|.*\\.(?:ico|png|jpg|jpeg|svg|css|js|map|woff2?)$).*)',
    '/(api|trpc)(.*)',
  ],
};
