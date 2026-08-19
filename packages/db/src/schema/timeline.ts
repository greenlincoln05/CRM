import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, boolean, timestamp, integer, numeric, jsonb, bigserial, index,
} from 'drizzle-orm/pg-core';
import { provenance, timestamps } from './_shared.js';
import { customer, property } from './customer.js';

/** Employees. Auth lives with the identity provider; this is the local mirror. */
export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  externalId: text('external_id'),          // id from Clerk/WorkOS
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('staff'), // admin | manager | staff | tech
  active: boolean('active').notNull().default(true),
  ...timestamps,
}, (t) => [
  index('app_user_email_idx').on(t.email),
]);

/**
 * The one timeline. Every interaction with a customer lands here regardless of
 * where it happened: counter sale, service call, text through Podium, water
 * test, phone call, internal note.
 *
 * Append-only by convention and enforced by trigger (see migration 0001).
 * Corrections are new rows, not edits. This is what makes the feed trustworthy
 * enough to replace five places where notes currently live.
 */
export const timelineEvent = pgTable('timeline_event', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  customerId: uuid('customer_id').notNull().references(() => customer.id, { onDelete: 'cascade' }),
  /** Optional: which property this was about. Null = account-level. */
  propertyId: uuid('property_id').references(() => property.id, { onDelete: 'set null' }),

  /** When it actually happened, NOT when it was recorded. Legacy imports
   *  backdate this to the original 2006 invoice date. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

  kind: text('kind').notNull(),
  // note | call | sms | email | water_test | sale | service_call | delivery
  // | install | quote | payment | photo | system

  source: text('source').notNull().default('app'),
  // app | evosus | podium | gmail | quickbooks | system

  direction: text('direction'), // inbound | outbound | null (for non-comms)

  actorUserId: uuid('actor_user_id').references(() => appUser.id),
  /** Free-text actor for legacy rows where the employee no longer exists. */
  actorLabel: text('actor_label'),

  title: text('title'),
  body: text('body'),

  /** Points at the domain object this event describes, when there is one. */
  refType: text('ref_type'),   // invoice | work_order | quote | payment | water_test
  refId: text('ref_id'),

  /** Kind-specific detail: water chemistry readings, SMS thread id, totals. */
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

  /** Pinned events float to the top of the feed. "Owes us a liner." */
  pinned: boolean('pinned').notNull().default(false),
  /** Hidden from the default feed without being deleted. */
  redactedAt: timestamp('redacted_at', { withTimezone: true }),

  ...provenance,
  ...timestamps,
}, (t) => [
  // The feed query: one customer, newest first.
  index('timeline_customer_occurred_idx').on(t.customerId, t.occurredAt.desc()),
  index('timeline_property_occurred_idx').on(t.propertyId, t.occurredAt.desc()),
  index('timeline_kind_idx').on(t.kind, t.occurredAt.desc()),
  index('timeline_ref_idx').on(t.refType, t.refId),
]);

/**
 * Photos and files. The doc calls photo handling "antiquated" and says techs
 * skip it because it is cumbersome, so the model is built for zero-friction
 * capture: upload first, attach context automatically, never ask for a filename.
 */
export const attachment = pgTable('attachment', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  customerId: uuid('customer_id').references(() => customer.id, { onDelete: 'cascade' }),
  propertyId: uuid('property_id').references(() => property.id, { onDelete: 'set null' }),
  timelineEventId: uuid('timeline_event_id').references(() => timelineEvent.id, { onDelete: 'set null' }),

  kind: text('kind').notNull().default('photo'), // photo | document | signature | video

  storageKey: text('storage_key').notNull(),     // object key in S3/R2
  mimeType: text('mime_type'),
  byteSize: integer('byte_size'),
  width: integer('width'),
  height: integer('height'),
  /** Perceptual/content hash - dedupes the same photo uploaded twice. */
  contentHash: text('content_hash'),

  /** Auto-derived context so nobody has to type a label. */
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  capturedLat: text('captured_lat'),
  capturedLng: text('captured_lng'),
  capturedByUserId: uuid('captured_by_user_id').references(() => appUser.id),

  caption: text('caption'),
  /** Free tags: 'equipment', 'before', 'after', 'damage', 'access'. */
  tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),

  ...provenance,
  ...timestamps,
}, (t) => [
  index('attachment_property_idx').on(t.propertyId, t.capturedAt.desc()),
  index('attachment_customer_idx').on(t.customerId, t.capturedAt.desc()),
  index('attachment_event_idx').on(t.timelineEventId),
  index('attachment_hash_idx').on(t.contentHash),
]);

/**
 * Water test results. Called out separately from generic timeline payloads
 * because chemistry trends over a season are worth querying and charting,
 * and because water testing is a primary reason customers walk in the door.
 */
export const waterTest = pgTable('water_test', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid('customer_id').notNull().references(() => customer.id, { onDelete: 'cascade' }),
  propertyId: uuid('property_id').references(() => property.id, { onDelete: 'set null' }),
  testedAt: timestamp('tested_at', { withTimezone: true }).notNull().default(sql`now()`),
  testedByUserId: uuid('tested_by_user_id').references(() => appUser.id),

  source: text('source').notNull().default('in_store'), // in_store | field | customer

  freeChlorine: numericCol('free_chlorine'),
  totalChlorine: numericCol('total_chlorine'),
  ph: numericCol('ph'),
  totalAlkalinity: numericCol('total_alkalinity'),
  calciumHardness: numericCol('calcium_hardness'),
  cyanuricAcid: numericCol('cyanuric_acid'),
  salt: numericCol('salt'),
  phosphates: numericCol('phosphates'),
  temperatureF: numericCol('temperature_f'),

  /** What we told them to do, kept so we can see if it worked next visit. */
  recommendation: text('recommendation'),
  notes: text('notes'),

  ...provenance,
  ...timestamps,
}, (t) => [
  index('water_test_customer_idx').on(t.customerId, t.testedAt.desc()),
  index('water_test_property_idx').on(t.propertyId, t.testedAt.desc()),
]);

/**
 * Chemistry readings share a shape: a decimal that may be absent because that
 * strip pad was not run. Salt reaches the low thousands, so 8 digits with 2
 * decimals covers every reading we take.
 */
function numericCol(name: string) {
  return numeric(name, { precision: 8, scale: 2 });
}

/**
 * Who looked at a gate code, and when.
 *
 * Not to catch anyone - to answer a customer asking "who had our code" with
 * something better than a shrug. Append-only, enforced by trigger.
 */
export const sensitiveAccessLog = pgTable('sensitive_access_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`now()`),
  userId: uuid('user_id').references(() => appUser.id),
  /** Free-text actor, for before real auth exists. */
  actorLabel: text('actor_label'),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  field: text('field').notNull(),
  reason: text('reason'),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => [
  index('sensitive_access_entity_idx').on(t.entity, t.entityId, t.occurredAt.desc()),
  index('sensitive_access_user_idx').on(t.userId, t.occurredAt.desc()),
]);
