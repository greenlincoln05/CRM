import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { WriteError, clean, formatPhone, normalizeEmail } from './input.js';
import {
  type Db, MANUAL_SOURCE, assertUuid, customerExists, describeChanges,
  recordEvent, rows,
} from './shared.js';

/**
 * The people attached to an account: spouse, property manager, tenant, AP clerk.
 *
 * "Poor handling of multiple contacts" is a named pain point in the brief, and
 * the shape of the fix is the one-primary rule. The database enforces it with a
 * partial unique index; this module is what makes promoting a new primary work
 * rather than fail, by demoting the old one in the same transaction.
 */

export const CONTACT_ROLES = [
  'owner', 'spouse', 'property_manager', 'tenant', 'ap', 'other',
] as const;

export type ContactInput = {
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  isPrimary?: boolean;
  doNotContact?: boolean;
  notes?: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  role: 'Role',
  phone: 'Phone',
  mobile: 'Mobile',
  email: 'Email',
  isPrimary: 'Primary contact',
  doNotContact: 'Do not contact',
  notes: 'Notes',
};

function validate(input: ContactInput) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName && !lastName) {
    throw new WriteError('A contact needs at least a first or last name.', 'firstName');
  }

  const role = clean(input.role);
  if (role && !CONTACT_ROLES.includes(role as typeof CONTACT_ROLES[number])) {
    throw new WriteError(`Role must be one of: ${CONTACT_ROLES.join(', ')}.`, 'role');
  }

  return {
    firstName,
    lastName,
    role,
    phone: formatPhone(input.phone, 'phone'),
    mobile: formatPhone(input.mobile, 'mobile'),
    email: normalizeEmail(input.email),
    isPrimary: Boolean(input.isPrimary),
    doNotContact: Boolean(input.doNotContact),
    notes: clean(input.notes),
  };
}

const nameOf = (c: { firstName?: string | null; lastName?: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ');

/**
 * Only one contact per customer may be primary, so promoting one demotes the
 * incumbent first. Order matters: the partial unique index is checked per
 * statement, not at commit, so the demotion has to land before the promotion.
 */
async function clearOtherPrimaries(tx: Db, customerId: string, exceptId?: string) {
  await tx.execute(sql`
    UPDATE contact SET is_primary = false
     WHERE customer_id = ${customerId}::uuid
       AND is_primary
       ${exceptId ? sql`AND id <> ${exceptId}::uuid` : sql``}
  `);
}

export async function addContact(
  db: Db, actor: Actor, customerId: string, input: ContactInput,
): Promise<{ id: string }> {
  const cid = assertUuid(customerId, 'customerId');
  const v = validate(input);

  if (!await customerExists(db, cid)) {
    throw new WriteError('That customer could not be found.', 'customerId');
  }

  return db.transaction(async (tx: Db) => {
    if (v.isPrimary) await clearOtherPrimaries(tx, cid);

    const created = rows<{ id: string }>(await tx.execute(sql`
      INSERT INTO contact (
        customer_id, first_name, last_name, role, phone, mobile, email,
        is_primary, do_not_contact, notes, legacy_source
      ) VALUES (
        ${cid}::uuid, ${v.firstName}, ${v.lastName}, ${v.role}, ${v.phone},
        ${v.mobile}, ${v.email}, ${v.isPrimary}, ${v.doNotContact}, ${v.notes},
        ${MANUAL_SOURCE}
      )
      RETURNING id
    `))[0]!;

    await recordEvent(tx, actor, {
      customerId: cid,
      kind: 'system',
      title: `Contact added: ${nameOf(v)}`,
      body: [v.role, v.phone, v.mobile, v.email].filter(Boolean).join('  ·  ') || null,
    });

    return created;
  });
}

export async function updateContact(
  db: Db, actor: Actor, contactId: string, input: ContactInput,
): Promise<{ id: string; changes: string[] }> {
  const id = assertUuid(contactId, 'contactId');
  const v = validate(input);

  const before = rows<{
    id: string; customer_id: string; first_name: string | null; last_name: string | null;
    role: string | null; phone: string | null; mobile: string | null; email: string | null;
    is_primary: boolean; do_not_contact: boolean; notes: string | null;
  }>(await db.execute(sql`SELECT * FROM contact WHERE id = ${id}::uuid`))[0];
  if (!before) throw new WriteError('That contact could not be found.', 'contactId');

  return db.transaction(async (tx: Db) => {
    if (v.isPrimary && !before.is_primary) {
      await clearOtherPrimaries(tx, before.customer_id, id);
    }

    await tx.execute(sql`
      UPDATE contact SET
        first_name = ${v.firstName}, last_name = ${v.lastName}, role = ${v.role},
        phone = ${v.phone}, mobile = ${v.mobile}, email = ${v.email},
        is_primary = ${v.isPrimary}, do_not_contact = ${v.doNotContact}, notes = ${v.notes}
      WHERE id = ${id}::uuid
    `);

    const changes = describeChanges(
      {
        firstName: before.first_name, lastName: before.last_name, role: before.role,
        phone: before.phone, mobile: before.mobile, email: before.email,
        isPrimary: before.is_primary, doNotContact: before.do_not_contact,
        notes: before.notes,
      },
      v,
      FIELD_LABELS,
    );

    if (changes.length > 0) {
      await recordEvent(tx, actor, {
        customerId: before.customer_id,
        kind: 'system',
        title: `Contact edited: ${nameOf(v)}`,
        body: changes.join('\n'),
      });
    }

    return { id, changes };
  });
}

/**
 * Contacts are ordinary records, not history: a tenant who moved out should
 * stop appearing next to the phone number staff dial. The timeline keeps the
 * fact that they were once there, which is the part that must not be lost.
 */
export async function removeContact(
  db: Db, actor: Actor, contactId: string,
): Promise<{ customerId: string }> {
  const id = assertUuid(contactId, 'contactId');

  const before = rows<{
    customer_id: string; first_name: string | null; last_name: string | null; role: string | null;
  }>(await db.execute(sql`
    SELECT customer_id, first_name, last_name, role FROM contact WHERE id = ${id}::uuid
  `))[0];
  if (!before) throw new WriteError('That contact could not be found.', 'contactId');

  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`DELETE FROM contact WHERE id = ${id}::uuid`);

    await recordEvent(tx, actor, {
      customerId: before.customer_id,
      kind: 'system',
      title: `Contact removed: ${nameOf({ firstName: before.first_name, lastName: before.last_name })}`,
      body: before.role ? `Was listed as ${before.role}.` : null,
    });

    return { customerId: before.customer_id };
  });
}
