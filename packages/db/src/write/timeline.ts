import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { WriteError, clean, oneOf, required } from './input.js';
import {
  type Db, assertUuid, customerExists, recordEvent, rows,
} from './shared.js';

/**
 * Writing to the feed.
 *
 * The timeline is append-only in the database, which means this module has
 * exactly one way to change the past: add to it. A correction is a new event, a
 * redaction hides without erasing, and both leave their own trace.
 *
 * That constraint is the product feature. The brief asks this feed to replace
 * five places where notes currently live, and staff will only stop keeping a
 * private notebook if the shared record cannot be quietly rewritten by whoever
 * touched it last.
 */

/**
 * What a person may enter by hand. Sales and payments are deliberately absent:
 * those arrive from the register in Phase 4, and a hand-typed one would be a
 * number that reconciles against nothing.
 */
export const ENTERABLE_KINDS = [
  'note', 'call', 'sms', 'email', 'quote', 'service_call', 'delivery', 'install',
] as const;

export const DIRECTIONS = ['inbound', 'outbound'] as const;

/** Redaction hides what a colleague wrote, so it is not an everyday power. */
const REDACTION_ROLES = new Set(['admin', 'manager']);

export type NoteInput = {
  customerId: string;
  propertyId?: string | null;
  kind?: string;
  title?: string | null;
  body?: string | null;
  direction?: string | null;
  /** ISO string. Backdating is allowed; a call gets logged after it ends. */
  occurredAt?: string | null;
  pinned?: boolean;
};

export async function addNote(
  db: Db, actor: Actor, input: NoteInput,
): Promise<{ id: string }> {
  const customerId = assertUuid(input.customerId, 'customerId');
  const kind = oneOf(input.kind, ENTERABLE_KINDS, 'kind', 'note');

  const title = clean(input.title);
  const body = clean(input.body);
  if (!title && !body) {
    throw new WriteError('Write something before saving.', 'body');
  }

  const direction = input.direction == null || clean(input.direction) === null
    ? null
    : oneOf(input.direction, DIRECTIONS, 'direction');

  let occurredAt = new Date();
  if (clean(input.occurredAt)) {
    const parsed = new Date(String(input.occurredAt));
    if (Number.isNaN(parsed.getTime())) {
      throw new WriteError('That is not a valid date and time.', 'occurredAt');
    }
    // A few minutes of clock skew is fine. Next Tuesday is a typo, and it would
    // sit at the top of the feed until next Tuesday actually arrived.
    if (parsed.getTime() > Date.now() + 5 * 60_000) {
      throw new WriteError('An event cannot be recorded as happening in the future.', 'occurredAt');
    }
    occurredAt = parsed;
  }

  if (!await customerExists(db, customerId)) {
    throw new WriteError('That customer could not be found.', 'customerId');
  }

  let propertyId: string | null = null;
  if (clean(input.propertyId)) {
    propertyId = assertUuid(input.propertyId, 'propertyId');
    const owned = rows(await db.execute(sql`
      SELECT 1 FROM property WHERE id = ${propertyId}::uuid AND customer_id = ${customerId}::uuid
    `));
    if (owned.length === 0) {
      throw new WriteError('That property does not belong to this customer.', 'propertyId');
    }
  }

  return recordEvent(db, actor, {
    customerId,
    propertyId,
    kind,
    title,
    body,
    direction,
    occurredAt,
    pinned: Boolean(input.pinned),
  });
}

/**
 * Pinning floats an event to the top of the feed. "Owes us a liner."
 *
 * One of the two things the append-only trigger allows to change, because it is
 * presentation rather than history.
 */
export async function setEventPinned(
  db: Db, actor: Actor, eventId: string, pinned: boolean,
): Promise<{ id: string }> {
  const id = assertUuid(eventId, 'eventId');

  const found = rows<{ pinned: boolean }>(await db.execute(sql`
    SELECT pinned FROM timeline_event WHERE id = ${id}::uuid
  `))[0];
  if (!found) throw new WriteError('That entry could not be found.', 'eventId');

  await db.execute(sql`
    UPDATE timeline_event SET pinned = ${pinned} WHERE id = ${id}::uuid
  `);
  return { id };
}

/**
 * Hide an entry without destroying it.
 *
 * The only sanctioned alternative to a DELETE the database will not allow. It
 * costs a reason and a name, and it announces itself on the same feed it just
 * removed something from - otherwise a feed with a hole in it looks exactly
 * like a feed with nothing missing.
 */
export async function redactEvent(
  db: Db, actor: Actor, eventId: string, reason: string,
): Promise<{ id: string }> {
  const id = assertUuid(eventId, 'eventId');
  const why = required(reason, 'reason', 'A reason for hiding this entry');

  if (!REDACTION_ROLES.has(actor.role)) {
    throw new WriteError('Only a manager can hide a timeline entry.', 'reason');
  }

  const found = rows<{ customer_id: string; title: string | null; kind: string; redacted_at: string | null }>(
    await db.execute(sql`
      SELECT customer_id, title, kind, redacted_at FROM timeline_event WHERE id = ${id}::uuid
    `),
  )[0];
  if (!found) throw new WriteError('That entry could not be found.', 'eventId');
  if (found.redacted_at) return { id };

  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`
      UPDATE timeline_event
         SET redacted_at = now(), redacted_by_user_id = ${actor.userId}::uuid,
             redacted_reason = ${why}
       WHERE id = ${id}::uuid
    `);

    await recordEvent(tx, actor, {
      customerId: found.customer_id,
      kind: 'system',
      title: 'Timeline entry hidden',
      body: `A ${found.kind} entry${found.title ? ` ("${found.title}")` : ''} was hidden.\nReason: ${why}`,
      refType: 'timeline_event',
      refId: id,
      // Marks this as the announcement that carries the restore control. Both
      // announcements point at the same event, so without a discriminator the
      // UI cannot tell "was hidden" from "was restored" except by matching on
      // a title, which is a display string and not a fact.
      payload: { action: 'redact' },
    });

    return { id };
  });
}

/** A mistaken redaction should not be permanent. */
export async function unredactEvent(
  db: Db, actor: Actor, eventId: string,
): Promise<{ id: string }> {
  const id = assertUuid(eventId, 'eventId');

  if (!REDACTION_ROLES.has(actor.role)) {
    throw new WriteError('Only a manager can restore a hidden entry.', 'eventId');
  }

  const found = rows<{ customer_id: string; redacted_at: string | null }>(await db.execute(sql`
    SELECT customer_id, redacted_at FROM timeline_event WHERE id = ${id}::uuid
  `))[0];
  if (!found) throw new WriteError('That entry could not be found.', 'eventId');
  if (!found.redacted_at) return { id };

  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`
      UPDATE timeline_event
         SET redacted_at = NULL, redacted_by_user_id = NULL, redacted_reason = NULL
       WHERE id = ${id}::uuid
    `);

    await recordEvent(tx, actor, {
      customerId: found.customer_id,
      kind: 'system',
      title: 'Hidden timeline entry restored',
      refType: 'timeline_event',
      refId: id,
      payload: { action: 'unredact' },
    });

    return { id };
  });
}
