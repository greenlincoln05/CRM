import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import { WriteError, clean, dateOnlyAtNoon, oneOf, required } from './input.js';
import {
  type Db, MANUAL_SOURCE, assertUuid, customerExists, describeChanges,
  recordEvent, rows,
} from './shared.js';

/**
 * Work orders: creating a job, moving it, calling it off.
 *
 * Until now nothing in the app created one. The only producer was the synthetic
 * `npm run etl -- seed:jobs` fixture, which meant the technician PWA consumed
 * rows the office had no way of making. This is the other half of that.
 *
 * Four things here are business rules rather than plumbing, and they live at
 * this layer so that the server action and anything Sprint 4 builds get them
 * for free. (The seed fixture is not among them — it hand-rolls its own INSERT
 * and borrows only `tasksForType`, so it skips the ownership check, the
 * validation and the timeline event. That is fine for synthetic data and would
 * not be fine for anything else.):
 *
 *   1. The number comes from `work_order_number_seq` (migration 0010), never
 *      from counting rows. Two people creating a job from two terminals both
 *      read the same MAX() and both write the same number; a sequence is the
 *      only allocator that is correct under concurrency. The unique index is
 *      the guarantee, this is the allocator.
 *
 *   2. A job's property must belong to the job's customer. That is not a typo
 *      class of mistake - it is a truck rolling to somebody else's house, and
 *      a customer whose timeline shows work done at an address they have never
 *      heard of.
 *
 *   3. A job with no checklist renders an empty screen on the technician's
 *      phone, which is how a step gets skipped. Every job type carries the
 *      checklist that job type always covers, seeded at creation, exactly as
 *      the schema comment on work_order_task says it should be.
 *
 *   4. Dispatching is an office job. Booking, moving and calling off work is
 *      refused to `tech`, because until this landed the office pages were
 *      gated on having a session and nothing else - so a technician could open
 *      /schedule, assign any job at any property to themselves, and the
 *      gate-code check in /api/gate-code would then correctly hand over the
 *      code. ADR 0009 names that gap as the reason its own scoping is "an
 *      accident control, not a boundary"; this is the other half.
 */

export const WORK_ORDER_TYPES = [
  'service', 'opening', 'closing', 'delivery', 'install', 'water_test', 'inspection',
] as const;

export const WORK_ORDER_STATUSES = [
  'scheduled', 'en_route', 'on_site', 'complete', 'incomplete', 'cancelled',
] as const;

export const WORK_ORDER_PRIORITIES = ['low', 'normal', 'urgent'] as const;

export type WorkOrderType = typeof WORK_ORDER_TYPES[number];
export type WorkOrderStatus = typeof WORK_ORDER_STATUSES[number];
export type WorkOrderPriority = typeof WORK_ORDER_PRIORITIES[number];

/**
 * Who may put work on the board.
 *
 * An allow-list rather than `role !== 'tech'`, on the same reasoning as
 * REDACTION_ROLES in timeline.ts: a role added to app_user next year - a
 * 'contractor', a 'vendor', a read-only 'viewer' - is refused until somebody
 * decides otherwise, instead of being silently handed the schedule by a
 * predicate written before it existed.
 *
 * 'staff' IS in here, and that is the whole point rather than an oversight.
 * Both auth.ts and user-cli.ts default a new account to 'staff', so every
 * person behind the counter is staff; the `admin || manager` predicate used by
 * the technician routes would 403 the entire office. ADR 0009 spells this out
 * for the gate-code reveal and the same trap is here. The question is "is this
 * person in the field", not "is this person senior". apps/web/scripts/
 * smoke-tech-api.ts already asserts a new account gets the office role, and the
 * work-order checks in smoke-writes.ts assert staff can dispatch - between them
 * a future "tightening" to admin || manager fails loudly rather than in April.
 *
 * The string is 'tech'. Not 'technician' - app_user.role has never held that
 * value, and a predicate testing for it would fail open, which is the one
 * direction an authorization typo must not fail.
 */
const DISPATCH_ROLES = new Set(['admin', 'manager', 'staff']);

/** Whether this actor may book, move or call off work. */
export function canDispatch(actor: { role: string }): boolean {
  return DISPATCH_ROLES.has(actor.role);
}

