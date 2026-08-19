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
  primary_phone: string | null;
  primary_email: string | null;
  status: string;
  customer_since: string | null;
  tax_exempt: boolean;
  legacy_id: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const { db } = await getDb();
  const r = rows<CustomerDetail>(await db.execute(sql`
    SELECT c.id, c.display_name, c.account_number, c.kind, c.company_name,
           c.primary_phone, c.primary_email, c.status, c.customer_since,
           c.tax_exempt, c.legacy_id,
           a.line1, a.city, a.state, a.postal_code
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
  access_notes: string | null;
  has_gate_code: boolean;
  pet_notes: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

export async function getProperties(customerId: string): Promise<PropertyRow[]> {
  const { db } = await getDb();
  return rows<PropertyRow>(await db.execute(sql`
    SELECT p.id, p.label, p.property_type, p.active,
           p.access_notes, p.pet_notes,
           (p.gate_code_enc IS NOT NULL) AS has_gate_code,
           a.line1, a.city, a.state, a.postal_code
    FROM property p
    LEFT JOIN address a ON a.id = p.address_id
    WHERE p.customer_id = ${customerId}::uuid
    ORDER BY p.is_primary DESC, p.label
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
};

export async function getContacts(customerId: string): Promise<ContactRow[]> {
  const { db } = await getDb();
  return rows<ContactRow>(await db.execute(sql`
    SELECT id, first_name, last_name, role, phone, mobile, email, is_primary
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
};

export async function getTimeline(customerId: string, limit = 200): Promise<TimelineRow[]> {
  const { db } = await getDb();
  return rows<TimelineRow>(await db.execute(sql`
    SELECT t.id, t.occurred_at, t.kind, t.source, t.title, t.body,
           t.actor_label, t.pinned, t.payload, p.label AS property_label
    FROM timeline_event t
    LEFT JOIN property p ON p.id = t.property_id
    WHERE t.customer_id = ${customerId}::uuid
      AND t.redacted_at IS NULL
    ORDER BY t.pinned DESC, t.occurred_at DESC
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
