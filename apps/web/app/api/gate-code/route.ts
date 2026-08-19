import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { decryptField, initFieldKey } from '@lcp/db';
import { getDb } from '@/lib/db';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Reveal one gate code, and record who revealed it.
 *
 * The code is decrypted here and returned once, for one property, to one
 * request. It is never included in the page payload, never in a list response,
 * and never in a log line - which is why this is a POST with an explicit id
 * rather than a field on the customer query.
 *
 * Sprint 2 closed the gap ADR 0003 left open: the reveal is now refused without
 * a session and recorded against a real user id, so "who had our code" has an
 * answer with a name in it rather than "unauthenticated-dev".
 *
 * ADR 0003 also deferred point 1 - "only on a property a technician has an
 * assigned job for" - until dispatch existed to scope to. Dispatch shipped, so
 * that condition has come due and is enforced below. The scope is field versus
 * office, not rank: see the comment on the check itself.
 */
export async function POST(request: Request) {
  // 401 rather than a redirect: this is called by fetch(), and an HTML login
  // page arriving where JSON was expected reads as a success to the caller.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to view gate codes.' }, { status: 401 });
  }

  const { db } = await getDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

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

  // ADR 0003 point 1, now that there are jobs to scope to. A technician gets
  // the code for a house they are actually working, and nothing else.
  //
  // The split is field versus office, NOT rank. Do not reuse the
  // `supervisor = admin || manager` predicate from /api/tech/photo, sync or
  // day: both packages/db/src/auth.ts and user-cli.ts default a new user to
  // 'staff', so everyone behind the counter is staff and staff is never
  // assigned a job. Scoping by rank would 403 the whole office.
  //
  // The office stays unscoped on purpose. The counter takes the "I'm locked
  // out, what have you got on file" call and reads the code to a technician
  // whose phone will not show it. Locking the counter out does not remove that
  // call, it moves gate codes onto sticky notes. Every reveal is logged either
  // way, and the audit trail is the control there.
  //
  // Checked before the property is looked up, so a refusal does not also
  // answer "is there a code on file for this address".
  if (user.role === 'tech') {
    const assigned = rows(await db.execute(sql`
      SELECT 1
      FROM work_order w
      WHERE w.property_id = ${propertyId}::uuid
        AND w.assigned_user_id = ${user.userId}::uuid
        AND w.status <> 'cancelled'
        AND (
          w.scheduled_date IS NULL
          OR w.scheduled_date BETWEEN
               (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date - 1
           AND (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date + 7
        )
      LIMIT 1`));

    // The window: yesterday through next week. Wide enough that a job that ran
    // long, got pushed a day, or is being prepped for Monday still opens the
    // gate; narrow enough that a job from last April does not. Unscheduled work
    // is included because an unscheduled assigned job is a real job.
    //
    // CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York', never CURRENT_DATE -
    // the server clock is GMT and CURRENT_DATE rolls over in the evening here.
    if (!assigned.length) {
      // No label, no customer name, no address: this line says who asked about
      // which id, and the id is only meaningful to someone who can already
      // query the database.
      console.warn('[gate-code] refused — no assigned job', user.userId, propertyId);
      return NextResponse.json(
        {
          error:
            'That job is not assigned to you, so this gate code is not available on your phone. '
            + 'Call the office — they can read you the code, or assign you the job.',
        },
        { status: 403 },
      );
    }
  }

  const found = rows(await db.execute(sql`
    SELECT p.gate_code_enc, p.label, c.display_name
    FROM property p JOIN customer c ON c.id = p.customer_id
    WHERE p.id = ${propertyId}::uuid
  `))[0];

  if (!found?.gate_code_enc) {
    return NextResponse.json({ error: 'No gate code on file' }, { status: 404 });
  }

  // Idempotent: normally a no-op because instrumentation.node.ts already
  // unwrapped at startup. Kept as the backstop, and deliberately OUTSIDE the
  // decrypt catch below — a KMS failure carries its own precise message (which
  // grant, which region) and must not be flattened into "wrong key or
  // tampered". See ADR 0008.
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
  // The reason deliberately does NOT embed the customer's name: this table is
  // append-only by trigger, so anything written here can never be redacted.
  // entity_id already identifies the property; join when reading.
  await db.execute(sql`
    INSERT INTO sensitive_access_log (user_id, actor_label, entity, entity_id, field, reason, ip, user_agent)
    VALUES (${user.userId}::uuid, ${user.label}, 'property', ${propertyId}::uuid, 'gate_code',
            ${`Viewed from web — ${found.label ?? 'property'}`},
            ${request.headers.get('x-forwarded-for') ?? null},
            ${request.headers.get('user-agent') ?? null})
  `);

  return NextResponse.json({ code });
}
