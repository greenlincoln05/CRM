/**
 * Validation for values a person is typing right now.
 *
 * This is deliberately NOT packages/etl/src/normalize.ts, and the difference is
 * the whole point. The ETL normalizers coerce whatever they are given and file
 * an import_issue, because a migration that halts on the first bad phone number
 * never finishes and twenty-year-old data cannot be re-typed.
 *
 * A person at the counter can be asked. So these reject instead: a phone number
 * that does not make sense comes back as a message next to the field, while the
 * customer is still standing there, rather than becoming a null and a row in a
 * worklist nobody reads until Thursday.
 *
 * The one thing that must stay identical across both is the output format of
 * formatPhone(): customer.search_text indexes phone digits, and a number stored
 * in a different shape by the counter than by the migration is a number staff
 * cannot find.
 */

/** A message meant to be shown to the person who typed it, next to the field. */
export class WriteError extends Error {
  readonly field: string | undefined;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'WriteError';
    this.field = field;
  }
}

export function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

export function required(v: unknown, field: string, label: string): string {
  const s = clean(v);
  if (!s) throw new WriteError(`${label} is required.`, field);
  return s;
}

/**
 * US phone, formatted to match what the migration produces.
 *
 * The 7-digit case assumes 802 exactly as the ETL does - staff still write
 * local numbers that way, and the store is in Vermont.
 */
export function formatPhone(v: unknown, field = 'phone'): string | null {
  const raw = clean(v);
  if (!raw) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 7) digits = '802' + digits;

  if (digits.length !== 10) {
    throw new WriteError(
      `"${raw}" is not a phone number we can store. Use 10 digits, or 7 for a local 802 number.`,
      field,
    );
  }
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function normalizeEmail(v: unknown, field = 'email'): string | null {
  const raw = clean(v);
  if (!raw) return null;
  const email = raw.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    throw new WriteError(`"${raw}" is not a valid email address.`, field);
  }
  return email;
}

/** Leading zeros matter in New England; a 4-digit ZIP is a lost one. */
export function normalizeZip(v: unknown, field = 'postalCode'): string | null {
  const raw = clean(v);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  if (digits.length === 5) return digits;
  if (digits.length === 4) return `0${digits}`;

  throw new WriteError(`"${raw}" is not a usable ZIP code.`, field);
}

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI',
]);

const STATE_NAMES: Record<string, string> = {
  VERMONT: 'VT', 'NEW YORK': 'NY', 'NEW HAMPSHIRE': 'NH',
  MASSACHUSETTS: 'MA', MAINE: 'ME', CONNECTICUT: 'CT', QUEBEC: 'QC',
};

export function normalizeState(v: unknown, field = 'state'): string | null {
  const raw = clean(v);
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (US_STATES.has(up)) return up;
  if (STATE_NAMES[up]) return STATE_NAMES[up]!;
  throw new WriteError(`"${raw}" is not a state we recognize.`, field);
}

/** One of a fixed set, or a message naming what was allowed. */
export function oneOf<T extends string>(
  v: unknown, allowed: readonly T[], field: string, fallback?: T,
): T {
  const s = clean(v);
  if (!s) {
    if (fallback !== undefined) return fallback;
    throw new WriteError(`${field} is required.`, field);
  }
  if (!allowed.includes(s as T)) {
    throw new WriteError(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }
  return s as T;
}

/**
 * A chemistry reading, or null when that strip pad was not run.
 *
 * The range check is not pedantry: pH 78 is a typo for 7.8 that would otherwise
 * sit in the trend chart forever, and the trigger in migration 0008 means it
 * cannot be edited out afterwards.
 */
export function readingValue(
  v: unknown, field: string, label: string, min: number, max: number,
): string | null {
  const raw = clean(v);
  if (raw === null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) throw new WriteError(`${label} must be a number.`, field);
  if (n < min || n > max) {
    throw new WriteError(`${label} of ${n} is outside the plausible range (${min}-${max}).`, field);
  }
  return n.toFixed(2);
}

/**
 * A date-only value, pinned to local noon.
 *
 * Sprint 1 shipped a bug where date-only values stored at UTC midnight rendered
 * a day early in Eastern time. Noon is the fix, and it has to be applied on the
 * way in as well as on the way out.
 */
export function dateOnlyAtNoon(v: unknown, field: string): Date | null {
  const raw = clean(v);
  if (!raw) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) throw new WriteError(`"${raw}" is not a date (expected YYYY-MM-DD).`, field);

  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  if (Number.isNaN(d.getTime())) throw new WriteError(`"${raw}" is not a real date.`, field);
  return d;
}
