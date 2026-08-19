import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { decryptField, initFieldKey } from '@lcp/db';
import { getDb } from '@/lib/db';
import { currentAppUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Reveal one gate code, and record who did it.
 *
 * The code is decrypted here and returned once, for one property, to one
 * request. It is never included in the page payload, never in a list response,
 * and never in a log line - which is why this is a POST with an explicit id
 * rather than a field on the customer query.
 *
 * Anonymous callers are rejected before anything else happens - before the
 * body is parsed, before the database is touched. When Clerk is configured
 * the middleware already turned them away; this check is defense in depth,
 * and it is what fails closed if a deployment forgot to configure auth at
 * all (see lib/auth.ts). ADR 0003.
 */
export async function POST(request: Request) {
  const user = await currentAppUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const { db } = await getDb();

  let propertyId: string;
  try {
    ({ propertyId } = await request.json());
    // Validate shape here so a malformed id is a 400, not a 500 out of ::uuid.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId ?? '')) {
      throw new Error('bad id');
    }
  } catch {
    return NextResponse.json({ error: 'propertyId (uuid) required' }, { status: 400 });
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

  // Idempotent: normally a no-op because instrumentation.ts already unwrapped
  // at startup. Kept as the backstop, and deliberately OUTSIDE the decrypt
  // catch below — a KMS failure carries its own precise message (which grant,
  // which region) and must not be flattened into "wrong key or tampered".
  try {
    await initFieldKey();
  } catch (err: any) {
    console.error('[gate-code] field key unavailable:', err?.message);
    return NextResponse.json(
      { error: 'Gate codes are unavailable — the server key is not configured.' },
      { status: 503 },
    );
  }

  let code: string | null;
  try {
    code = decryptField(found.gate_code_enc);
  } catch (err: any) {
    // A failed decrypt means the wrong key or a tampered value. Both are worth
    // shouting about rather than showing the user an empty box.
    // Full detail server-side; the client does not need internal env-var names.
    console.error('[gate-code] decrypt failed (wrong key or tampered value):', err?.message);
    return NextResponse.json(
      { error: 'Could not decrypt this code. Ask an admin to check the server key.' },
      { status: 500 },
    );
  }

  // Log BEFORE returning: a reveal that failed to record must not succeed.
  // user_id is the real foreign key; actor_label keeps the log readable
  // straight out of the table without a join. The reason deliberately does NOT
  // embed the customer's name: this table is append-only by trigger, so
  // anything written here can never be redacted. entity_id already identifies
  // the property; join when reading.
  await db.execute(sql`
    INSERT INTO sensitive_access_log (user_id, actor_label, entity, entity_id, field, reason, ip, user_agent)
    VALUES (${user.id}::uuid, ${user.displayName}, 'property', ${propertyId}::uuid, 'gate_code',
            ${`Viewed from web — ${found.label ?? 'property'}`},
            ${request.headers.get('x-forwarded-for') ?? null},
            ${request.headers.get('user-agent') ?? null})
  `);

  return NextResponse.json({ code });
}
