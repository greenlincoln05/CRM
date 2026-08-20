import ActionForm from '../../ui/ActionForm';
import { ScheduleFields } from '../../ui/Fields';
import { rescheduleWorkOrderAction } from '../../actions';
import { getDaySchedule, getTechnicians, type ScheduledJobRow } from '@/lib/queries';
import {
  fmtDay, jobIsOpen, jobStatusClass, jobStatusLabel, jobTypeLabel,
  parseDay, shiftDay, today,
} from '@/lib/jobs';
import { canDispatch, requireUser } from '@/lib/session';
import { DEFAULT_JOB_MINUTES } from '@lcp/db';

export const dynamic = 'force-dynamic';

/**
 * The day board: who is going where, in what order.
 *
 * THIS IS A LIST VIEW OVER PROPERTIES. CLAUDE.md non-negotiable #4 and ADR 0003
 * point 1: no gate code appears here, and there is no button to reveal one.
 * `getDaySchedule` returns `has_gate_code` - a boolean saying a code exists, so
 * dispatch knows the technician will be able to get in - and no sensitive
 * column at all. A code is revealed one property at a time from the customer's
 * record through /api/gate-code, which logs it. Forty of them on one screen
 * behind a counter is the exact shape that must never exist, and a "reveal"
 * control on a row here is how it would come to.
 *
 * NO FREE TEXT ABOUT A PROPERTY IS RENDERED HERE EITHER, and that is the same
 * rule rather than a second one. Choosing the columns protects against a code
 * in the column built for codes; it does nothing about a code typed into a
 * sentence. `instructions`, `work_performed` and `incomplete_reason` are all
 * boxes a person types prose into, and the most natural sentence in the world
 * for a technician standing at a gate that did not open is "keypad code on file
 * didn't work, owner says it's now 1234". That lands in `work_order` as
 * plaintext one table over from the encrypted column, and rendering it here
 * would put it on a list of forty addresses - exactly what the encryption
 * exists to prevent. So the board says a job was left unfinished, loudly,
 * because dispatch has to know that; the sentence itself is read one customer
 * at a time on their own record.
 *
 * Cancelled jobs are shown rather than dropped. "Why is nobody going to the
 * Nadeaus today" is a question this screen exists to answer, and a row that has
 * quietly vanished answers it with silence.
 */

type Group = {
  id: string | null;
  name: string;
  capacity: number | null;
  jobs: ScheduledJobRow[];
};

/**
 * Split the day into columns of work.
 *
 * The order comes from the query - technicians alphabetically, unassigned last,
 * each one's jobs by `sequence` - so this walks the rows once and keeps it,
 * rather than sorting again and risking a second opinion about the same day.
 */
function groupByTechnician(jobs: readonly ScheduledJobRow[]): Group[] {
  const groups: Group[] = [];
  for (const job of jobs) {
    let group = groups.find((g) => g.id === job.assigned_user_id);
    if (!group) {
      group = {
        id: job.assigned_user_id,
        name: job.assignee ?? 'Nobody assigned yet',
        capacity: job.assignee_capacity,
        jobs: [],
      };
      groups.push(group);
    }
    group.jobs.push(job);
  }
  return groups;
}

/** The minutes a column of work actually occupies. Mirrors assertCapacity. */
function loadMinutes(g: Group): number {
  return g.jobs
    .filter((j) => j.status !== 'cancelled')
    .reduce((m, j) => m + (j.estimated_minutes ?? DEFAULT_JOB_MINUTES), 0);
}

function addressLine(j: ScheduledJobRow): string | null {
  if (!j.line1) return null;
  const town = [j.city, j.state].filter(Boolean).join(', ');
  return [j.line1, town].filter(Boolean).join(', ');
}

