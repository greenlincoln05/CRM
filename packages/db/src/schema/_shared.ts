import { sql } from 'drizzle-orm';
import { timestamp, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Every core record carries a pointer back to the row it came from in the
 * legacy system. This is what makes the migration re-runnable: we can always
 * re-import, diff, or trace a record back to its Evosus origin.
 *
 * Rule: never delete provenance, even after Evosus is decommissioned. Twenty
 * years of history is worth more than the two columns it costs.
 */
export const provenance = {
  legacySource: text('legacy_source'), // 'evosus' | 'manual' | 'import:csv'
  legacyId: text('legacy_id'),         // natural key in the source system
  importBatchId: uuid('import_batch_id'),
};

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
};
