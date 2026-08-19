import { notFound } from 'next/navigation';
import GateCode from '../../../GateCode';
import ActionForm from '../../../ui/ActionForm';
import {
  Check, ContactFields, CustomerFields, Field, GateCodeField, JobFields,
  PropertyFields, ScheduleFields, Select, TextArea,
} from '../../../ui/Fields';
import {
  addContactAction, addNoteAction, addPropertyAction, cancelWorkOrderAction,
  createWorkOrderAction, recordWaterTestAction,
  redactEventAction, removeContactAction, rescheduleWorkOrderAction,
  setPropertyActiveAction, togglePinAction,
  unredactEventAction, updateContactAction, updateCustomerAction, updatePropertyAction,
} from '../../../actions';
import {
  getCustomer, getProperties, getContacts, getTechnicians, getTimeline,
  getWaterTests, getWorkOrders,
  type PropertyRow,
} from '@/lib/queries';
import {
  fmtDay, jobIsOpen, jobStatusClass, jobStatusLabel, jobTypeLabel,
} from '@/lib/jobs';
import { canRedact, requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  sale: 'sale',
  payment: 'payment',
  service_call: 'service',
  delivery: 'delivery',
  install: 'install',
  quote: 'quote',
  water_test: 'water test',
  note: 'note',
  sms: 'text',
  call: 'call',
  email: 'email',
  photo: 'photo',
  system: 'record',
};

/** What a person may type in. Mirrors ENTERABLE_KINDS in @lcp/db. */
const ENTERABLE: readonly (readonly [string, string])[] = [
  ['note', 'Note'], ['call', 'Phone call'], ['sms', 'Text'], ['email', 'Email'],
  ['quote', 'Quote'], ['service_call', 'Service call'], ['delivery', 'Delivery'],
  ['install', 'Install'],
];

/** Label, form name, and placeholder for each reading on the test panel. */
const READING_FIELDS: readonly (readonly [string, string, string])[] = [
  ['Free chlorine', 'freeChlorine', 'ppm'],
  ['Total chlorine', 'totalChlorine', 'ppm'],
  ['pH', 'ph', ''],
  ['Alkalinity', 'totalAlkalinity', 'ppm'],
  ['Hardness', 'calciumHardness', 'ppm'],
  ['Stabilizer', 'cyanuricAcid', 'ppm'],
  ['Salt', 'salt', 'ppm'],
  ['Phosphates', 'phosphates', 'ppb'],
  ['Temperature', 'temperatureF', '°F'],
];

function fmtDate(v: string) {
  const d = new Date(v);
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    iso: d.toISOString(),
  };
}

function fmtMoney(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : null;
}

