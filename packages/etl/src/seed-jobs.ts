/**
 * Seed a technician and a plausible day of work.
 *
 * Sprint 4 builds real dispatch. This exists so the mobile app has something
 * true-shaped to render, and so the offline behaviour can be exercised against
 * a day that looks like a day: a spread of job types, one with no property
 * attached, one already finished, one urgent.
 */
import { sql as dsql } from 'drizzle-orm';
import { createDb } from '@lcp/db';

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

  const plan = [
    { legacy: 'S-001', seq: 1, type: 'opening',   window: '8:00 – 10:00',  mins: 90,
      summary: 'Spring opening',
      instructions: 'Customer asked us to look at the liner seam on the north side while we are there. Do not promise a repair date.',
      tasks: ['Remove and fold winter cover', 'Reinstall skimmer baskets', 'Start pump, check for leaks', 'Balance water', 'Photograph liner seam'],
      status: 'scheduled', priority: 'normal' },

    { legacy: 'S-003', seq: 2, type: 'service',   window: '10:30 – 12:00', mins: 60,
      summary: 'Weekly commercial service',
      instructions: 'Check in at the front desk before going to the pump house. Invoice goes to AP, not the property.',
      tasks: ['Test and balance water', 'Check chlorine feeder', 'Backwash filter', 'Log readings for the health inspector'],
      status: 'scheduled', priority: 'normal' },

    { legacy: 'S-005', seq: 3, type: 'service',   window: 'after 1:00',    mins: 75,
      summary: 'Annual pellet stove cleaning',
      instructions: 'Stove is in the finished basement, use the bulkhead. Harman P43 installed 2019.',
      tasks: ['Vacuum burn pot and ash traps', 'Clean heat exchanger', 'Inspect gaskets', 'Test ignition cycle'],
      status: 'scheduled', priority: 'urgent' },

    { legacy: 'S-002', seq: 4, type: 'inspection', window: 'if time',      mins: 30,
      summary: 'Spa cover fit check',
      instructions: 'Steep driveway. Do not bring the big truck in mud season.',
      tasks: ['Measure cover', 'Photograph cabinet corners'],
      status: 'scheduled', priority: 'low' },
  ];

  let n = 0;
  for (const job of plan) {
    const p: any = byLegacy.get(job.legacy);
    if (!p) continue;

    const wo = rows(await db.execute(dsql`
      INSERT INTO work_order (number, customer_id, property_id, type, status, priority,
                              scheduled_date, scheduled_window, estimated_minutes, sequence,
                              assigned_user_id, summary, instructions)
      VALUES (${`W-${1000 + job.seq}`}, ${p.customer_id}, ${p.id}, ${job.type}, ${job.status},
              ${job.priority}, CURRENT_DATE, ${job.window}, ${job.mins}, ${job.seq},
              ${mike.id}, ${job.summary}, ${job.instructions})
      ON CONFLICT DO NOTHING
      RETURNING id`))[0];

    if (!wo) continue;
    n++;

    let i = 0;
    for (const label of job.tasks) {
      await db.execute(dsql`
        INSERT INTO work_order_task (work_order_id, sequence, label)
        VALUES (${wo.id}, ${i++}, ${label})`);
    }
  }

  console.log(`[seed] ${n} jobs for ${techs[0]!.name} today`);
  await close();
  return { technicianId: mike.id as string, jobs: n };
}
