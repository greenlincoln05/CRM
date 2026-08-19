import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { encryptField } from '../crypto.js';
import { WriteError, clean, oneOf } from './input.js';
import {
  type AddressInput, type Db, MANUAL_SOURCE, assertUuid, customerExists,
  describeChanges, formatAddress, normalizeAddress, addressIsEmpty,
  recordEvent, rows, upsertAddress,
} from './shared.js';

/**
 * Service properties, and the arrival knowledge attached to them.
 *
 * Two things here are load-bearing beyond ordinary CRUD:
 *
 *   1. The gate code is encrypted on the way in and never comes back out of
 *      this module. It is not in the return value, not in the timeline event,
 *      and not in the change summary - because a change summary is exactly the
 *      sort of place a secret ends up in plaintext by accident. ADR 0003.
 *
 *   2. Properties are archived, never deleted. A property is what a decade of
 *      timeline events points at.
 */

export const PROPERTY_TYPES = ['pool', 'spa', 'stove', 'multiple'] as const;

export type PropertyInput = {
  label?: string | null;
  propertyType?: string | null;
  isPrimary?: boolean;
  accessNotes?: string | null;
  petNotes?: string | null;
  waterShutoffNotes?: string | null;
  electricalNotes?: string | null;
  parkingNotes?: string | null;
  address?: AddressInput;
  /**
   * SENSITIVE. Undefined means "leave whatever is on file"; an empty string
   * means "clear it". Never echoed back by anything in this module.
   */
  gateCode?: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  label: 'Label',
  propertyType: 'Type',
  isPrimary: 'Primary property',
  accessNotes: 'Access notes',
  petNotes: 'Pet notes',
  waterShutoffNotes: 'Water shutoff',
  electricalNotes: 'Electrical',
  parkingNotes: 'Parking',
  address: 'Address',
};

function validate(input: PropertyInput) {
  const propertyType = input.propertyType == null || clean(input.propertyType) === null
    ? null
    : oneOf(input.propertyType, PROPERTY_TYPES, 'propertyType');

  return {
    label: clean(input.label),
    propertyType,
    isPrimary: Boolean(input.isPrimary),
    accessNotes: clean(input.accessNotes),
    petNotes: clean(input.petNotes),
    waterShutoffNotes: clean(input.waterShutoffNotes),
    electricalNotes: clean(input.electricalNotes),
    parkingNotes: clean(input.parkingNotes),
  };
}

/** Same per-statement ordering requirement as the primary contact. */
async function clearOtherPrimaries(tx: Db, customerId: string, exceptId?: string) {
  await tx.execute(sql`
    UPDATE property SET is_primary = false
     WHERE customer_id = ${customerId}::uuid
       AND is_primary
       ${exceptId ? sql`AND id <> ${exceptId}::uuid` : sql``}
  `);
}

/**
 * Writing a gate code is a sensitive access in its own right.
 *
 * The reveal log answers "who saw our code". It has to answer "who changed it"
 * too, or the first question a customer asks after a break-in still ends in a
 * shrug. The value never appears in the reason.
 */
async function logGateCodeWrite(
  tx: Db, actor: Actor, propertyId: string, action: 'set' | 'changed' | 'cleared',
) {
  await tx.execute(sql`
    INSERT INTO sensitive_access_log (user_id, actor_label, entity, entity_id, field, reason)
    VALUES (${actor.userId}::uuid, ${actor.label}, 'property', ${propertyId}::uuid,
            'gate_code', ${`Gate code ${action}`})
  `);
}

export async function addProperty(
  db: Db, actor: Actor, customerId: string, input: PropertyInput,
): Promise<{ id: string }> {
  const cid = assertUuid(customerId, 'customerId');
  const v = validate(input);

  if (!await customerExists(db, cid)) {
    throw new WriteError('That customer could not be found.', 'customerId');
  }

  const gateCode = clean(input.gateCode);

  return db.transaction(async (tx: Db) => {
    if (v.isPrimary) await clearOtherPrimaries(tx, cid);

    const addressId = input.address ? await upsertAddress(tx, null, input.address) : null;

    const created = rows<{ id: string }>(await tx.execute(sql`
      INSERT INTO property (
        customer_id, address_id, label, property_type, is_primary,
        access_notes, pet_notes, water_shutoff_notes, electrical_notes,
        parking_notes, gate_code_enc, legacy_source
      ) VALUES (
        ${cid}::uuid, ${addressId}, ${v.label}, ${v.propertyType}, ${v.isPrimary},
        ${v.accessNotes}, ${v.petNotes}, ${v.waterShutoffNotes}, ${v.electricalNotes},
        ${v.parkingNotes}, ${encryptField(gateCode)}, ${MANUAL_SOURCE}
      )
      RETURNING id
    `))[0]!;

    if (gateCode) await logGateCodeWrite(tx, actor, created.id, 'set');

    const where = input.address ? formatAddress(normalizeAddress(input.address)) : null;
    await recordEvent(tx, actor, {
      customerId: cid,
      propertyId: created.id,
      kind: 'system',
      title: `Property added: ${v.label ?? 'unnamed property'}`,
      body: [where, v.propertyType].filter(Boolean).join('  ·  ') || null,
    });

    return created;
  });
}