function propertyName(p: PropertyRow): string {
  return p.label ?? (p.line1 ? p.line1 : 'Unnamed property');
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const customer = await getCustomer(id).catch(() => null);
  if (!customer) notFound();

  const [properties, contacts, timeline, waterTests, jobs, technicians] = await Promise.all([
    getProperties(id), getContacts(id), getTimeline(id), getWaterTests(id),
    getWorkOrders(id), getTechnicians(),
  ]);

  // Only live properties are offered as the subject of a new note or test.
  const propertyOptions = properties
    .filter((p) => p.active)
    .map((p) => [p.id, propertyName(p)] as const);

  return (
    <>
      <a className="back" href="/">← Search</a>

      <div className="header">
        <h2>{customer.display_name}</h2>
        <div className="meta">
          {[customer.primary_phone, customer.primary_email].filter(Boolean).join('  ·  ') || '—'}
        </div>
        <div className="badges">
          {customer.account_number && <span className="badge">#{customer.account_number}</span>}
          <span className="badge">{customer.kind}</span>
          {customer.status !== 'active' && <span className="badge warn">{customer.status}</span>}
          {customer.tax_exempt && <span className="badge accent">tax exempt</span>}
          {customer.customer_since && (
            <span className="badge">since {String(customer.customer_since).slice(0, 4)}</span>
          )}
          {customer.legacy_id && <span className="badge">evosus {customer.legacy_id}</span>}
        </div>
      </div>

      {/* ── What happened, entered first ───────────────────────────────── */}
      {/* The composer sits above everything else on purpose: recording what
          just happened is the reason this screen is open most of the time. */}
      <div className="card">
        <h3>Add to the timeline</h3>
        <ActionForm
          action={addNoteAction}
          submitLabel="Save entry"
          resetOnSuccess
        >
          <input type="hidden" name="customerId" value={customer.id} />

          <div className="row3">
            <Select label="Kind" name="kind" defaultValue="note" options={ENTERABLE} />
            <Select
              label="Direction" name="direction" includeBlank="—"
              options={[['inbound', 'They called us'], ['outbound', 'We called them']]}
            />
            <Select
              label="Property" name="propertyId" includeBlank="Whole account"
              options={propertyOptions}
            />
          </div>

          <Field label="Summary" name="title" placeholder="Called about the liner seam" />
          <TextArea label="Details" name="body" rows={3} />

          <div className="row2">
            <Field label="When" name="occurredAt" type="datetime-local"
              hint="Leave blank for now. Backdating is fine; the future is not." />
            <Check label="Pin to the top" name="pinned" />
          </div>
        </ActionForm>
      </div>

      <div className="grid">
        <div>
          {/* ── Billing ─────────────────────────────────────────────────── */}
          <div className="card">
            <h3>Billing</h3>
            <dl className="kv">
              <dt>Address</dt>
              <dd>
                {customer.line1
                  ? <>{customer.line1}<br />{[customer.city, customer.state].filter(Boolean).join(', ')} {customer.postal_code}</>
                  : <span style={{ color: 'var(--text-dim)' }}>None on file</span>}
              </dd>
              <dt>Phone</dt><dd>{customer.primary_phone ?? '—'}</dd>
              <dt>Email</dt><dd>{customer.primary_email ?? '—'}</dd>
            </dl>

            <details className="panel">
              <summary>Edit customer</summary>
              <ActionForm action={updateCustomerAction} submitLabel="Save changes">
                <input type="hidden" name="customerId" value={customer.id} />
                <CustomerFields c={customer} />
              </ActionForm>
            </details>
          </div>

          {/* ── Contacts ────────────────────────────────────────────────── */}
          <div className="card">
            <h3>Contacts ({contacts.length})</h3>
            {contacts.length === 0 && <p className="empty" style={{ padding: 0 }}>None.</p>}

            {contacts.map((c) => (
              <div className="prop" key={c.id}>
                <div className="label">
                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed contact'}
                  {c.is_primary && <span className="pin"> primary</span>}
                  {c.do_not_contact && <span className="badge warn" style={{ marginLeft: 6 }}>do not contact</span>}
                </div>
                <div className="addr">
                  {[c.role, c.phone, c.mobile, c.email].filter(Boolean).join('  ·  ') || '—'}
                </div>
                {c.notes && <div className="note">{c.notes}</div>}

                <details className="panel">
                  <summary>Edit</summary>
                  <ActionForm action={updateContactAction} submitLabel="Save contact">
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="contactId" value={c.id} />
                    <ContactFields c={c} />
                  </ActionForm>

                  <ActionForm
                    action={removeContactAction}
                    submitLabel="Remove this contact"
                    destructive
                    compact
                    confirm="Remove this contact? The timeline keeps a record that they were here."
                  >
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="contactId" value={c.id} />
                  </ActionForm>
                </details>
              </div>
            ))}

            <details className="panel">
              <summary>Add a contact</summary>
              <ActionForm action={addContactAction} submitLabel="Add contact">
                <input type="hidden" name="customerId" value={customer.id} />
                <ContactFields />
              </ActionForm>
            </details>
          </div>
        </div>

        <div>
          {/* ── Properties ──────────────────────────────────────────────── */}
          <div className="card">
            <h3>Properties ({properties.length})</h3>
            {properties.length === 0 && <p className="empty" style={{ padding: 0 }}>None.</p>}

            {properties.map((p) => (
              <div className="prop" key={p.id}>
                <div className="label">
                  {propertyName(p)}
                  {p.property_type && <span className="badge" style={{ marginLeft: 8 }}>{p.property_type}</span>}
                  {p.is_primary && <span className="pin"> primary</span>}
                  {!p.active && <span className="badge warn" style={{ marginLeft: 6 }}>archived</span>}
                </div>
                {p.line1 && (
                  <div className="addr">
                    {p.line1}, {[p.city, p.state].filter(Boolean).join(', ')} {p.postal_code}
                  </div>
                )}
                {p.access_notes && <div className="note"><b>Access</b> · {p.access_notes}</div>}
                {p.pet_notes && <div className="note"><b>Pets</b> · {p.pet_notes}</div>}
                {p.water_shutoff_notes && <div className="note"><b>Water</b> · {p.water_shutoff_notes}</div>}
                {p.electrical_notes && <div className="note"><b>Electrical</b> · {p.electrical_notes}</div>}
                {p.parking_notes && <div className="note"><b>Parking</b> · {p.parking_notes}</div>}
                {p.has_gate_code && (
                  <div className="note"><b>Gate code</b> · <GateCode propertyId={p.id} /></div>
                )}

                <details className="panel">
                  <summary>Edit</summary>
                  <ActionForm action={updatePropertyAction} submitLabel="Save property">
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="propertyId" value={p.id} />
                    <PropertyFields p={p} />
                  </ActionForm>

                  {/* Separate form so the code can be left untouched by the one
                      above. Submitting it empty is how a code gets cleared. */}
                  <details className="panel">
                    <summary>{p.has_gate_code ? 'Replace the gate code' : 'Set a gate code'}</summary>
                    <ActionForm action={updatePropertyAction} submitLabel="Save gate code" compact>
                      <input type="hidden" name="customerId" value={customer.id} />
                      <input type="hidden" name="propertyId" value={p.id} />
                      <input type="hidden" name="label" value={p.label ?? ''} />
                      <input type="hidden" name="propertyType" value={p.property_type ?? ''} />
                      <input type="hidden" name="accessNotes" value={p.access_notes ?? ''} />
                      <input type="hidden" name="petNotes" value={p.pet_notes ?? ''} />
                      <input type="hidden" name="waterShutoffNotes" value={p.water_shutoff_notes ?? ''} />
                      <input type="hidden" name="electricalNotes" value={p.electrical_notes ?? ''} />
                      <input type="hidden" name="parkingNotes" value={p.parking_notes ?? ''} />
                      {p.is_primary && <input type="hidden" name="isPrimary" value="true" />}
                      <GateCodeField hint="Leave empty and save to clear the code on file." />
                    </ActionForm>
                  </details>

                  <ActionForm
                    action={setPropertyActiveAction}
                    submitLabel={p.active ? 'Archive this property' : 'Reactivate this property'}
                    destructive={p.active}
                    compact
                  >
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="propertyId" value={p.id} />
                    <input type="hidden" name="active" value={p.active ? 'false' : 'true'} />
                  </ActionForm>
                </details>
              </div>
            ))}

            <details className="panel">
              <summary>Add a property</summary>
              <ActionForm action={addPropertyAction} submitLabel="Add property">
                <input type="hidden" name="customerId" value={customer.id} />
                <PropertyFields includeGateCode />
              </ActionForm>
            </details>
          </div>

          {/* ── Water tests ─────────────────────────────────────────────── */}
          <div className="card">
            <h3>Water tests ({waterTests.length})</h3>
            {waterTests.length === 0 && <p className="empty" style={{ padding: 0 }}>None recorded.</p>}

            {waterTests.length > 0 && (
              <div className="scroller">
                <table className="readings">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>FC</th><th>pH</th><th>TA</th><th>CH</th><th>CYA</th>
                      <th>Recommended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waterTests.map((w) => (
                      <tr key={w.id}>
                        <td>{fmtDate(w.tested_at).date}</td>
                        <td>{w.free_chlorine ?? '—'}</td>
                        <td>{w.ph ?? '—'}</td>
                        <td>{w.total_alkalinity ?? '—'}</td>
                        <td>{w.calcium_hardness ?? '—'}</td>
                        <td>{w.cyanuric_acid ?? '—'}</td>
                        <td className="wide">{w.recommendation ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <details className="panel">
              <summary>Record a test</summary>
              <ActionForm action={recordWaterTestAction} submitLabel="Save test" resetOnSuccess>
                <input type="hidden" name="customerId" value={customer.id} />

                <div className="row2">
                  <Select
                    label="Property" name="propertyId" includeBlank="Whole account"
                    options={propertyOptions}
                  />
                  <Select
                    label="Sample from" name="source" defaultValue="in_store"
                    options={[
                      ['in_store', 'Brought in'], ['field', 'Taken on site'],
                      ['customer', 'Customer reported'],
                    ]}
                  />
                </div>

                <div className="readingsgrid">
                  {READING_FIELDS.map(([label, name, unit]) => (
                    <Field key={name} label={unit ? `${label} (${unit})` : label} name={name} />
                  ))}
                </div>

                <TextArea label="Recommended" name="recommendation" rows={2}
                  placeholder="Shock tonight, then alkalinity increaser in the morning." />
                <TextArea label="Notes" name="notes" rows={2} />
              </ActionForm>
            </details>
          </div>
        </div>
      </div>

      {/* ── Jobs ──────────────────────────────────────────────────────── */}
      {/* Above the timeline, below everything describing the account: what is
          booked is a question about next week, and the feed is a question about
          what already happened. */}
      <div className="card">
        <h3>Jobs ({jobs.length})</h3>
        {jobs.length === 0 && <p className="empty" style={{ padding: 0 }}>None on the books.</p>}

        {jobs.map((j) => {
          const open = jobIsOpen(j.status);
          return (
            <div className="prop" key={j.id}>
              <div className="label">
                {j.number && <span className="jobno">{j.number}</span>}{' '}
                {j.summary ?? jobTypeLabel(j.type)}
                <span className={jobStatusClass(j.status)} style={{ marginLeft: 8 }}>
                  {jobStatusLabel(j.status)}
                </span>
                {j.priority === 'urgent' && (
                  <span className="badge bad" style={{ marginLeft: 6 }}>urgent</span>
                )}
              </div>

              <div className="addr">
                {[
                  fmtDay(j.scheduled_date) ?? 'Unscheduled',
                  j.scheduled_window,
                  j.assignee ?? 'Unassigned',
                  jobTypeLabel(j.type),
                  j.property_label,
                  j.task_count > 0 ? `${j.tasks_done}/${j.task_count} steps` : null,
                ].filter(Boolean).join('  ·  ')}
              </div>

              {j.instructions && <div className="note"><b>Office</b> · {j.instructions}</div>}
              {j.work_performed && <div className="note"><b>Performed</b> · {j.work_performed}</div>}
              {/* Written by the technician's phone. It is the thing that
                  generates the next job, so it is not buried. */}
              {j.incomplete_reason && (
                <div className="flag"><b>Left unfinished</b> · {j.incomplete_reason}</div>
              )}

              {open && (
                <details className="panel">
                  <summary>Reschedule or cancel</summary>
                  {/* Pre-filled from the row on purpose: rescheduleWorkOrder
                      writes all four columns from what it is given, so a blank
                      field here clears what is on file rather than leaving it. */}
                  <ActionForm action={rescheduleWorkOrderAction} submitLabel="Save the change">
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="workOrderId" value={j.id} />
                    <ScheduleFields w={j} technicians={technicians} />
                  </ActionForm>

                  <ActionForm
                    action={cancelWorkOrderAction}
                    submitLabel="Call this job off"
                    destructive
                    compact
                    confirm="Cancel this job? The reason goes on the timeline."
                  >
                    <input type="hidden" name="customerId" value={customer.id} />
                    <input type="hidden" name="workOrderId" value={j.id} />
                    <Field label="Reason" name="reason" required
                      placeholder="Customer rescheduled for the following week." />
                  </ActionForm>
                </details>
              )}
            </div>
          );
        })}

        <details className="panel">
          <summary>Schedule a job</summary>
          <ActionForm action={createWorkOrderAction} submitLabel="Schedule job" resetOnSuccess>
            <input type="hidden" name="customerId" value={customer.id} />
            <JobFields propertyOptions={propertyOptions} technicians={technicians} />
          </ActionForm>
        </details>
      </div>

      {/* ── The feed ──────────────────────────────────────────────────── */}
      <div className="card">
        <h3>Timeline ({timeline.length})</h3>
        {timeline.length === 0 && <p className="empty" style={{ padding: 0 }}>Nothing recorded yet.</p>}

        <ul className="timeline">
          {timeline.map((e) => {
            const { date, iso } = fmtDate(e.occurred_at);
            const amount = fmtMoney((e.payload as any)?.amount);
            return (
              <li className="event" key={e.id}>
                <time className="when" dateTime={iso}>{date}</time>
                <div>
                  {amount && <span className="amount">{amount}</span>}
                  <div className="title">
                    <span className={`kind ${e.kind}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                    {e.title ?? '—'}
                    {e.pinned && <span className="pin">pinned</span>}
                  </div>
                  {e.body && <div className="body">{e.body}</div>}
                  <div className="who">
                    {[
                      e.property_label,
                      e.actor_label,
                      e.source !== 'app' ? `via ${e.source}` : null,
                    ].filter(Boolean).join('  ·  ')}
                  </div>

                  <div className="eventactions">
                    <ActionForm
                      action={togglePinAction}
                      submitLabel={e.pinned ? 'Unpin' : 'Pin'}
                      compact
                    >
                      <input type="hidden" name="customerId" value={customer.id} />
                      <input type="hidden" name="eventId" value={e.id} />
                      <input type="hidden" name="pinned" value={e.pinned ? 'false' : 'true'} />
                    </ActionForm>

                    {canRedact(user) && (
                      <details className="inlinepanel">
                        <summary>Hide</summary>
                        {/* Hiding is not deleting: the entry stays, and the act
                            of hiding it appears on this same feed. */}
                        <ActionForm action={redactEventAction} submitLabel="Hide entry" destructive compact>
                          <input type="hidden" name="customerId" value={customer.id} />
                          <input type="hidden" name="eventId" value={e.id} />
                          <Field label="Reason" name="reason" required
                            placeholder="Logged against the wrong account." />
                        </ActionForm>
                      </details>
                    )}

                    {/* The announcement of a hidden entry is where it gets
                        restored from, because the entry itself is not in the
                        feed to carry a button.

                        Two conditions, and both are load-bearing. The action
                        marker picks the "was hidden" announcement rather than
                        the "was restored" one, which points at the same event.
                        ref_is_redacted checks the entry is still hidden, since
                        restoring cannot remove the announcement that offers the
                        button - the feed is append-only. */}
                    {canRedact(user) && e.ref_id && e.ref_is_redacted
                      && (e.payload as { action?: string } | null)?.action === 'redact' && (
                      <ActionForm action={unredactEventAction} submitLabel="Restore" compact>
                        <input type="hidden" name="customerId" value={customer.id} />
                        <input type="hidden" name="eventId" value={e.ref_id} />
                      </ActionForm>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
