import { sql } from 'drizzle-orm';

/**
 * The ADR 0009 window: the work orders that make a technician "on this job
 * right now" for scoping decisions. Assigned to them, not cancelled, dated
 * between two days back and one day forward — backward-leaning because the
 * revisit that strands somebody carries Monday's date on Thursday — or
 * undated but touched in the last two days, because same-day emergencies are
 * assigned before they are dated and one job parked in March must not stay
 * an open-ended key.
 *
 * Shared by /api/gate-code (the decision this was written for, see the ADR)
 * and the photo GET in /api/tech/photo, so the two checks cannot drift.
 * Composes as a condition on an aliased `work_order w`.
 *
 * CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York', never CURRENT_DATE —
 * the server clock is GMT and CURRENT_DATE rolls over here in the evening.
 */
export function assignedInWindow(userId: string) {
  return sql`
    w.assigned_user_id = ${userId}::uuid
    AND w.status <> 'cancelled'
    AND (
      (w.scheduled_date IS NULL AND w.updated_at > now() - interval '2 days')
      OR w.scheduled_date BETWEEN
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date - 2
       AND (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date + 1
    )`;
}
