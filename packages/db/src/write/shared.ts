import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { WriteError, clean, normalizeState, normalizeZip } from './input.js';

/**
 * Machinery every write shares.
 *
 * Two rules are enforced here rather than left to each caller, because they are
 * the rules that make the rest of the system true:
 *
 *   1. Nothing is written without an actor. The signature makes it impossible
 *      to forget rather than merely inadvisable.
 *
 *   2. A change that a person would want explained leaves a timeline event.
 *      The feed is meant to replace five places where notes currently live, and
 *      it can only do that if it is where things are actually recorded.
 */

export const rows = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

export type Db = any;

/** Written into every row this layer creates, so hand-typed data is obvious. */
export const MANUAL_SOURCE = 'manual';

export type AddressInput = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
};

export function normalizeAddress(input: AddressInput) {
  return {
    line1: clean(input.line1),
    line2: clean(input.line2),
    city: clean(input.city),
    state: normalizeState(input.state),
    postalCode: normalizeZip(input.postalCode),
  };
}

export function addressIsEmpty(a: ReturnType<typeof normalizeAddress>): boolean {
  return !a.line1 && !a.line2 && !a.city && !a.state && !a.postalCode;
}

/**
 * Create or update the address behind a customer or property.
 *
 * Addresses are shared entities, but an edit here always means "this address
 * was wrong", never "this customer moved to a different existing address", so
 * updating in place is correct. A genuine move is a new property.
 */
export async function upsertAddress(
  db: Db, existingId: string | null, input: AddressInput,
): Promise<string | null> {
  const a = normalizeAddress(input);

  if (addressIsEmpty(a)) {
    // Nothing typed. Leave whatever is already there rather than blanking it.
    return existingId;
  }

  if (existingId) {
    await db.execute(sql`
      UPDATE address
         SET line1 = ${a.line1}, line2 = ${a.line2}, city = ${a.city},
             state = ${a.state}, postal_code = ${a.postalCode}
       WHERE id = ${existingId}::uuid
    `);
    return existingId;
  }

  const r = rows<{ id: string }>(await db.execute(sql`
    INSERT INTO address (line1, line2, city, state, postal_code, legacy_source)
    VALUES (${a.line1}, ${a.line2}, ${a.city}, ${a.state}, ${a.postalCode}, ${MANUAL_SOURCE})
    RETURNING id
  `));
  return r[0]!.id;
}