/**
 * The dispatch gate, run before anything is looked up.
 *
 * Deliberately the FIRST thing every write below does - ahead of
 * loadWorkOrder, ahead of customerExists - so that a refusal says only "you may
 * not do this" and never doubles as confirmation that a given job id or
 * customer id is real. Same reasoning as the pre-lookup placement of the
 * technician check in apps/web/app/api/gate-code/route.ts.
 *
 * The message does not mention roles, does not name who does have the power,
 * and does not suggest self-assignment as a route around it, for the same
 * reason the 403 in that route stops short of "or ask to be assigned the job":
 * an error is not the place to publish the bypass.
 */
function assertMayDispatch(actor: Actor, assignedUserId?: unknown, field = 'workOrderId'): void {
  if (!canDispatch(actor)) {
    throw new WriteError('You do not have permission to schedule work.', field);
  }

  // Belt and braces, and it stays even though the allow-list above already
  // makes it unreachable. Office roles MAY assign a job to themselves - in a
  // ten-person shop the manager sometimes drives the delivery, which is why
  // getTechnicians() returns every active user rather than filtering by role -
  // so the rule that actually matters is narrower than "nobody self-assigns".
  // Written out explicitly, a later edit to DISPATCH_ROLES cannot quietly
  // reopen the exact hole ADR 0009 describes: a technician handing themselves
  // a job and, with it, the gate code for that house.
  if (actor.role === 'tech' && assignedUserId != null && assignedUserId === actor.userId) {
    throw new WriteError('You do not have permission to schedule work.', 'assignedUserId');
  }
}

/**
 * What each kind of visit always covers.
 *
 * These are the steps a fifteen-year technician does without thinking and a
 * new one in April has no way of knowing. Seeded per job so the list is
 * per-job state - ticking a box on one opening must not tick it on every other
 * opening - and editable afterwards, because a real visit always has one more
 * thing.
 *
 * A job that genuinely needs a different list (a pellet stove cleaning filed as
 * a service call) passes `tasks` and overrides this. That is the exception; the
 * template is the default so that nobody has to remember to supply one.
 */
export const TASK_TEMPLATES: Record<WorkOrderType, readonly string[]> = {
  opening: [
    'Remove and fold winter cover',
    'Reinstall skimmer baskets',
    'Start pump, check for leaks',
    'Balance water',
    'Walk the equipment with the customer',
  ],
  closing: [
    'Lower the water level',
    'Blow out and plug the lines',
    'Add winterizing chemicals',
    'Fit and secure the winter cover',
  ],
  service: [
    'Test and balance water',
    'Check equipment for leaks and noise',
    'Backwash or clean the filter',
    'Record readings and anything needing follow-up',
  ],
  delivery: [
    'Check the model and quantity against the order',
    'Place, level and photograph',
    'Haul away what is being replaced',
  ],
  install: [
    'Confirm site preparation and clearances',
    'Install and commission',
    'Run a full cycle',
    'Train the customer on operation',
    'Leave manuals and warranty paperwork',
  ],
  water_test: [
    'Collect the sample',
    'Run the panel',
    'Record readings and the recommendation',
  ],
  inspection: [
    'Photograph the equipment and the site',
    'Record model and serial numbers',
  ],
};

/** The checklist a job of this type starts with. */
export function tasksForType(type: string): readonly string[] {
  return TASK_TEMPLATES[type as WorkOrderType] ?? [];
}

export type WorkOrderInput = {
  customerId: string;
  propertyId?: string | null;
  type?: string | null;
  status?: string | null;
  priority?: string | null;
  scheduledDate?: string | null;
  scheduledWindow?: string | null;
  estimatedMinutes?: number | string | null;
  sequence?: number | string | null;
  assignedUserId?: string | null;
  summary?: string | null;
  instructions?: string | null;
  /** Overrides the type's template. Omit to get the template. */
  tasks?: readonly string[] | null;
};

export type RescheduleInput = {
  workOrderId: string;
  scheduledDate?: string | null;
  scheduledWindow?: string | null;
  assignedUserId?: string | null;
  sequence?: number | string | null;
};

export type CancelInput = {
  workOrderId: string;
  reason: string;
};

