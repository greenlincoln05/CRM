import { NextResponse } from 'next/server';
import { searchCustomers } from '@/lib/queries';
import { currentAppUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Search returns names, phones, and addresses — it is as much a data surface
  // as the customer page, and it carries its own check so the app stays closed
  // even when the middleware compiled to passthrough (see lib/auth.ts).
  if (!(await currentAppUser())) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get('q') ?? '';
  try {
    return NextResponse.json({ hits: await searchCustomers(q, 20) });
  } catch (err: any) {
    console.error('[search]', err);
    return NextResponse.json({ hits: [], error: String(err?.message ?? err) }, { status: 500 });
  }
}
