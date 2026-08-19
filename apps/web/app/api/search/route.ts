import { NextResponse } from 'next/server';
import { searchCustomers } from '@/lib/queries';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Results carry names, phone numbers and addresses. 401 rather than a
  // redirect, for the same reason as the gate-code route: the caller is fetch().
  if (!await getSessionUser()) {
    return NextResponse.json({ hits: [], error: 'Not signed in.' }, { status: 401 });
  }

  const q = new URL(request.url).searchParams.get('q') ?? '';
  try {
    return NextResponse.json({ hits: await searchCustomers(q, 20) });
  } catch (err: any) {
    console.error('[search]', err);
    return NextResponse.json({ hits: [], error: String(err?.message ?? err) }, { status: 500 });
  }
}