function JobRow({ job, technicians, mayDispatch }: {
  job: ScheduledJobRow;
  technicians: Awaited<ReturnType<typeof getTechnicians>>;
  // Decided once in the page, from the session, and handed down as a plain
  // boolean. The role itself does not travel: this row is a server component
  // today, and passing `user` would put the answer one 'use client' away from
  // the browser the first time someone makes part of the board interactive.
  mayDispatch: boolean;
}) {
  const open = jobIsOpen(job.status);
  const address = addressLine(job);

  return (
    <div className={`job${open ? '' : ' off'}${job.priority === 'urgent' ? ' urgent' : ''}`}>
      <div className="seq">{job.sequence ?? '·'}</div>

      <div>
        <div className="label">
          <a href={`/customers/${job.customer_id}`}>{job.customer_name}</a>
          <span className={jobStatusClass(job.status)}>{jobStatusLabel(job.status)}</span>
          {job.priority === 'urgent' && <span className="badge bad">urgent</span>}
          {/* A boolean, and only a boolean. See the note at the top of this file. */}
          {job.has_gate_code && <span className="badge">gate code on file</span>}
        </div>

        <div className="addr">
          {[
            job.scheduled_window ?? 'Anytime',
            jobTypeLabel(job.type),
            job.property_label,
            address,
            job.customer_phone,
            job.estimated_minutes ? `${job.estimated_minutes} min` : null,
            job.task_count > 0 ? `${job.tasks_done}/${job.task_count} steps` : null,
            job.number,
          ].filter(Boolean).join('  ·  ')}
        </div>

        {job.summary && <div className="note"><b>Job</b> · {job.summary}</div>}

        {/* The fact, not the sentence. `incomplete_reason` is the thing that
            generates the next job, so dispatch has to see at a glance that this
            visit did not finish - hence the amber block rather than a line of
            grey text - but the technician's own words are read on the one
            screen that is about one customer. See the note at the top. */}
        {job.incomplete_reason && (
          <div className="flag">
            <b>Left unfinished</b> ·{' '}
            <a href={`/customers/${job.customer_id}`}>
              read why on {job.customer_name}&apos;s record
            </a>
          </div>
        )}

        {job.status === 'cancelled' && (
          <div className="note">Called off — the reason is on the customer's timeline.</div>
        )}

        {/* COSMETIC. rescheduleWorkOrder refuses a technician itself, before it
            looks the job up, and that refusal is the boundary; this only stops
            the board offering a form whose one outcome would be "You do not
            have permission to schedule work." Prove the rule by calling the
            action directly, not by reading this file. The row loses nothing it
            needs to be read - customer, window, type, address, status all sit
            above - so a technician gets a legible board, just not a lever. */}
        {open && mayDispatch && (
          <details className="panel">
            <summary>Reschedule or reassign</summary>
            {/* Every field pre-filled from the row: the write layer sets all
                four columns from what it is handed, so a blank window here
                would clear the one on file. */}
            <ActionForm action={rescheduleWorkOrderAction} submitLabel="Save the change">
              <input type="hidden" name="customerId" value={job.customer_id} />
              <input type="hidden" name="workOrderId" value={job.id} />
              {/* The four scheduling columns, named one by one rather than
                  handing the whole row across the client boundary. Same reason
                  the SELECT list in getDaySchedule is written out by hand: what
                  crosses should be what is needed, so that a column added to
                  the row later does not silently start travelling with it. */}
              <ScheduleFields
                w={{
                  scheduled_date: job.scheduled_date,
                  scheduled_window: job.scheduled_window,
                  sequence: job.sequence,
                  assigned_user_id: job.assigned_user_id,
                }}
                technicians={technicians}
              />
              <label className="hint" style={{ display: 'block' }}>
                <input type="checkbox" name="overrideCapacity" />{' '}
                Book anyway if this person&apos;s day is already full
              </label>
            </ActionForm>
          </details>
        )}
      </div>
    </div>
  );
}

export default async function SchedulePage({ searchParams }: {
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireUser();
  // Resolved here, server-side, and passed down as a boolean. Reads stay open
  // this session: a technician can still look at the whole board.
  const mayDispatch = canDispatch(user);

  const params = await searchParams;
  // A date out of a URL is user input. Anything that is not a real day falls
  // back to today rather than reaching ::date and becoming a 500.
  const date = parseDay(params.date) ?? today();

  const [jobs, technicians] = await Promise.all([getDaySchedule(date), getTechnicians()]);

  const groups = groupByTechnician(jobs);
  const busy = new Set(groups.map((g) => g.id));
  const idle = technicians.filter((t) => t.role === 'tech' && !busy.has(t.id));

  const counts = {
    complete: jobs.filter((j) => j.status === 'complete').length,
    incomplete: jobs.filter((j) => j.status === 'incomplete').length,
    cancelled: jobs.filter((j) => j.status === 'cancelled').length,
  };

  const isToday = date === today();

  return (
    <>
      <div className="header">
        <h2>{fmtDay(date)}</h2>
        <div className="meta">
          {jobs.length === 0
            ? 'Nothing on the board.'
            : [
              `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`,
              counts.complete ? `${counts.complete} complete` : null,
              counts.incomplete ? `${counts.incomplete} left unfinished` : null,
              counts.cancelled ? `${counts.cancelled} cancelled` : null,
            ].filter(Boolean).join('  ·  ')}
        </div>
      </div>

      {/* A plain GET form. Nothing is written by looking at a different day, so
          this is a link with a date picker on it, not an action. */}
      <div className="card">
        <form className="dayctl" method="get">
          <label className="field">
            <span>Day</span>
            <input type="date" name="date" defaultValue={date} />
          </label>
          <button type="submit" className="primary">Show that day</button>
        </form>

        <p className="hint daynav">
          <a href={`/schedule?date=${shiftDay(date, -1)}`}>← {fmtDay(shiftDay(date, -1), { weekday: 'short', month: 'short', day: 'numeric' })}</a>
          {!isToday && <a href="/schedule">Today</a>}
          <a href={`/schedule?date=${shiftDay(date, 1)}`}>{fmtDay(shiftDay(date, 1), { weekday: 'short', month: 'short', day: 'numeric' })} →</a>
        </p>
      </div>

      {groups.length === 0 && (
        <p className="empty">
          No jobs on this day. Jobs are booked from a customer&apos;s record.
        </p>
      )}

      {groups.map((g) => (
        <div className="card" key={g.id ?? 'unassigned'}>
          <h3>
            {g.name} · {g.jobs.length} {g.jobs.length === 1 ? 'job' : 'jobs'}
            {g.id && g.capacity != null && (
              <span className={`load${loadMinutes(g) > g.capacity ? ' over' : ''}`}>
                {loadMinutes(g)} / {g.capacity} min
              </span>
            )}
          </h3>
          {/* Unassigned is its own bucket, last, because it is the work still
              needing a name against it rather than a technician called NULL. */}
          {g.jobs.map((job) => (
            <JobRow
              key={job.id} job={job} technicians={technicians}
              mayDispatch={mayDispatch}
            />
          ))}
        </div>
      ))}

      {idle.length > 0 && (
        <p className="hint">
          Nothing booked for {idle.map((t) => t.display_name).join(', ')}.
        </p>
      )}
    </>
  );
}
