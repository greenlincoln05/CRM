import { NextResponse } from 'next/server';
import { searchCustomers } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  try {
    return NextResponse.json({ hits: await searchCustomers(q, 20) });
  } catch (err: any) {
    console.error('[search]', err);
    return NextResponse.json({ hits: [], error: String(err?.message ?? err) }, { status: 500 });
  }
}