export async function updateProperty(
  db: Db, actor: Actor, propertyId: string, input: PropertyInput,
): Promise<{ id: string; changes: string[] }> {
  const id = assertUuid(propertyId, 'propertyId');
  const v = validate(input);

  const before = rows<{
    id: string; customer_id: string; address_id: string | null;
    label: string | null; property_type: string | null; is_primary: boolean;
    access_notes: string | null; pet_notes: string | null;
    water_shutoff_notes: string | null; electrical_notes: string | null;
    parking_notes: string | null; gate_code_enc: string | null;
    line1: string | null; city: string | null; state: string | null; postal_code: string | null;
  }>(await db.execute(sql`
    SELECT p.*, a.line1, a.city, a.state, a.postal_code
      FROM property p LEFT JOIN address a ON a.id = p.address_id
     WHERE p.id = ${id}::uuid
  `))[0];
  if (!before) throw new WriteError('That property could not be found.', 'propertyId');

  const beforeAddress = formatAddress({
    line1: before.line1, city: before.city, state: before.state, postalCode: before.postal_code,
  });

  // undefined means the form did not carry the field at all - leave it alone.
  const gateCodeTouched = input.gateCode !== undefined;
  const gateCode = gateCodeTouched ? clean(input.gateCode) : null;

  return db.transaction(async (tx: Db) => {
    if (v.isPrimary && !before.is_primary) {
      await clearOtherPrimaries(tx, before.customer_id, id);
    }

    const addressId = input.address
      ? await upsertAddress(tx, before.address_id, input.address)
      : before.address_id;

    await tx.execute(sql`
      UPDATE property SET
        address_id = ${addressId}, label = ${v.label}, property_type = ${v.propertyType},
        is_primary = ${v.isPrimary}, access_notes = ${v.accessNotes},
        pet_notes = ${v.petNotes}, water_shutoff_notes = ${v.waterShutoffNotes},
        electrical_notes = ${v.electricalNotes}, parking_notes = ${v.parkingNotes}
        ${gateCodeTouched ? sql`, gate_code_enc = ${encryptField(gateCode)}` : sql``}
      WHERE id = ${id}::uuid
    `);

    const nextAddress = input.address ? normalizeAddress(input.address) : null;
    const changes = describeChanges(
      {
        label: before.label, propertyType: before.property_type, isPrimary: before.is_primary,
        accessNotes: before.access_notes, petNotes: before.pet_notes,
        waterShutoffNotes: before.water_shutoff_notes,
        electricalNotes: before.electrical_notes, parkingNotes: before.parking_notes,
        address: beforeAddress,
      },
      {
        ...v,
        address: nextAddress && !addressIsEmpty(nextAddress)
          ? formatAddress(nextAddress)
          : beforeAddress,
      },
      FIELD_LABELS,
    );

    // The code itself is never in `changes` - only the fact that it moved.
    if (gateCodeTouched) {
      const had = before.gate_code_enc !== null;
      const action = gateCode ? (had ? 'changed' : 'set') : 'cleared';
      if (gateCode || had) {
        await logGateCodeWrite(tx, actor, id, action);
        changes.push(`Gate code ${action}`);
      }
    }

    if (changes.length > 0) {
      await recordEvent(tx, actor, {
        customerId: before.customer_id,
        propertyId: id,
        kind: 'system',
        title: `Property edited: ${v.label ?? before.label ?? 'unnamed property'}`,
        body: changes.join('\n'),
      });
    }

    return { id, changes };
  });
}

/**
 * Archive rather than delete. A closed pool is still the thing that ten years
 * of service calls point at, and it comes back when the house is sold.
 */
export async function setPropertyActive(
  db: Db, actor: Actor, propertyId: string, active: boolean,
): Promise<{ id: string }> {
  const id = assertUuid(propertyId, 'propertyId');

  const before = rows<{ customer_id: string; label: string | null; active: boolean }>(
    await db.execute(sql`
      SELECT customer_id, label, active FROM property WHERE id = ${id}::uuid
    `),
  )[0];
  if (!before) throw new WriteError('That property could not be found.', 'propertyId');
  if (before.active === active) return { id };

  return db.transaction(async (tx: Db) => {
    // An archived property must not stay the primary one.
    await tx.execute(sql`
      UPDATE property SET active = ${active}
        ${active ? sql`` : sql`, is_primary = false`}
       WHERE id = ${id}::uuid
    `);

    await recordEvent(tx, actor, {
      customerId: before.customer_id,
      propertyId: id,
      kind: 'system',
      title: `Property ${active ? 'reactivated' : 'archived'}: ${before.label ?? 'unnamed property'}`,
    });

    return { id };
  });
}
