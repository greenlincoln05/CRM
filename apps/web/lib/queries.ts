import { sql } from 'drizzle-orm';
import { getDb } from './db';

const rows = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

export type SearchHit = {
  id: string;
  display_name: string;
  account_number: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  city: string | null;
  state: string | null;
  score: number;
};

export async function searchCustomers(q: string, limit = 20): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  const { db } = await getDb();
  return rows<SearchHit>(await db.execute(sql`SELECT * FROM search_customers(${q}, ${limit})`));
}

export type CustomerDetail = {
  id: string;
  display_name: string;
  account_number: string | null;
  kind: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  status: string;
  customer_since: string | null;
  tax_exempt: boolean;
  tax_exempt_id: string | null;
  legacy_id: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

/**
 * Everything the detail page shows AND everything its edit form needs to open
 * populated. One query rather than two: the form is opened as often to read a
 * value as to change one.
 */
export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const { db } = await getDb();
  const r = rows<CustomerDetail>(await db.execute(sql`
    SELECT c.id, c.display_name, c.account_number, c.kind, c.company_name,
           c.first_name, c.last_name,
           c.primary_phone, c.primary_email, c.status, c.customer_since,
           c.tax_exempt, c.tax_exempt_id, c.legacy_id,
           a.line1, a.line2, a.city, a.state, a.postal_code
    FROM customer c
    LEFT JOIN address a ON a.id = c.billing_address_id
    WHERE c.id = ${id}::uuid
  `));
  return r[0] ?? null;
}

export type PropertyRow = {
  id: string;
  label: string | null;
  property_type: string | null;
  active: boolean;
  is_primary: boolean;
  access_notes: string | null;
  has_gate_code: boolean;
  pet_notes: string | null;
  water_shutoff_notes: string | null;
  electrical_notes: string | null;
  parking_notes: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

/**
 * gate_code_enc is reduced to a boolean and never selected.
 *
 * ADR 0003: the ciphertext has no business travelling to a page that only needs
 * to know whether a "show" button belongs there. The code itself comes from
 * /api/gate-code, one property at a time, logged.
 */
export async function getProperties(customerId: string): Promise<PropertyRow[]> {
  const { db } = await getDb();
  return rows<PropertyRow>(await db.execute(sql`
    SELECT p.id, p.label, p.property_type, p.active, p.is_primary,
           p.access_notes, p.pet_notes, p.water_shutoff_notes,
           p.electrical_notes, p.parking_notes,
           (p.gate_code_enc IS NOT NULL) AS has_gate_code,
           a.line1, a.line2, a.city, a.state, a.postal_code
    FROM property p
    LEFT JOIN address a ON a.id = p.address_id
    WHERE p.customer_id = ${customerId}::uuid
    ORDER BY p.active DESC, p.is_primary DESC, p.label
  `));
}

export type ContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  is_primary: boolean;
  do_not_contact: boolean;
  notes: string | null;
};

export async function getContacts(customerId: string): Promise<ContactRow[]> {
  const { db } = await getDb();
  return rows<ContactRow>(await db.execute(sql`
    SELECT id, first_name, last_name, role, phone, mobile, email,
           is_primary, do_not_contact, notes
    FROM contact WHERE customer_id = ${customerId}::uuid
    ORDER BY is_primary DESC, last_name
  `));
}

export type TimelineRow = {
  id: string;
  occurred_at: string;
  kind: string;
  source: string;
  title: string | null;
  body: string | null;
  actor_label: string | null;
  pinned: boolean;
  payload: Record<string, unknown> | null;
  property_label: string | null;
  ref_type: string | null;
  ref_id: string | null;
  /**
   * For a redaction announcement, whether the entry it names is STILL hidden.
   *
   * Restoring cannot remove the announcement - the feed is append-only - so
   * without this the Restore button outlives the thing it restores and then
   * silently does nothing when clicked.
   */
  ref_is_redacted: boolean;
};

/**
 * Redacted entries are excluded, but the act of redacting one is itself an
 * event on this feed - so a hidden entry leaves a visible, attributed gap
 * rather than a silent one.
 */
