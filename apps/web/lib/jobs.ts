/**
 * The words and dates a job is described with, in one place.
 *
 * Two screens read work orders - the customer's record and the day board - and
 * a job that is "en_route" on one and "en route" on the other is two things to
 * the person reading them. Nothing here touches the database, so it can be
 * imported by a page, a field set, or eventually a client component without
 * dragging the driver along.
 */

/**
 * Mirrors WORK_ORDER_TYPES and WORK_ORDER_PRIORITIES in @lcp/db, the same way
 * ENTERABLE on the customer page mirrors ENTERABLE_KINDS: retyped here so this
 * module stays free of the database package, and checked where it lands. The
 * server rejects a value that is not in its own list, so a label that drifts is
 * a cosmetic bug rather than a bad row.
 */
export const JOB_TYPES: readonly (readonly [string, string])[] = [
  ['service', 'Service call'],
  ['opening', 'Opening'],
  ['closing', 'Closing'],
  ['delivery', 'Delivery'],
  ['install', 'Install'],
  ['water_test', 'Water test'],
  ['inspection', 'Inspection'],
];

export const JOB_PRIORITIES: readonly (readonly [string, string])[] = [
  ['low', 'Low'], ['normal', 'Normal'], ['urgent', 'Urgent'],
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(JOB_TYPES);

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'scheduled',
  en_route: 'en route',
  on_site: 'on site',
  complete: 'complete',
  incomplete: 'incomplete',
  cancelled: 'cancelled',
};

export function jobTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

export function jobStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

/**
 * Badge colour by what the status means for the day, not by how far along it
 * is: green for anything moving or finished, amber for a visit that happened
 * and did not finish, red for one nobody is driving to.
 */
export function jobStatusClass(status: string): string {
  switch (status) {
    case 'complete':
    case 'en_route':
    case 'on_site':
      return 'badge accent';
    case 'incomplete':
      return 'badge warn';
    case 'cancelled':
      return 'badge bad';
    default:
      return 'badge';
  }
}

/**
 * Whether the job can still be moved or called off.
 *
 * rescheduleWorkOrder and cancelWorkOrder both refuse a finished or cancelled
 * job, and offering a control that can only produce an error is worse than not
 * offering it. The rule still lives in the write layer; this is what the page
 * uses to decide whether to draw the button.
 */
export function jobIsOpen(status: string): boolean {
  return status !== 'complete' && status !== 'cancelled';
}

/** The shop is in Vermont, and "today" means today there. */
export const SHOP_TZ = 'America/New_York';

const pad = (n: number) => String(n).padStart(2, '0');

/** Today as the `date` column spells it, in the shop's timezone. */
export function today(): string {
  // en-CA formats as YYYY-MM-DD, which is what a date column and a
  // <input type="date"> both want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Only a date, and only a date. What arrives in a URL is not to be trusted. */
export function parseDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const probe = new Date(y, m - 1, d, 12);
  const round = probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  return round ? raw : null;
}

/** The day before or after, for the board's arrows. */
export function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + days, 12);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * A YYYY-MM-DD the way a person says it.
 *
 * Built from the parts at local noon rather than handed to `new Date(iso)`,
 * which parses a bare date as UTC midnight and renders the day before in
 * Eastern - the same trap the ETL pins around.
 */
export function fmtDay(iso: string | null, opts?: Intl.DateTimeFormatOptions): string | null {
  if (!iso) return null;
  const parsed = parseDay(iso);
  if (!parsed) return iso;
  const [y, m, d] = parsed.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-US', opts ?? {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}
