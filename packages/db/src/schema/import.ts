import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, integer, jsonb, bigserial, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * One row per ETL run. Everything an import touches is tagged with the batch id,
 * so a bad run can be identified, reported on, and rolled back as a unit.
 */
export const importBatch = pgTable('import_batch', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  source: text('source').notNull(),            // 'evosus'
  mode: text('mode').notNull(),                // 'extract' | 'transform' | 'load' | 'full'
  entity: text('entity'),                      // null = multi-entity run
  status: text('status').notNull().default('running'), // running|succeeded|failed|rolled_back
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().default(sql`now()`),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  rowsRead: integer('rows_read').notNull().default(0),
  rowsWritten: integer('rows_written').notNull().default(0),
  rowsSkipped: integer('rows_skipped').notNull().default(0),
  issueCount: integer('issue_count').notNull().default(0),
  // High-water mark for incremental pulls: resume from here next run.
  watermark: text('watermark'),
  notes: text('notes'),
  error: text('error'),
}, (t) => [
  index('import_batch_source_started_idx').on(t.source, t.startedAt),
]);

/**
 * Data-quality findings. The migration WILL surface bad data across 20 years:
 * missing zips, phone numbers in the name field, customers with no address,
 * invoices pointing at deleted customers. We record rather than discard, so
 * the business can decide what to fix instead of finding out in June.
 */
export const importIssue = pgTable('import_issue', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  batchId: uuid('batch_id').notNull().references(() => importBatch.id),
  entity: text('entity').notNull(),            // 'customer' | 'invoice' | ...
  legacyId: text('legacy_id'),
  severity: text('severity').notNull(),        // 'info' | 'warn' | 'error'
  code: text('code').notNull(),                // 'MISSING_ADDRESS', 'ORPHAN_FK', ...
  message: text('message').notNull(),
  payload: jsonb('payload'),                   // the offending row, for triage
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  index('import_issue_batch_idx').on(t.batchId, t.severity),
  index('import_issue_code_idx').on(t.code),
]);

/**
 * Raw landing zone. Legacy rows arrive here VERBATIM as JSONB and are never
 * edited in place.
 *
 * JSONB rather than typed columns is deliberate: we do not yet have the Evosus
 * schema (that is the Sprint 0 spike), the shape has drifted over 20 years, and
 * a JSONB landing zone means the extractor never needs a migration to pull a
 * new table. Transforms read from here; re-running a transform is free because
 * the raw truth is still sitting in this table.
 */
export const legacyRow = pgTable('legacy_row', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  batchId: uuid('batch_id').notNull().references(() => importBatch.id),
  source: text('source').notNull(),
  entity: text('entity').notNull(),
  legacyId: text('legacy_id').notNull(),
  payload: jsonb('payload').notNull(),
  // md5 of the payload — lets incremental runs skip unchanged rows cheaply.
  rowHash: text('row_hash').notNull(),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => [
  uniqueIndex('legacy_row_batch_key_idx').on(t.batchId, t.source, t.entity, t.legacyId),
  index('legacy_row_lookup_idx').on(t.source, t.entity, t.legacyId),
  index('legacy_row_hash_idx').on(t.source, t.entity, t.rowHash),
]);
