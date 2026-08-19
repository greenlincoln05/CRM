import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { decryptField } from '@lcp/db';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Reveal one gate code, and record that it happened.
 *
 * The code is decrypted here and returned once, for one property, to one
 * request. It is never included in the page payload, never in a list response,
 * and never in a log line - which is why this is a POST with an explicit id
 * rather than a field on the customer query.
 *
 * TODO(auth): actorLabel is a placeholder until the identity provider is wired
 * in. Once it is, this route must reject unauthenticated callers and record the
 * real user id. The log table is already shaped for it.
 */
export async function POST(request: Request) {
  const { db } = await getDb();

  let propertyId: string;
  try {
    ({ propertyId } = await request.json());
    if (!propertyId) throw new Error('propertyId required');
  } catch {
    return NextResponse.json({ error: 'propertyId required' }, { status: 400 });
  }

  const rows = (r: any) => (r?.rows ?? r) as any[];

  const found = rows(await db.execute(sql`
    SELECT p.gate_code_enc, p.label, c.display_name
    FROM property p JOIN customer c ON c.id = p.customer_id
    WHERE p.id = ${propertyId}::uuid
  `))[0];

  if (!found?.gate_code_enc) {
    return NextResponse.json({ error: 'No gate code on file' }, { status: 404 });
  }

  let code: string | null;
  try {
    code = decryptField(found.gate_code_enc);
  } catch (err: any) {
    // A failed decrypt means the wrong key or a tampered value. Both are worth
    // shouting about rather than showing the user an empty box.
    console.error('[gate-code] decrypt failed', err?.message);
    return NextResponse.json(
      { error: 'Could not decrypt. Check LCP_FIELD_KEY.' },
      { status: 500 },
    );
  }

  // Log BEFORE returning: a reveal that failed to record must not succeed.
  await db.execute(sql`
    INSERT INTO sensitive_access_log (actor_label, entity, entity_id, field, reason, ip, user_agent)
    VALUES (${'unauthenticated-dev'}, 'property', ${propertyId}::uuid, 'gate_code',
            ${`Viewed for ${found.display_name} — ${found.label ?? 'property'}`},
            ${request.headers.get('x-forwarded-for') ?? null},
            ${request.headers.get('user-agent') ?? null})
  `);

  return NextResponse.json({ code });
}