const SCHEDULE_LABELS: Record<string, string> = {
  scheduledDate: 'Date',
  scheduledWindow: 'Arrival window',
  assignee: 'Assigned to',
  sequence: 'Stop on the day',
};

/** A whole number a person typed into a small box, or nothing. */
function intOrNull(
  v: unknown, field: string, label: string, min: number, max: number,
): number | null {
  const raw = clean(v);
  if (raw === null) return null;

  const n = Number(raw);
  if (!Number.isInteger(n)) throw new WriteError(`${label} must be a whole number.`, field);
  if (n < min || n > max) {
    throw new WriteError(`${label} of ${n} is outside the usable range (${min}-${max}).`, field);
  }
  return n;
}

/**
 * A scheduled date as the `date` column wants it.
 *
 * dateOnlyAtNoon does the validating - including the local-noon rule that stops
 * a date rendering a day early in Eastern - and the canonical YYYY-MM-DD text
 * goes to the column, because a date column has no time to be wrong about.
 */
function scheduledDate(v: unknown, field = 'scheduledDate'): string | null {
  const d = dateOnlyAtNoon(v, field);
  if (!d) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function assigneeName(db: Db, userId: string): Promise<string> {
  const found = rows<{ display_name: string }>(await db.execute(sql`
    SELECT display_name FROM app_user WHERE id = ${userId}::uuid AND active
  `))[0];
  if (!found) {
    throw new WriteError('That technician could not be found.', 'assignedUserId');
  }
  return found.display_name;
}

/**
 * The job's property has to be the job's customer's property.
 *
 * Same check as recordWaterTest, and for a stronger reason: a water test filed
 * against the wrong site is a bad row, a job dispatched to the wrong site is a
 * technician at a stranger's gate.
 */
async function assertPropertyBelongs(
  db: Db, customerId: string, propertyId: string,
): Promise<void> {
  const owned = rows(await db.execute(sql`
    SELECT 1 FROM property
     WHERE id = ${propertyId}::uuid AND customer_id = ${customerId}::uuid
  `));
  if (owned.length === 0) {
    throw new WriteError('That property does not belong to this customer.', 'propertyId');
  }
}

function checklist(input: WorkOrderInput, type: WorkOrderType): string[] {
  const source = input.tasks ?? tasksForType(type);
  const labels: string[] = [];
  for (const raw of source) {
    const label = clean(raw);
    if (label) labels.push(label);
  }
  return labels;
}

async function insertTasks(tx: Db, workOrderId: string, labels: string[]): Promise<void> {
  let i = 0;
  for (const label of labels) {
    await tx.execute(sql`
      INSERT INTO work_order_task (work_order_id, sequence, label)
      VALUES (${workOrderId}::uuid, ${i++}, ${label})
    `);
  }
}

/** The one-line "when and who" a person reads off the feed. */
function scheduleLine(v: {
  scheduledDate: string | null;
  scheduledWindow: string | null;
  assignee: string | null;
}): string | null {
  return [
    v.scheduledDate ?? 'unscheduled',
    v.scheduledWindow,
    v.assignee ? `assigned to ${v.assignee}` : 'unassigned',
  ].filter(Boolean).join('  ·  ') || null;
}

/**
 * Book a job.
 *
 * The number is allocated by the database inside the same statement that
 * inserts the row - `'W-' || nextval(...)` - rather than read first and written
 * second, so there is no window between the two for a second terminal to fall
 * into. The sequence is not the column's DEFAULT on purpose: legacy jobs arrive
 * from Evosus already numbered and must keep the number on the customer's
 * paperwork. See migration 0010.
 *
 * Expect gaps. `nextval` is deliberately outside transaction control, so a job
 * whose checklist or timeline write fails rolls the row back but keeps the
 * number spent. That is the right trade: a gap prompts "where did W-1042 go",
 * which has a dull answer, while reuse would put two different visits on one
 * number, which does not.
 */
export async function createWorkOrder(
  db: Db, actor: Actor, input: WorkOrderInput,
): Promise<{ id: string; number: string; tasks: number }> {
  assertMayDispatch(actor, clean(input.assignedUserId), 'customerId');

  const customerId = assertUuid(input.customerId, 'customerId');

  const type = oneOf(input.type, WORK_ORDER_TYPES, 'type', 'service');
  const status = oneOf(input.status, WORK_ORDER_STATUSES, 'status', 'scheduled');
  const priority = oneOf(input.priority, WORK_ORDER_PRIORITIES, 'priority', 'normal');

  const date = scheduledDate(input.scheduledDate);
  const window = clean(input.scheduledWindow);
  const estimatedMinutes = intOrNull(input.estimatedMinutes, 'estimatedMinutes', 'Estimated time', 1, 1440);
  const sequence = intOrNull(input.sequence, 'sequence', 'Stop on the day', 0, 999);
  const summary = clean(input.summary);
  const instructions = clean(input.instructions);

  if (!await customerExists(db, customerId)) {
    throw new WriteError('That customer could not be found.', 'customerId');
  }

  let propertyId: string | null = null;
  if (clean(input.propertyId)) {
    propertyId = assertUuid(input.propertyId, 'propertyId');
    await assertPropertyBelongs(db, customerId, propertyId);
  }

  let assignedUserId: string | null = null;
  let assignee: string | null = null;
  if (clean(input.assignedUserId)) {
    assignedUserId = assertUuid(input.assignedUserId, 'assignedUserId');
    assignee = await assigneeName(db, assignedUserId);
  }

  const labels = checklist(input, type);

  return db.transaction(async (tx: Db) => {
    const created = rows<{ id: string; number: string }>(await tx.execute(sql`
      INSERT INTO work_order (
        number, customer_id, property_id, type, status, priority,
        scheduled_date, scheduled_window, estimated_minutes, sequence,
        assigned_user_id, summary, instructions, legacy_source
      ) VALUES (
        'W-' || nextval('work_order_number_seq'),
        ${customerId}::uuid, ${propertyId}, ${type}, ${status}, ${priority},
        ${date}::date, ${window}, ${estimatedMinutes}, ${sequence},
        ${assignedUserId}, ${summary}, ${instructions}, ${MANUAL_SOURCE}
      )
      RETURNING id, number
    `))[0]!;

    await insertTasks(tx, created.id, labels);

    await recordEvent(tx, actor, {
      customerId,
      propertyId,
      kind: 'system',
      title: `Job ${created.number} scheduled: ${summary ?? type.replace('_', ' ')}`,
      body: [
        scheduleLine({ scheduledDate: date, scheduledWindow: window, assignee }),
        priority !== 'normal' ? `Priority: ${priority}` : null,
        instructions,
      ].filter(Boolean).join('\n') || null,
      refType: 'work_order',
      refId: created.id,
      payload: {
        workOrderId: created.id,
        number: created.number,
        type,
        status,
        priority,
        scheduledDate: date,
        scheduledWindow: window,
        assignedUserId,
        tasks: labels.length,
      },
    });

    return { id: created.id, number: created.number, tasks: labels.length };
  });
}

type WorkOrderRow = {
  id: string;
  number: string | null;
  customer_id: string;
  property_id: string | null;
  status: string;
  summary: string | null;
  scheduled_date: string | null;
  scheduled_window: string | null;
  sequence: number | null;
  assigned_user_id: string | null;
  assignee_name: string | null;
};

async function loadWorkOrder(db: Db, workOrderId: string): Promise<WorkOrderRow> {
  const id = assertUuid(workOrderId, 'workOrderId');
  const found = rows<WorkOrderRow>(await db.execute(sql`
    -- ::text rather than the raw date: the two drivers hand a date column back
    -- in different shapes, and a Date object compared against a typed
    -- "2026-05-06" reads as a change on every save.
    SELECT w.id, w.number, w.customer_id, w.property_id, w.status, w.summary,
           w.scheduled_date::text AS scheduled_date,
           w.scheduled_window, w.sequence, w.assigned_user_id,
           u.display_name AS assignee_name
      FROM work_order w
      LEFT JOIN app_user u ON u.id = w.assigned_user_id
     WHERE w.id = ${id}::uuid
  `))[0];
  if (!found) throw new WriteError('That job could not be found.', 'workOrderId');
  return found;
}

/** What a job says about itself in a message. "Job W-1004" beats a uuid. */
const jobLabel = (w: WorkOrderRow) => (w.number ? `Job ${w.number}` : 'That job');

/**
 * Move a job: a different day, a different window, a different technician, a
 * different place in the day.
 *
 * A finished or called-off job is not rescheduled, it is re-created. Letting a
 * completed visit be dragged to next Tuesday silently rewrites what happened,
 * and the completion timestamps underneath it would still say otherwise.
 */
export async function rescheduleWorkOrder(
  db: Db, actor: Actor, input: RescheduleInput,
): Promise<{ id: string; changes: string[] }> {
  assertMayDispatch(actor, clean(input.assignedUserId));

  const before = await loadWorkOrder(db, input.workOrderId);

  if (before.status === 'complete' || before.status === 'cancelled') {
    throw new WriteError(
      `${jobLabel(before)} is already ${before.status === 'complete' ? 'complete' : 'cancelled'} and cannot be rescheduled.`,
      'workOrderId',
    );
  }

  const date = scheduledDate(input.scheduledDate);
  const window = clean(input.scheduledWindow);
  const sequence = intOrNull(input.sequence, 'sequence', 'Stop on the day', 0, 999);

  let assignedUserId: string | null = null;
  let assignee: string | null = null;
  if (clean(input.assignedUserId)) {
    assignedUserId = assertUuid(input.assignedUserId, 'assignedUserId');
    assignee = await assigneeName(db, assignedUserId);
  }

  const changes = describeChanges(
    {
      scheduledDate: before.scheduled_date,
      scheduledWindow: before.scheduled_window,
      assignee: before.assignee_name,
      sequence: before.sequence,
    },
    { scheduledDate: date, scheduledWindow: window, assignee, sequence },
    SCHEDULE_LABELS,
  );

  // Opening the dispatch form to read it is not a reschedule.
  if (changes.length === 0) return { id: before.id, changes };

  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`
      UPDATE work_order
         SET scheduled_date = ${date}::date,
             scheduled_window = ${window},
             sequence = ${sequence},
             assigned_user_id = ${assignedUserId}
       WHERE id = ${before.id}::uuid
    `);

    await recordEvent(tx, actor, {
      customerId: before.customer_id,
      propertyId: before.property_id,
      kind: 'system',
      title: `${jobLabel(before)} rescheduled${before.summary ? `: ${before.summary}` : ''}`,
      body: [
        changes.join('\n'),
        scheduleLine({ scheduledDate: date, scheduledWindow: window, assignee }),
      ].filter(Boolean).join('\n\n'),
      refType: 'work_order',
      refId: before.id,
      payload: {
        workOrderId: before.id,
        number: before.number,
        scheduledDate: date,
        scheduledWindow: window,
        assignedUserId,
        sequence,
        changes,
      },
    });

    return { id: before.id, changes };
  });
}

