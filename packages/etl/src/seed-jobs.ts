/**
 * Seed a technician and a plausible day of work.
 *
 * Sprint 4 builds real dispatch. This exists so the mobile app has something
 * true-shaped to render, and so the offline behaviour can be exercised against
 * a day that looks like a day: a spread of job types, one with no property
 * attached, one already finished, one urgent.
 *
 * Two things make it safe to run twice, which non-negotiable #2 requires of
 * everything that writes:
 *
 *   - Every row carries `(legacy_source, legacy_id)` and upserts on that pair,
 *     using the partial index from migration 0010. The predicate has to be
 *     repeated in the ON CONFLICT clause for Postgres to infer a partial index
 *     as the target - same shape as every upsert in transform.ts. Before that,
 *     a bare `ON CONFLICT DO NOTHING` was deduping by accident through the
 *     hardcoded W-100n job numbers, which is not a key and never was.
 *
 *   - Job numbers come from `work_order_number_seq` through the same allocator
 *     the write layer uses, so a seeded job cannot collide with one the office
 *     created. The pre-flight lookup means a re-run does not burn four numbers
 *     to insert nothing.
 *
 * The checklists come from TASK_TEMPLATES in the write layer rather than being
 * written out again here: the fixture should exercise the same seeding the
 * office gets, or it stops being evidence of anything.
 */
import { sql as dsql } from 'drizzle-orm';
import { createDb, tasksForType } from '@lcp/db';

/** Not 'evosus': these rows are ours, and the issue report should not count them. */
const SOURCE = 'seed';

export async function seedJobs() {
  const { db, close } = await createDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

  const techs = [
    { email: 'mtech@lakechamplainpools.example', name: 'Mike Tessier', role: 'tech' },
    { email: 'jtech@lakechamplainpools.example', name: 'Jess Nadeau', role: 'tech' },
  ];

  for (const t of techs) {
    // ON CONFLICT needs an explicit target, and the target must match the index
    // exactly. Migration 0008 makes email unique on lower(email) - case
    // insensitive, which is right for an email - so the conflict target is the
    // same expression. Without a target this silently inserted a duplicate
    // technician on every run.
    await db.execute(dsql`
      INSERT INTO app_user (email, display_name, role)
      VALUES (${t.email}, ${t.name}, ${t.role})
      ON CONFLICT (lower(email)) DO NOTHING`);
  }

  const mike = rows(await db.execute(dsql`
    SELECT id FROM app_user WHERE email = ${techs[0]!.email}`))[0];
  if (!mike) throw new Error('technician seed failed');

  // Properties from the demo customer set, looked up by their legacy ids so
  // this stays correct however the uuids come out.
  const props = rows(await db.execute(dsql`
    SELECT p.id, p.legacy_id, p.customer_id, p.label
    FROM property p WHERE p.legacy_source = 'evosus'`));
  const byLegacy = new Map(props.map((p: any) => [p.legacy_id, p]));

  const plan: Array<{
    legacy: string; seq: number; type: string; window: string; mins: number;
    summary: string; instructions: string; status: string; priority: string;
    /** Only where the type's own checklist would be the wrong one. */
    tasks?: string[];
  }> = [
    { legacy: 'S-001', seq: 1, type: 'opening',   window: '8:00 – 10:00',  mins: 90,
      summary: 'Spring opening',
      instructions: 'Customer asked us to look at the liner seam on the north side while we are there. Do not promise a repair date.',
      status: 'scheduled', priority: 'normal' },

    { legacy: 'S-003', seq: 2, type: 'service',   window: '10:30 – 12:00', mins: 60,
      summary: 'Weekly commercial service',
      instructions: 'Check in at the front desk before going to the pump house. Invoice goes to AP, not the property.',
      status: 'scheduled', priority: 'normal' },

    // Filed as a service call because there is no stove job type, which is why
    // the generic service checklist would send a technician looking for a
    // filter to backwash in somebody's basement.
    { legacy: 'S-005', seq: 3, type: 'service',   window: 'after 1:00',    mins: 75,
      summary: 'Annual pellet stove cleaning',
      instructions: 'Stove is in the finished basement, use the bulkhead. Harman P43 installed 2019.',
      tasks: ['Vacuum burn pot and ash traps', 'Clean heat exchanger', 'Inspect gaskets', 'Test ignition cycle'],
      status: 'scheduled', priority: 'urgent' },

    { legacy: 'S-002', seq: 4, type: 'inspection', window: 'if time',      mins: 30,
      summary: 'Spa cover fit check',
      instructions: 'Steep driveway. Do not bring the big truck in mud season.',
      status: 'scheduled', priority: 'low' },
  ];

  let n = 0;
  for (const job of plan) {
    const p: any = byLegacy.get(job.legacy);
    if (!p) continue;

    // Stable across runs and across however the uuids come out, which is what
    // makes the upsert below an upsert rather than a coincidence.
    const legacyId = `JOB-${job.legacy}`;

    // Pre-flight, so a second run does not consume four job numbers to insert
    // nothing. The index is still the guarantee; this is only politeness.
    const already = rows(await db.execute(dsql`
      SELECT id FROM work_order
       WHERE legacy_source = ${SOURCE} AND legacy_id = ${legacyId}`))[0];
    if (already) continue;

    const wo = rows(await db.execute(dsql`
      INSERT INTO work_order (number, customer_id, property_id, type, status, priority,
                              scheduled_date, scheduled_window, estimated_minutes, sequence,
                              assigned_user_id, summary, instructions,
                              legacy_source, legacy_id)
      VALUES ('W-' || nextval('work_order_number_seq'),
              ${p.customer_id}, ${p.id}, ${job.type}, ${job.status},
              ${job.priority}, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date, ${job.window}, ${job.mins}, ${job.seq},
              ${mike.id}, ${job.summary}, ${job.instructions},
              ${SOURCE}, ${legacyId})
      ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
      RETURNING id`))[0];

    if (!wo) continue;
    n++;

    let i = 0;
    for (const label of job.tasks ?? tasksForType(job.type)) {
      await db.execute(dsql`
        INSERT INTO work_order_task (work_order_id, sequence, label)
        VALUES (${wo.id}, ${i++}, ${label})`);
    }
  }

  console.log(`[seed] ${n} jobs for ${techs[0]!.name} today`);
  await close();
  return { technicianId: mike.id as string, jobs: n };
}
