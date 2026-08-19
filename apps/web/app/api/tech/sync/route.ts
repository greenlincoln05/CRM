import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Replay one queued action from a technician's phone.
 *
 * Idempotent by client-generated id. Networks fail after the server commits but
 * before the response arrives; the device retries; this must land once.
 *
 * occurredAt is when it happened on the DEVICE, which may be hours before it
 * synced. That is the timestamp that goes on the record — a job completed at
 * 2pm in a dead zone did not happen at 6pm when the truck reached town.
 *
 * Authentication is not enough here. A signed-in technician must not be able to
 * complete, annotate, or tick off someone else's job, so every action is
 * checked against the assignment on the work order it names.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to sync.' }, { status: 401 });
  }

  const { db } = await getDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const { clientActionId, kind, payload, occurredAt } = body ?? {};
  if (!clientActionId || !kind) {
    return NextResponse.json({ error: 'clientActionId and kind required' }, { status: 400 });
  }

  // Already applied: report success so the device stops retrying.
  const seen = rows(await db.execute(sql`
    SELECT client_action_id FROM synced_action WHERE client_action_id = ${clientActionId}::uuid`));
  if (seen.length) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const at = occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString();

  try {
    switch (kind) {
      case 'job_status': {
        const { workOrderId, status, incompleteReason } = payload ?? {};
        if (!workOrderId || !status) throw new Error('workOrderId and status required');

        // 'cancelled' is deliberately NOT here. The PWA never offers it, but the
        // payload is client-controlled, and calling a job off is an office
        // decision (ADR 0010) - a technician who cannot cancel from the board
        // must not be able to cancel by posting one. A job that cannot be done
        // is 'incomplete' with a reason, which is the thing that generates the
        // next visit; a cancellation says nobody is coming, and that belongs to
        // whoever tells the customer.
        const valid = ['scheduled', 'en_route', 'on_site', 'complete', 'incomplete'];
        if (!valid.includes(status)) throw new Error(`unknown status "${status}"`);

        const denied = await assertOwnsJob(db, user, workOrderId);
        if (denied) return denied;

        // The reason rides along with the status change rather than following
        // it. Two reasons, and both are load-bearing:
        //
        //   - The timeline event below re-reads this row. Written afterwards,
        //     by a second action, the reason arrives after the event is already
        //     on the feed - and the feed is append-only by trigger, so that row
        //     can never be corrected.
        //   - The outbox orders by seq = Date.now(); two actions queued in the
        //     same millisecond tie, and a tie can replay in either order.
        //
        // One UPDATE, then the event, sidesteps both.
        const reason = typeof incompleteReason === 'string' && incompleteReason.trim()
          ? incompleteReason.trim()
          : null;

        await db.execute(sql`
          UPDATE work_order SET
            status       = ${status},
            en_route_at  = CASE WHEN ${status} = 'en_route' THEN ${at}::timestamptz ELSE en_route_at END,
            arrived_at   = CASE WHEN ${status} = 'on_site'  THEN ${at}::timestamptz ELSE arrived_at END,
            completed_at = CASE WHEN ${status} IN ('complete','incomplete') THEN ${at}::timestamptz ELSE completed_at END,
            -- Only an incomplete job carries a reason. A plain COALESCE makes
            -- the field write-once, and nothing anywhere writes NULL to it, so
            -- a job marked incomplete for "parts needed" and then finished the
            -- following week would keep an amber "Left unfinished" on the
            -- dispatch board and the customer's record forever. That field is
            -- what generates the next job, so a stale one manufactures phantom
            -- follow-up work.
            incomplete_reason = CASE WHEN ${status} = 'incomplete'
                                     THEN COALESCE(${reason}, incomplete_reason)
                                     ELSE NULL END,
            updated_at   = now()
          WHERE id = ${workOrderId}::uuid`);

        // A completed job becomes part of the customer's permanent history.
        if (status === 'complete' || status === 'incomplete') {
          await writeTimeline(db, workOrderId, at, status, user);
        }
        break;
      }

      case 'task_toggle': {
        const { taskId, done } = payload ?? {};
        if (!taskId) throw new Error('taskId required');

        // The task names no work order, so resolve it before trusting it.
        const owner = rows(await db.execute(sql`
          SELECT w.id, w.assigned_user_id
          FROM work_order_task t JOIN work_order w ON w.id = t.work_order_id
          WHERE t.id = ${taskId}::uuid`))[0];
        if (!owner) throw new Error('unknown task');
        const denied = denyIfNotOwner(user, owner.assigned_user_id);
        if (denied) return denied;

        await db.execute(sql`
          UPDATE work_order_task
          SET done = ${!!done}, done_at = ${done ? at : null}::timestamptz, updated_at = now()
          WHERE id = ${taskId}::uuid`);
        break;
      }

      case 'job_notes': {
        const { workOrderId, workPerformed, incompleteReason } = payload ?? {};
        if (!workOrderId) throw new Error('workOrderId required');

        const denied = await assertOwnsJob(db, user, workOrderId);
        if (denied) return denied;

        await db.execute(sql`
          UPDATE work_order SET
            work_performed    = COALESCE(${workPerformed ?? null}, work_performed),
            incomplete_reason = COALESCE(${incompleteReason ?? null}, incomplete_reason),
            updated_at        = now()
          WHERE id = ${workOrderId}::uuid`);
        break;
      }

      case 'ping': {
        const { workOrderId, reason, lat, lng, accuracy } = payload ?? {};
        if (!workOrderId) throw new Error('workOrderId required');

        const denied = await assertOwnsJob(db, user, workOrderId);
        if (denied) return denied;

        await db.execute(sql`
          INSERT INTO work_order_ping (work_order_id, user_id, occurred_at, reason, lat, lng, accuracy_meters)
          VALUES (${workOrderId}::uuid, ${user.userId}::uuid, ${at}::timestamptz, ${reason ?? 'manual'},
                  ${lat ?? null}, ${lng ?? null}, ${accuracy ? Math.round(accuracy) : null})`);
        break;
      }

      default:
        return NextResponse.json({ error: `unknown action kind "${kind}"` }, { status: 400 });
    }

    await db.execute(sql`
      INSERT INTO synced_action (client_action_id, user_id, kind, payload, occurred_at)
      VALUES (${clientActionId}::uuid, ${user.userId}::uuid, ${kind},
              ${JSON.stringify(payload ?? {})}::jsonb, ${at}::timestamptz)
      ON CONFLICT (client_action_id) DO NOTHING`);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[tech/sync]', kind, err?.message);
    // 400 tells the device to stop retrying; 500 tells it to try again later.
    const permanent = /required|unknown/.test(String(err?.message ?? ''));
    return NextResponse.json(
      { error: String(err?.message ?? err) },
      { status: permanent ? 400 : 500 },
    );
  }
}