/**
 * Call a job off, with a reason.
 *
 * The reason is required and lands on the timeline rather than in a column,
 * because the question it answers - "why did nobody come on Tuesday" - is asked
 * of the customer's history, not of the job. A completed visit cannot be
 * cancelled; that job happened, and the correction is a new entry.
 */
export async function cancelWorkOrder(
  db: Db, actor: Actor, input: CancelInput,
): Promise<{ id: string }> {
  assertMayDispatch(actor);

  const before = await loadWorkOrder(db, input.workOrderId);
  const reason = required(input.reason, 'reason', 'A reason for cancelling');

  if (before.status === 'complete') {
    throw new WriteError(
      `${jobLabel(before)} is already complete and cannot be cancelled.`,
      'workOrderId',
    );
  }
  if (before.status === 'cancelled') {
    throw new WriteError(`${jobLabel(before)} is already cancelled.`, 'workOrderId');
  }

  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`
      UPDATE work_order SET status = 'cancelled' WHERE id = ${before.id}::uuid
    `);

    await recordEvent(tx, actor, {
      customerId: before.customer_id,
      propertyId: before.property_id,
      kind: 'system',
      title: `${jobLabel(before)} cancelled${before.summary ? `: ${before.summary}` : ''}`,
      body: [
        `Status changed from ${before.status} to cancelled`,
        `Reason: ${reason}`,
      ].join('\n'),
      refType: 'work_order',
      refId: before.id,
      payload: {
        workOrderId: before.id,
        number: before.number,
        previousStatus: before.status,
        reason,
      },
    });

    return { id: before.id };
  });
}