export async function getTimeline(customerId: string, limit = 200): Promise<TimelineRow[]> {
  const { db } = await getDb();
  return rows<TimelineRow>(await db.execute(sql`
    SELECT t.id, t.occurred_at, t.kind, t.source, t.title, t.body,
           t.actor_label, t.pinned, t.payload, t.ref_type, t.ref_id,
           p.label AS property_label,
           (ref.redacted_at IS NOT NULL) AS ref_is_redacted
    FROM timeline_event t
    -- Compared as text rather than casting ref_id to uuid: ref_id also holds
    -- ids for other ref_types, and a cast would fail on the first one that is
    -- not a uuid regardless of how the join is ordered.
    LEFT JOIN timeline_event ref
      ON t.ref_type = 'timeline_event' AND ref.id::text = t.ref_id
    LEFT JOIN property p ON p.id = t.property_id
    WHERE t.customer_id = ${customerId}::uuid
      AND t.redacted_at IS NULL
    ORDER BY t.pinned DESC, t.occurred_at DESC
    LIMIT ${limit}
  `));
}

export type WaterTestRow = {
  id: string;
  tested_at: string;
  source: string;
  free_chlorine: string | null;
  total_chlorine: string | null;
  ph: string | null;
  total_alkalinity: string | null;
  calcium_hardness: string | null;
  cyanuric_acid: string | null;
  salt: string | null;
  phosphates: string | null;
  temperature_f: string | null;
  recommendation: string | null;
  notes: string | null;
  property_label: string | null;
  tested_by: string | null;
};

/**
 * Recent chemistry, newest first.
 *
 * Separate from the timeline even though every test also appears there, because
 * "what has this pool been doing all season" is a different question from "what
 * happened on this account", and the answer wants the numbers side by side.
 */
export async function getWaterTests(customerId: string, limit = 12): Promise<WaterTestRow[]> {
  const { db } = await getDb();
  return rows<WaterTestRow>(await db.execute(sql`
    SELECT w.id, w.tested_at, w.source,
           w.free_chlorine, w.total_chlorine, w.ph, w.total_alkalinity,
           w.calcium_hardness, w.cyanuric_acid, w.salt, w.phosphates,
           w.temperature_f, w.recommendation, w.notes,
           p.label AS property_label, u.display_name AS tested_by
      FROM water_test w
      LEFT JOIN property p ON p.id = w.property_id
      LEFT JOIN app_user u ON u.id = w.tested_by_user_id
     WHERE w.customer_id = ${customerId}::uuid
     ORDER BY w.tested_at DESC
     LIMIT ${limit}
  `));
}

/** Landing-page counters, so an empty database is obviously empty. */
export async function getStats() {
  const { db } = await getDb();
  return rows<{ customers: number; properties: number; events: number }>(
    await db.execute(sql`
      SELECT (SELECT count(*)::int FROM customer)       AS customers,
             (SELECT count(*)::int FROM property)       AS properties,
             (SELECT count(*)::int FROM timeline_event) AS events
    `),
  )[0]!;
}

export type WorkOrderRow = {
  id: string;
  number: string | null;
  type: string;
  status: string;
  priority: string;
  scheduled_date: string | null;
  scheduled_window: string | null;
  estimated_minutes: number | null;
  sequence: number | null;
  summary: string | null;
  instructions: string | null;
  work_performed: string | null;
  incomplete_reason: string | null;
  completed_at: string | null;
  property_id: string | null;
  property_label: string | null;
  assigned_user_id: string | null;
  assignee: string | null;
  task_count: number;
  tasks_done: number;
};

/**
 * Every job on one customer's account, newest first.
 *
 * DESC puts NULLs first in Postgres and that is wanted here rather than merely
 * tolerated: a job with no date yet is the one still waiting on somebody, and
 * it belongs at the top of the account rather than buried under five years of
 * finished visits.
 */
export async function getWorkOrders(customerId: string, limit = 50): Promise<WorkOrderRow[]> {
  const { db } = await getDb();
  return rows<WorkOrderRow>(await db.execute(sql`
    SELECT w.id, w.number, w.type, w.status, w.priority,
           w.scheduled_date::text AS scheduled_date,
           w.scheduled_window, w.estimated_minutes, w.sequence,
           w.summary, w.instructions, w.work_performed, w.incomplete_reason,
           w.completed_at::text, w.property_id,
           p.label AS property_label,
           w.assigned_user_id, u.display_name AS assignee,
           (SELECT count(*)::int FROM work_order_task t
             WHERE t.work_order_id = w.id) AS task_count,
           (SELECT count(*)::int FROM work_order_task t
             WHERE t.work_order_id = w.id AND t.done) AS tasks_done
      FROM work_order w
      LEFT JOIN property p ON p.id = w.property_id
      LEFT JOIN app_user u ON u.id = w.assigned_user_id
     WHERE w.customer_id = ${customerId}::uuid
     ORDER BY w.scheduled_date DESC, w.sequence NULLS LAST, w.created_at DESC
     LIMIT ${limit}
  `));
}

