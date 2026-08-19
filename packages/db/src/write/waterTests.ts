import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { WriteError, clean, oneOf, readingValue } from './input.js';
import {
  type Db, MANUAL_SOURCE, assertUuid, customerExists, recordEvent, rows,
} from './shared.js';

/**
 * Water tests.
 *
 * A primary reason customers walk in the door, and the one counter interaction
 * that produces numbers worth charting across a season. Two rows come out of
 * one form: the reading itself, for the trend, and a timeline event, so the
 * visit appears in the feed alongside everything else that happened that day.
 *
 * The readings are immutable once written (migration 0008). That makes the
 * range checks below matter more than they look: a pH of 78 typed for 7.8
 * cannot be quietly corrected later, so it is refused at the door.
 */

export const WATER_TEST_SOURCES = ['in_store', 'field', 'customer'] as const;

/**
 * Plausible-input bounds and the ideal band, per reading.
 *
 * `min`/`max` are what a test kit can physically report - anything outside is a
 * typo. `low`/`high` are the target range staff are reading against, and drive
 * the summary line rather than any refusal.
 */
export const READINGS = {
  freeChlorine:    { column: 'free_chlorine',    label: 'Free chlorine',  unit: 'ppm', min: 0, max: 50,    low: 1,    high: 3 },
  totalChlorine:   { column: 'total_chlorine',   label: 'Total chlorine', unit: 'ppm', min: 0, max: 50,    low: 1,    high: 3 },
  ph:              { column: 'ph',               label: 'pH',             unit: '',    min: 0, max: 14,    low: 7.2,  high: 7.8 },
  totalAlkalinity: { column: 'total_alkalinity', label: 'Alkalinity',     unit: 'ppm', min: 0, max: 500,   low: 80,   high: 120 },
  calciumHardness: { column: 'calcium_hardness', label: 'Hardness',       unit: 'ppm', min: 0, max: 1500,  low: 200,  high: 400 },
  cyanuricAcid:    { column: 'cyanuric_acid',    label: 'Stabilizer',     unit: 'ppm', min: 0, max: 300,   low: 30,   high: 50 },
  salt:            { column: 'salt',             label: 'Salt',           unit: 'ppm', min: 0, max: 10000, low: 2700, high: 3400 },
  phosphates:      { column: 'phosphates',       label: 'Phosphates',     unit: 'ppb', min: 0, max: 10000, low: 0,    high: 100 },
  temperatureF:    { column: 'temperature_f',    label: 'Temperature',    unit: '°F',  min: 20, max: 120,  low: 78,   high: 88 },
} as const;

export type ReadingKey = keyof typeof READINGS;

export type WaterTestInput = {
  customerId: string;
  propertyId?: string | null;
  source?: string;
  testedAt?: string | null;
  recommendation?: string | null;
  notes?: string | null;
} & Partial<Record<ReadingKey, string | number | null>>;

export type Flag = { key: ReadingKey; label: string; value: number; direction: 'low' | 'high' };

/**
 * Which readings are outside the target band.
 *
 * Advisory only. It tells the person at the counter what to talk about; it does
 * not decide anything, and it never overwrites what they actually recommended.
 */
export function flagReadings(values: Partial<Record<ReadingKey, string | null>>): Flag[] {
  const flags: Flag[] = [];
  for (const [key, spec] of Object.entries(READINGS) as [ReadingKey, typeof READINGS[ReadingKey]][]) {
    const raw = values[key];
    if (raw === null || raw === undefined) continue;

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n < spec.low) flags.push({ key, label: spec.label, value: n, direction: 'low' });
    else if (n > spec.high) flags.push({ key, label: spec.label, value: n, direction: 'high' });
  }
  return flags;
}

export function describeFlag(f: Flag): string {
  const spec = READINGS[f.key];
  const target = `${spec.low}-${spec.high}${spec.unit ? ` ${spec.unit}` : ''}`;
  return `${f.label} ${f.direction} at ${f.value}${spec.unit ? ` ${spec.unit}` : ''} (target ${target})`;
}

export async function recordWaterTest(
  db: Db, actor: Actor, input: WaterTestInput,
): Promise<{ id: string; flags: Flag[] }> {
  const customerId = assertUuid(input.customerId, 'customerId');
  const source = oneOf(input.source, WATER_TEST_SOURCES, 'source', 'in_store');

  const values: Partial<Record<ReadingKey, string | null>> = {};
  for (const [key, spec] of Object.entries(READINGS) as [ReadingKey, typeof READINGS[ReadingKey]][]) {
    // key, not label: WriteError.field names the input a message lands next to,
    // and the form fields are named after the keys.
    values[key] = readingValue(input[key], key, spec.label, spec.min, spec.max);
  }

  // A test with no readings is a blank form submitted by accident.
  if (Object.values(values).every((v) => v === null)) {
    throw new WriteError('Enter at least one reading.', 'ph');
  }

  let testedAt = new Date();
  if (clean(input.testedAt)) {
    const parsed = new Date(String(input.testedAt));
    if (Number.isNaN(parsed.getTime())) {
      throw new WriteError('That is not a valid date and time.', 'testedAt');
    }
    if (parsed.getTime() > Date.now() + 5 * 60_000) {
      throw new WriteError('A test cannot be recorded as happening in the future.', 'testedAt');
    }
    testedAt = parsed;
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

  const recommendation = clean(input.recommendation);
  const notes = clean(input.notes);
  const flags = flagReadings(values);

  return db.transaction(async (tx: Db) => {
    const created = rows<{ id: string }>(await tx.execute(sql`
      INSERT INTO water_test (
        customer_id, property_id, tested_at, tested_by_user_id, source,
        free_chlorine, total_chlorine, ph, total_alkalinity, calcium_hardness,
        cyanuric_acid, salt, phosphates, temperature_f,
        recommendation, notes, legacy_source
      ) VALUES (
        ${customerId}::uuid, ${propertyId}, ${testedAt}, ${actor.userId}::uuid, ${source},
        ${values.freeChlorine}, ${values.totalChlorine}, ${values.ph},
        ${values.totalAlkalinity}, ${values.calciumHardness}, ${values.cyanuricAcid},
        ${values.salt}, ${values.phosphates}, ${values.temperatureF},
        ${recommendation}, ${notes}, ${MANUAL_SOURCE}
      )
      RETURNING id
    `))[0]!;

    const readingLine = (Object.entries(READINGS) as [ReadingKey, typeof READINGS[ReadingKey]][])
      .filter(([key]) => values[key] !== null)
      .map(([key, spec]) => `${spec.label} ${Number(values[key])}${spec.unit ? ` ${spec.unit}` : ''}`)
      .join('  ·  ');

    const body = [
      readingLine,
      flags.length > 0 ? `Out of range: ${flags.map(describeFlag).join('; ')}` : null,
      recommendation ? `Recommended: ${recommendation}` : null,
      notes,
    ].filter(Boolean).join('\n');

    await recordEvent(tx, actor, {
      customerId,
      propertyId,
      kind: 'water_test',
      occurredAt: testedAt,
      title: flags.length === 0 ? 'Water test — balanced' : 'Water test',
      body,
      refType: 'water_test',
      refId: created.id,
      // The readings go in the payload as well as the body so a chart can read
      // them back without parsing English.
      payload: {
        waterTestId: created.id,
        source,
        readings: Object.fromEntries(
          Object.entries(values)
            .filter(([, v]) => v !== null)
            .map(([k, v]) => [k, Number(v)]),
        ),
        flags: flags.map((f) => ({ key: f.key, direction: f.direction, value: f.value })),
      },
    });

    return { id: created.id, flags };
  });
}
