import type {
  ContactRow, CustomerDetail, PropertyRow, TechnicianRow, WorkOrderRow,
} from '@/lib/queries';
import { JOB_PRIORITIES, JOB_TYPES } from '@/lib/jobs';

/**
 * The field sets, shared between the "add" and "edit" versions of each form.
 *
 * These are plain server-rendered markup with defaultValue - no client state.
 * A form that is populated by the server and validated by the server has one
 * definition of what it contains, and the browser cannot drift from it.
 */

export function Field({
  label, name, defaultValue, type = 'text', placeholder, required, hint, autoFocus,
  inputMode,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  type?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  autoFocus?: boolean;
  /** Which keyboard a phone offers. Shape and affordance, never a rule. */
  inputMode?: 'text' | 'numeric' | 'tel' | 'email' | 'decimal';
}) {
  return (
    <label className="field">
      <span>{label}{required && <em aria-hidden> *</em>}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function TextArea({
  label, name, defaultValue, rows = 3, placeholder, hint,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name={name} rows={rows} defaultValue={defaultValue ?? ''} placeholder={placeholder} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Select({
  label, name, defaultValue, options, includeBlank,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  options: readonly (readonly [string, string])[];
  includeBlank?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue ?? ''}>
        {includeBlank && <option value="">{includeBlank}</option>}
        {options.map(([value, text]) => (
          <option key={value} value={value}>{text}</option>
        ))}
      </select>
    </label>
  );
}

export function Check({
  label, name, defaultChecked, hint,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function AddressFields({ a }: {
  a?: {
    line1?: string | null; line2?: string | null;
    city?: string | null; state?: string | null; postal_code?: string | null;
  };
}) {
  return (
    <>
      <Field label="Street" name="line1" defaultValue={a?.line1} />
      <Field label="Unit / line 2" name="line2" defaultValue={a?.line2} />
      <div className="row3">
        <Field label="Town" name="city" defaultValue={a?.city} />
        <Field label="State" name="state" defaultValue={a?.state} placeholder="VT" />
        <Field label="ZIP" name="postalCode" defaultValue={a?.postal_code} />
      </div>
    </>
  );
}

export function CustomerFields({ c }: { c?: CustomerDetail }) {
  return (
    <>
      <div className="row2">
        <Select
          label="Type" name="kind" defaultValue={c?.kind ?? 'residential'}
          options={[['residential', 'Residential'], ['commercial', 'Commercial']]}
        />
        <Select
          label="Status" name="status" defaultValue={c?.status ?? 'active'}
          options={[['active', 'Active'], ['inactive', 'Inactive']]}
        />
      </div>

      <Field label="Company" name="companyName" defaultValue={c?.company_name}
        hint="Required for a commercial account." />

      <div className="row2">
        <Field label="First name" name="firstName" defaultValue={c?.first_name} autoFocus={!c} />
        <Field label="Last name" name="lastName" defaultValue={c?.last_name} />
      </div>

      <div className="row2">
        <Field label="Phone" name="phone" defaultValue={c?.primary_phone}
          placeholder="(802) 555-0142" hint="7 digits is assumed to be 802." />
        <Field label="Email" name="email" defaultValue={c?.primary_email} type="email" />
      </div>

      <div className="row2">
        <Field label="Account number" name="accountNumber" defaultValue={c?.account_number}
          hint="The Evosus number, if this account has one." />
        <Field label="Customer since" name="customerSince" defaultValue={c?.customer_since}
          type="date" />
      </div>

      <fieldset>
        <legend>Billing address</legend>
        <AddressFields a={c ?? undefined} />
      </fieldset>

      <Check label="Tax exempt" name="taxExempt" defaultChecked={c?.tax_exempt} />
      <Field label="Tax exempt ID" name="taxExemptId" defaultValue={c?.tax_exempt_id} />
    </>
  );
}

export function ContactFields({ c }: { c?: ContactRow }) {
  return (
    <>
      <div className="row2">
        <Field label="First name" name="firstName" defaultValue={c?.first_name} autoFocus={!c} />
        <Field label="Last name" name="lastName" defaultValue={c?.last_name} />
      </div>

      <Select
        label="Role" name="role" defaultValue={c?.role} includeBlank="—"
        options={[
          ['owner', 'Owner'], ['spouse', 'Spouse'], ['property_manager', 'Property manager'],
          ['tenant', 'Tenant'], ['ap', 'Accounts payable'], ['other', 'Other'],
        ]}
      />

      <div className="row2">
        <Field label="Phone" name="phone" defaultValue={c?.phone} />
        <Field label="Mobile" name="mobile" defaultValue={c?.mobile} />
      </div>

      <Field label="Email" name="email" defaultValue={c?.email} type="email" />
      <TextArea label="Notes" name="notes" defaultValue={c?.notes} rows={2} />

      <Check label="Primary contact" name="isPrimary" defaultChecked={c?.is_primary}
        hint="Promoting someone here demotes whoever holds it now." />
      <Check label="Do not contact" name="doNotContact" defaultChecked={c?.do_not_contact}
        hint="Suppresses marketing and automated texts." />
    </>
  );
}

/**
 * The gate code is not part of PropertyFields, and that is deliberate.
 *
 * The edit form must be able to submit without mentioning the code at all,
 * because "no gate code field in the payload" means "leave what is on file" and
 * an empty string means "clear it". A field that is always present cannot say
 * the first of those. On the add form there is nothing to preserve, so it can
 * be included inline.
 */
export function GateCodeField({ hint }: { hint?: string }) {
  return (
    <label className="field">
      <span>Gate or lockbox code</span>
      <input name="gateCode" type="text" autoComplete="off" spellCheck={false} />
      <small>{hint ?? 'Encrypted before it is stored. Every reveal is logged.'}</small>
    </label>
  );
}

export function PropertyFields({ p, includeGateCode }: {
  p?: PropertyRow;
  includeGateCode?: boolean;
}) {
  return (
    <>
      <div className="row2">
        <Field label="Label" name="label" defaultValue={p?.label}
          placeholder="Main house, Camp, Shelburne rental" autoFocus={!p} />
        <Select
          label="Type" name="propertyType" defaultValue={p?.property_type} includeBlank="—"
          options={[['pool', 'Pool'], ['spa', 'Spa'], ['stove', 'Stove'], ['multiple', 'Multiple']]}
        />
      </div>

      <fieldset>
        <legend>Address</legend>
        <AddressFields a={p ?? undefined} />
      </fieldset>

      <fieldset>
        <legend>Arrival knowledge</legend>
        <TextArea label="Access notes" name="accessNotes" defaultValue={p?.access_notes}
          placeholder="Gate on the left side of the garage." />
        <TextArea label="Pets" name="petNotes" defaultValue={p?.pet_notes} rows={2}
          placeholder="Golden retriever, Moose. Friendly but loud." />
        <div className="row2">
          <TextArea label="Water shutoff" name="waterShutoffNotes"
            defaultValue={p?.water_shutoff_notes} rows={2} />
          <TextArea label="Electrical" name="electricalNotes"
            defaultValue={p?.electrical_notes} rows={2} />
        </div>
        <TextArea label="Parking" name="parkingNotes" defaultValue={p?.parking_notes} rows={2} />
        {includeGateCode && <GateCodeField />}
      </fieldset>

      <Check label="Primary property" name="isPrimary" defaultChecked={p?.is_primary} />
    </>
  );
}

/* ── Work orders ─────────────────────────────────────────────────────── */

/** The picker of who is going. Roles other than tech are named as such. */
function technicianOptions(
  technicians: readonly TechnicianRow[],
): readonly (readonly [string, string])[] {
  return technicians.map((t) => [
    t.id,
    t.role === 'tech' ? t.display_name : `${t.display_name} (${t.role})`,
  ] as const);
}

/**
 * When, how long, who, and where in the day - the four things dispatch moves.
 *
 * Shared between booking a job and moving one, and on the moving side every
 * field has to be pre-filled from the row. rescheduleWorkOrder writes all four
 * columns from what it is given rather than merging, so a form that omitted the
 * window would silently clear it. Pass `w` and they all come back populated.
 */
export function ScheduleFields({ w, technicians }: {
  w?: Pick<WorkOrderRow,
    'scheduled_date' | 'scheduled_window' | 'sequence' | 'assigned_user_id'>;
  technicians: readonly TechnicianRow[];
}) {
  return (
    <>
      <div className="row3">
        <Field label="Date" name="scheduledDate" type="date"
          defaultValue={w?.scheduled_date}
          hint="Leave blank to park it unscheduled." />
        <Field label="Arrival window" name="scheduledWindow"
          defaultValue={w?.scheduled_window} placeholder="8:00 – 10:00" />
        <Field label="Stop on the day" name="sequence" inputMode="numeric"
          defaultValue={w?.sequence == null ? '' : String(w.sequence)}
          hint="1 is the first call of the day." />
      </div>

      <Select
        label="Technician" name="assignedUserId"
        defaultValue={w?.assigned_user_id} includeBlank="Unassigned"
        options={technicianOptions(technicians)}
      />
    </>
  );
}

/**
 * Booking a job.
 *
 * No status field: a job being booked is scheduled, and the statuses after that
 * one are things the technician's phone reports having done, not things the
 * counter picks from a list.
 */
export function JobFields({ propertyOptions, technicians }: {
  propertyOptions: readonly (readonly [string, string])[];
  technicians: readonly TechnicianRow[];
}) {
  return (
    <>
      <div className="row3">
        <Select label="Type" name="type" defaultValue="service" options={JOB_TYPES} />
        <Select label="Priority" name="priority" defaultValue="normal" options={JOB_PRIORITIES} />
        <Select
          label="Property" name="propertyId" includeBlank="Whole account"
          options={propertyOptions}
        />
      </div>

      <Field label="Summary" name="summary" placeholder="Spring opening"
        hint="What the technician sees first on the phone." />

      <ScheduleFields technicians={technicians} />

      <Field label="Estimated time (minutes)" name="estimatedMinutes" inputMode="numeric"
        placeholder="90" />

      <TextArea label="Instructions" name="instructions" rows={2}
        placeholder="Check in at the front desk before going to the pump house." />
    </>
  );
}