export type ScheduledJobRow = WorkOrderRow & {
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  has_gate_code: boolean;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  en_route_at: string | null;
  arrived_at: string | null;
  assignee_capacity: number | null;
};

/**
 * One day's board: every job on a date, whoever it belongs to.
 *
 * THIS IS A LIST VIEW OVER PROPERTIES, and that is the whole reason the SELECT
 * list below is written out by hand instead of `p.*`. CLAUDE.md non-negotiable
 * #4 and ADR 0003 point 1: gate codes, lockbox codes and access notes are the
 * means of physical entry to several hundred houses, and a screen showing forty
 * of them at once is exactly the shape that must never exist. No gate_code_enc,
 * no access_notes, no pet_notes - `has_gate_code` is a boolean saying a code is
 * on file, which is all a "show code" button needs to know. The code itself
 * comes from /api/gate-code, one property per request, logged before it is
 * returned. /api/tech/day/route.ts draws the line in a different place on
 * purpose: it does carry access_notes and pet_notes, because it is one
 * technician's own assigned day and knowing about the dog before opening the
 * gate is the point. It carries no gate code either.
 *
 * `incomplete_reason` is returned because it is the thing that generates the
 * next job. The board shows only THAT a job was left unfinished and links to
 * the record; the technician's own words are read one customer at a time,
 * because free text is where a gate code goes when it goes somewhere it should
 * not. The phone writes it through /api/tech/sync when a technician marks a
 * job incomplete and says why.
 *
 * Unassigned jobs sort last as their own bucket - they are the work still
 * needing a name against it, not work belonging to a technician called NULL.
 * Cancelled jobs are returned rather than filtered: "why is nobody going to the
 * Nadeaus today" is a question the board should answer, not hide.
 */
export async function getDaySchedule(date?: string | null): Promise<ScheduledJobRow[]> {
  const { db } = await getDb();
  return rows<ScheduledJobRow>(await db.execute(sql`
    SELECT w.id, w.number, w.type, w.status, w.priority,
           w.scheduled_date::text AS scheduled_date,
           w.scheduled_window, w.estimated_minutes, w.sequence,
           w.summary, w.instructions, w.work_performed, w.incomplete_reason,
           w.en_route_at::text, w.arrived_at::text, w.completed_at::text,
           w.customer_id, w.property_id,
           w.assigned_user_id, u.display_name AS assignee,
           u.daily_capacity_minutes AS assignee_capacity,
           c.display_name  AS customer_name,
           c.primary_phone AS customer_phone,
           p.label AS property_label,
           (p.gate_code_enc IS NOT NULL) AS has_gate_code,
           a.line1, a.city, a.state, a.postal_code,
           (SELECT count(*)::int FROM work_order_task t
             WHERE t.work_order_id = w.id) AS task_count,
           (SELECT count(*)::int FROM work_order_task t
             WHERE t.work_order_id = w.id AND t.done) AS tasks_done
      FROM work_order w
      JOIN customer c ON c.id = w.customer_id
      LEFT JOIN app_user u ON u.id = w.assigned_user_id
      LEFT JOIN property p ON p.id = w.property_id
      LEFT JOIN address  a ON a.id = p.address_id
     WHERE w.scheduled_date = COALESCE(${date ?? null}::date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date)
     ORDER BY (w.assigned_user_id IS NULL), u.display_name,
              w.sequence NULLS LAST, w.scheduled_window
  `));
}

export type TechnicianRow = {
  id: string;
  display_name: string;
  role: string;
};

/**
 * Who a job can be assigned to.
 *
 * Not filtered to role = 'tech': the write layer does not restrict it either,
 * and in a shop this size the person driving to a call on a Saturday is
 * whoever is free. Techs sort first because they are the usual answer.
 *
 * Only the three columns a picker needs. app_user also holds pin_hash.
 */
export async function getTechnicians(): Promise<TechnicianRow[]> {
  const { db } = await getDb();
  return rows<TechnicianRow>(await db.execute(sql`
    SELECT id, display_name, role
      FROM app_user
     WHERE active
     ORDER BY (role <> 'tech'), display_name
  `));
}
