import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, boolean, timestamp, integer, date, numeric, jsonb, index,
} from 'drizzle-orm/pg-core';
import { provenance, timestamps } from './_shared.js';
import { customer, property } from './customer.js';
import { appUser } from './timeline.js';

/**
 * A job: one visit to one property to do one thing.
 *
 * Deliberately minimal. Full dispatch - capacity caps, parts gating, route
 * optimization - is Sprint 4. This is the smallest model that lets a technician
 * open their phone and see what they are doing today, which is the thing the
 * mobile app exists for.
 */
export const workOrder = pgTable('work_order', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  /** Human-readable, what people say out loud. "Job 4417." */
  number: text('number'),

  customerId: uuid('customer_id').notNull().references(() => customer.id, { onDelete: 'cascade' }),
  propertyId: uuid('property_id').references(() => property.id, { onDelete: 'set null' }),

  type: text('type').notNull().default('service'),
  // service | opening | closing | delivery | install | water_test | inspection

  status: text('status').notNull().default('scheduled'),
  // scheduled | en_route | on_site | complete | incomplete | cancelled

  priority: text('priority').notNull().default('normal'), // low | normal | urgent

  scheduledDate: date('scheduled_date'),
  /** Free text rather than exact times: "morning", "after 2pm", "8-10am". */
  scheduledWindow: text('scheduled_window'),
  /** Drives capacity maths in Sprint 4; useful for ordering a day now. */
  estimatedMinutes: integer('estimated_minutes'),
  /** Position within the technician's day. */
  sequence: integer('sequence'),

  assignedUserId: uuid('assigned_user_id').references(() => appUser.id),

  summary: text('summary'),
  /** What the office wants the tech to know before arriving. */
  instructions: text('instructions'),

  enRouteAt: timestamp('en_route_at', { withTimezone: true }),
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  /** What the tech did. Written from the phone, often with no signal. */
  workPerformed: text('work_performed'),
  /** Why it could not be finished - the thing that generates the next job. */
  incompleteReason: text('incomplete_reason'),

  ...provenance,
  ...timestamps,
}, (t) => [
  // The query the mobile app makes constantly: my jobs, today, in order.
  index('work_order_assignee_date_idx').on(t.assignedUserId, t.scheduledDate, t.sequence),
  index('work_order_date_status_idx').on(t.scheduledDate, t.status),
  index('work_order_customer_idx').on(t.customerId),
  index('work_order_property_idx').on(t.propertyId),
]);

/**
 * Location breadcrumbs.
 *
 * A PWA cannot report position with the screen off, so this is not continuous
 * tracking - it is a point recorded whenever something meaningful happens:
 * marking en route, arriving, taking a photo, completing. That answers "was the
 * tech actually there" and "how long did it take", which is most of what live
 * tracking was wanted for. Continuous vehicle location stays with the fleet
 * system until there is a native shell. See docs/adr/0004-mobile-platform.md.
 */
export const workOrderPing = pgTable('work_order_ping', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workOrderId: uuid('work_order_id').notNull().references(() => workOrder.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => appUser.id),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`now()`),
  reason: text('reason').notNull(), // en_route | arrived | photo | complete | manual
  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),
  accuracyMeters: integer('accuracy_meters'),
  ...timestamps,
}, (t) => [
  index('work_order_ping_job_idx').on(t.workOrderId, t.occurredAt),
]);

/**
 * Per-job checklist. Seeded from the job type so a spring opening always covers
 * the same steps, and so a tech who is new in April does not have to remember
 * what a tech who has been here fifteen years does automatically.
 */
export const workOrderTask = pgTable('work_order_task', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workOrderId: uuid('work_order_id').notNull().references(() => workOrder.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull().default(0),
  label: text('label').notNull(),
  done: boolean('done').notNull().default(false),
  doneAt: timestamp('done_at', { withTimezone: true }),
  notes: text('notes'),
  ...timestamps,
}, (t) => [
  index('work_order_task_job_idx').on(t.workOrderId, t.sequence),
]);

/**
 * The offline queue's landing pad.
 *
 * Phones at lakeside properties have no signal, so the app writes actions to
 * local storage and replays them later. Every action carries a client-generated
 * id; this table records which ones have been applied, so a replay that happens
 * twice - which it will, because networks fail halfway - lands once.
 */
export const syncedAction = pgTable('synced_action', {
  /** Generated on the device, before the action ever reaches a network. */
  clientActionId: uuid('client_action_id').primaryKey(),
  userId: uuid('user_id').references(() => appUser.id),
  kind: text('kind').notNull(),
  payload: jsonb('payload'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().default(sql`now()`),
  /** When it happened on the device, which may be hours before it synced. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
}, (t) => [
  index('synced_action_user_idx').on(t.userId, t.appliedAt),
]);