/** Supervisors may act on any job; a technician only on their own. */
function denyIfNotOwner(user: SessionUser, assignedUserId: string | null) {
  if (user.role === 'admin' || user.role === 'manager') return null;
  if (assignedUserId === user.userId) return null;
  return NextResponse.json({ error: 'That job is not assigned to you.' }, { status: 403 });
}

async function assertOwnsJob(db: any, user: SessionUser, workOrderId: string) {
  const rows = (r: any) => (r?.rows ?? r) as any[];
  const job = rows(await db.execute(sql`
    SELECT assigned_user_id FROM work_order WHERE id = ${workOrderId}::uuid`))[0];
  if (!job) throw new Error('unknown work order');
  return denyIfNotOwner(user, job.assigned_user_id);
}

/** Completing a job writes it onto the customer's timeline, permanently. */
async function writeTimeline(
  db: any, workOrderId: string, at: string, status: string, user: SessionUser,
) {
  const rows = (r: any) => (r?.rows ?? r) as any[];
  const job = rows(await db.execute(sql`
    SELECT w.customer_id, w.property_id, w.number, w.summary, w.type,
           w.work_performed, w.incomplete_reason
    FROM work_order w WHERE w.id = ${workOrderId}::uuid`))[0];
  if (!job) return;

  const body = status === 'complete'
    ? job.work_performed
    : [job.work_performed, job.incomplete_reason && `Not completed: ${job.incomplete_reason}`]
        .filter(Boolean).join('\n\n');

  // The actor is whoever is signed in, not whoever the job was assigned to.
  // If a second technician finishes someone else's job, the feed says so.
  await db.execute(sql`
    INSERT INTO timeline_event (customer_id, property_id, occurred_at, kind, source,
                                title, body, ref_type, ref_id, actor_user_id, actor_label)
    VALUES (${job.customer_id}::uuid, ${job.property_id ?? null}::uuid, ${at}::timestamptz,
            ${job.type === 'install' ? 'install' : 'service_call'}, 'app',
            ${`${job.summary ?? 'Service call'}${job.number ? ` (${job.number})` : ''}`},
            ${body ?? null}, 'work_order', ${workOrderId},
            ${user.userId}::uuid, ${user.label})`);
}