export function formatAddress(a: {
  line1?: string | null; city?: string | null; state?: string | null; postalCode?: string | null;
}): string {
  const tail = [a.city, a.state].filter(Boolean).join(', ');
  return [a.line1, [tail, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export type EventInput = {
  customerId: string;
  propertyId?: string | null;
  kind: string;
  title?: string | null;
  body?: string | null;
  occurredAt?: Date | null;
  direction?: string | null;
  refType?: string | null;
  refId?: string | null;
  payload?: Record<string, unknown>;
  pinned?: boolean;
};

/**
 * Append one event to the timeline.
 *
 * actor_user_id AND actor_label are both written: the id is the truth, the
 * label is what keeps a 2026 note readable in 2040 after that person's account
 * is long gone. The migration already relies on actor_label for exactly this
 * reason, with legacy rows naming employees who no longer exist.
 */
export async function recordEvent(
  db: Db, actor: Actor, e: EventInput,
): Promise<{ id: string }> {
  const r = rows<{ id: string }>(await db.execute(sql`
    INSERT INTO timeline_event (
      customer_id, property_id, occurred_at, kind, source, direction,
      actor_user_id, actor_label, title, body, ref_type, ref_id, payload,
      pinned, legacy_source
    ) VALUES (
      ${e.customerId}::uuid,
      ${e.propertyId ?? null},
      ${e.occurredAt ?? new Date()},
      ${e.kind},
      'app',
      ${e.direction ?? null},
      ${actor.userId}::uuid,
      ${actor.label},
      ${e.title ?? null},
      ${e.body ?? null},
      ${e.refType ?? null},
      ${e.refId ?? null},
      ${JSON.stringify(e.payload ?? {})}::jsonb,
      ${e.pinned ?? false},
      ${MANUAL_SOURCE}
    )
    RETURNING id
  `));
  return r[0]!;
}

/**
 * Turn a before/after pair into the sentence a person would have written.
 *
 * "Phone changed from (802) 555-0142 to (802) 555-9987" is worth a timeline
 * row. "updated_at changed" is not, and neither is a field nobody touched.
 */
export function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  labels: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (String(from ?? '') === String(to ?? '')) continue;

    if (from === null || from === '') out.push(`${label} set to ${show(to)}`);
    else if (to === null || to === '') out.push(`${label} cleared (was ${show(from)})`);
    else out.push(`${label} changed from ${show(from)} to ${show(to)}`);
  }
  return out;
}

function show(v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return `"${String(v)}"`;
}

/**
 * Did this error come from a specific unique index?
 *
 * The pre-flight SELECT in front of a unique column is a friendly message, not
 * a guarantee - two terminals can both pass it before either commits. The index
 * is the guarantee, and this is what turns its violation back into the same
 * sentence the pre-flight check would have produced.
 *
 * The driver error is wrapped by drizzle as "Failed query: ...", with the
 * Postgres error - the one carrying code 23505 and the constraint name - hung
 * on .cause, so the whole chain is walked.
 */
export function isUniqueViolation(err: unknown, indexName?: string): boolean {
  for (let e = err as any; e; e = e.cause) {
    if (e.code === '23505') {
      return !indexName || String(e.constraint_name ?? e.constraint ?? '') === indexName;
    }
  }
  return false;
}

/** Guard for ids arriving from a form post. */
export function assertUuid(v: unknown, field: string): string {
  const s = clean(v);
  if (!s || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new WriteError('That record could not be found.', field);
  }
  return s;
}

export async function customerExists(db: Db, customerId: string): Promise<boolean> {
  return rows(await db.execute(sql`
    SELECT 1 FROM customer WHERE id = ${customerId}::uuid
  `)).length > 0;
}

/**
 * What is safe to store on a failed batch.
 *
 * 200 characters is enough for "fetch failed", "401 Unauthorized" or
 * "getaddrinfo ENOTFOUND", which is the entire diagnostic value of this field.
 * The truncation is marked so nobody reads a clipped message as a complete one.
 *
 * Deliberately NOT a redaction pass over the text. Guessing which substrings
 * are personal is the approach that works until the day it doesn't.
 *
 * But be honest about what a length bound buys, because the first version of
 * this comment was not. It bounds VOLUME, not CONTENT. The ADR requirement is
 * a content property, and this does not deliver it: a short well-formed API
 * error — `400 Bad Request: {"error":"no customer bob@example.com"}` — is 73
 * characters and arrives whole, email included. What this does is cap the
 * blast radius so a whole response body cannot land in a triage report. That
 * is worth having and it is not the same as exclusion.
 *
 * `name` is bounded too, and that is not paranoia. `throw await res.json()` is
 * an ordinary adapter mistake, and it hands this function an object whose
 * `.name` is whatever the vendor put in that field — which for an order
 * endpoint is plausibly a person's name. Measured before it was bounded: an
 * error carrying a 5,000-character name stored all 5,000, walking straight
 * past a limit that only ever inspected the other property.
 *
 * ── The params section, and why the length bound is not what saves you ──────
 *
 * Drizzle wraps every failed query in a DrizzleQueryError whose message is
 * `Failed query: <SQL>\nparams: <bound values>`. On the ETL path those bound
 * values ARE the customer table — names, emails, addresses. Whether the clip
 * removed them was therefore decided by how long the failing statement's text
 * happened to be, which is not a security property. Measured, by forcing each
 * statement in transform.ts to fail and reading the column back:
 *
 *   customer INSERT        params begin at 1197   safely past the clip
 *   property INSERT                          718   safely past
 *   import_issue INSERT                      169   INSIDE - 31 chars of it
 *   SELECT id FROM customer                   90   INSIDE - ~110 chars
 *
 * On a real demo run the import_issue case stopped at a bound uuid with about
 * 60 characters to spare before a customer's name. Nothing asserted that.
 *
 * So the params section is now removed structurally, before any clipping. It
 * is deterministic, it kills the whole class rather than a percentage of it,
 * and it costs nothing on a path whose errors have no such marker.
 *
 * ── Do not "improve" this by joining the cause chain ─────────────────────────
 *
 * `.message` on a DrizzleQueryError is the SQL, so the ETL path records no
 * diagnosis - and the obvious fix is to append `err.cause.message`, which is
 * what this file's own `refused()` test helper does. Do not. Postgres embeds
 * the offending value verbatim, confirmed on all three of:
 *
 *   date/time field value out of range: "13/45/2019"
 *   Key (legacy_source, legacy_id)=(evosus, 14032) already exists.
 *     cannot be converted to text.
 *
 * If diagnosis is wanted, take the STRUCTURAL fields off the cause instead -
 * `code` (SQLSTATE), `constraint`, `table`. They name the rule that broke and
 * carry no row data.
 */
export function batchError(err: unknown): string {
  const name = String((err as any)?.name ?? 'Error').slice(0, 40);
  // Split before clip. The marker is drizzle's own, and a message without one
  // is unchanged.
  const message = String((err as any)?.message ?? err ?? '').split('\nparams:')[0]!;
  const clipped = message.length > 200 ? `${message.slice(0, 200)}… (truncated)` : message;
  return clipped ? `${name}: ${clipped}` : name;
}
