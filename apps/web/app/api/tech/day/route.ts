import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Everything a technician needs for today, in one request.
 *
 * One request rather than several because it is fetched over cellular in a
 * parking lot before driving out of range, and a partial sync is worse than a
 * slow one. The device stores the whole payload and works from it offline.
 *
 * Gate codes are deliberately NOT included. They are fetched per property, on
 * demand, so each one is logged — see /api/gate-code.
 *
 * The technician comes from the session, never from the request. An earlier
 * version accepted `?tech=<uuid>` with no authentication at all, which meant
 * anyone who could reach the server could read any technician's whole day:
 * customer names, phone numbers, addresses, and which houses would be empty and
 * when. A supervisor can still look at someone else's day; a technician gets
 * their own and only their own.
 */
export async function GET(request: Request) {
  // 401 rather than a redirect: the caller is fetch(), and an HTML login page
  // arriving where JSON was expected reads as success to the caller.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to load your day.' }, { status: 401 });
  }

  const { db } = await getDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

  const url = new URL(request.url);
  const requested = url.searchParams.get('tech');
  const date = url.searchParams.get('date');

  const isSupervisor = user.role === 'admin' || user.role === 'manager';
  if (requested && requested !== user.userId && !isSupervisor) {
    return NextResponse.json({ error: 'You can only load your own day.' }, { status: 403 });
  }
  const techId = requested && isSupervisor ? requested : user.userId;

  const tech = rows(await db.execute(sql`
    SELECT id, display_name FROM app_user WHERE id = ${techId}::uuid AND active`))[0];
  if (!tech) {
    return NextResponse.json({ error: 'No such technician.' }, { status: 404 });
  }

  const jobs = rows(await db.execute(sql`
    SELECT
      w.id, w.number, w.type, w.status, w.priority, w.scheduled_window,
      w.estimated_minutes, w.sequence, w.summary, w.instructions, w.work_performed,
      w.incomplete_reason,
      w.customer_id, w.property_id,
      c.display_name  AS customer_name,
      c.primary_phone AS customer_phone,
      p.label         AS property_label,
      p.access_notes, p.pet_notes,
      (p.gate_code_enc IS NOT NULL) AS has_gate_code,
      a.line1, a.city, a.state, a.postal_code
    FROM work_order w
    JOIN customer c ON c.id = w.customer_id
    LEFT JOIN property p ON p.id = w.property_id
    LEFT JOIN address  a ON a.id = p.address_id
    WHERE w.assigned_user_id = ${tech.id}::uuid
      AND w.scheduled_date = COALESCE(${date ?? null}::date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date)
    ORDER BY w.sequence NULLS LAST, w.scheduled_window
  `));

  // Parameterized rather than interpolated. These ids come from our own
  // database, but building SQL by string concatenation is a habit that stops
  // being harmless the first time the values come from somewhere else.
  const tasks = jobs.length
    ? rows(await db.execute(sql`
        SELECT id, work_order_id, sequence, label, done
        FROM work_order_task
        WHERE work_order_id IN (${sql.join(jobs.map((j) => sql`${j.id}::uuid`), sql`, `)})
        ORDER BY sequence`))
    : [];

  return NextResponse.json({
    technician: { id: tech.id, name: tech.display_name },
    date: date ?? new Date().toISOString().slice(0, 10),
    jobs,
    tasks,
    serverTime: new Date().toISOString(),
  });
}
