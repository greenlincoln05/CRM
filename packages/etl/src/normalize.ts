/**
 * Normalizers for twenty years of hand-typed data.
 *
 * Everything here returns a value AND a list of issues rather than throwing.
 * A migration that halts on the first bad phone number never finishes; a
 * migration that silently drops bad rows loses history nobody notices is gone
 * until a customer asks. So: convert what we can, record what we could not, and
 * let a human look at the report.
 */

export type Issue = { code: string; severity: 'info' | 'warn' | 'error'; message: string };

export type Normalized<T> = { value: T; issues: Issue[] };

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR','VI',
]);

export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (s === '' || s === 'NULL' || s === 'null' || s === 'N/A' || s === '.') return null;
  return s;
}

/**
 * US phone numbers. Twenty years of data will contain "802-555-1234 x12",
 * "(802) 555 1234 cell", "8025551234/8025559999", and "call after 5".
 */
export function normalizePhone(v: unknown): Normalized<string | null> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: null, issues };

  // Take the first number if the field crams in two.
  const firstChunk = raw.split(/[\/;]| or /i)[0] ?? raw;
  const digits = firstChunk.replace(/\D/g, '');

  if (digits.length === 0) {
    issues.push({ code: 'PHONE_NO_DIGITS', severity: 'warn', message: `Phone field has no digits: "${raw}"` });
    return { value: null, issues };
  }

  let core = digits;
  if (core.length === 11 && core.startsWith('1')) core = core.slice(1);

  if (core.length === 7) {
    // Local-only number from the era before area codes were always dialed.
    issues.push({ code: 'PHONE_7_DIGIT', severity: 'warn', message: `7-digit phone, assuming 802: "${raw}"` });
    core = '802' + core;
  }

  if (core.length !== 10) {
    issues.push({ code: 'PHONE_BAD_LENGTH', severity: 'warn', message: `Unusable phone "${raw}" (${core.length} digits)` });
    return { value: null, issues };
  }

  if (raw !== firstChunk) {
    issues.push({ code: 'PHONE_MULTIPLE', severity: 'info', message: `Multiple numbers in one field, kept first: "${raw}"` });
  }

  return { value: `(${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}`, issues };
}

export function normalizeEmail(v: unknown): Normalized<string | null> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: null, issues };

  const first = raw.split(/[;,\s]+/)[0] ?? raw;
  const email = first.toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    issues.push({ code: 'EMAIL_INVALID', severity: 'warn', message: `Not a valid email: "${raw}"` });
    return { value: null, issues };
  }
  if (first !== raw) {
    issues.push({ code: 'EMAIL_MULTIPLE', severity: 'info', message: `Multiple emails, kept first: "${raw}"` });
  }
  return { value: email, issues };
}

/** ZIP normalization. Leading zeros matter in New England and Excel eats them. */
export function normalizeZip(v: unknown): Normalized<string | null> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: null, issues };

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return { value: null, issues };

  if (digits.length === 9) return { value: `${digits.slice(0, 5)}-${digits.slice(5)}`, issues };
  if (digits.length === 5) return { value: digits, issues };

  // "5446" is Colchester VT with the leading zero eaten by a spreadsheet.
  if (digits.length === 4) {
    issues.push({ code: 'ZIP_LEADING_ZERO', severity: 'info', message: `Restored leading zero: "${raw}" -> 0${digits}` });
    return { value: `0${digits}`, issues };
  }

  issues.push({ code: 'ZIP_INVALID', severity: 'warn', message: `Unusable ZIP: "${raw}"` });
  return { value: null, issues };
}

export function normalizeState(v: unknown): Normalized<string | null> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: null, issues };

  const up = raw.toUpperCase();
  if (US_STATES.has(up)) return { value: up, issues };

  const byName: Record<string, string> = {
    VERMONT: 'VT', 'NEW YORK': 'NY', 'NEW HAMPSHIRE': 'NH',
    MASSACHUSETTS: 'MA', MAINE: 'ME', CONNECTICUT: 'CT', QUEBEC: 'QC',
  };
  if (byName[up]) return { value: byName[up], issues };

  issues.push({ code: 'STATE_UNKNOWN', severity: 'warn', message: `Unrecognized state: "${raw}"` });
  return { value: null, issues };
}

/**
 * Dates. Legacy systems produce ISO strings, US m/d/yyyy, two-digit years, and
 * the classic 1900-01-01 placeholder meaning "blank".
 */
export function normalizeDate(v: unknown): Normalized<string | null> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: null, issues };

  let d: Date | null = null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const us = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(raw);

  if (iso) {
    d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
  } else if (us) {
    let year = Number(us[3]);
    if (year < 100) {
      // Two-digit years: 70-99 -> 1900s, 00-69 -> 2000s.
      year += year >= 70 ? 1900 : 2000;
      issues.push({ code: 'DATE_2DIGIT_YEAR', severity: 'info', message: `Expanded 2-digit year in "${raw}" to ${year}` });
    }
    d = new Date(Date.UTC(year, Number(us[1]) - 1, Number(us[2])));
  } else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }

  if (!d || Number.isNaN(d.getTime())) {
    issues.push({ code: 'DATE_UNPARSEABLE', severity: 'warn', message: `Could not parse date: "${raw}"` });
    return { value: null, issues };
  }

  const year = d.getUTCFullYear();
  if (year <= 1901) {
    issues.push({ code: 'DATE_PLACEHOLDER', severity: 'info', message: `Treating placeholder date as empty: "${raw}"` });
    return { value: null, issues };
  }
  if (year < 1980 || year > new Date().getFullYear() + 5) {
    issues.push({ code: 'DATE_OUT_OF_RANGE', severity: 'warn', message: `Date outside plausible range: "${raw}"` });
    return { value: null, issues };
  }

  return { value: d.toISOString().slice(0, 10), issues };
}

/**
 * Split a single name field into first/last. Evosus-era systems often store
 * "Smith, John & Mary" or "John and Mary Smith" in one column.
 */
export function splitName(v: unknown): Normalized<{ first: string | null; last: string | null }> {
  const issues: Issue[] = [];
  const raw = cleanText(v);
  if (!raw) return { value: { first: null, last: null }, issues };

  if (/[&+]| and /i.test(raw)) {
    issues.push({ code: 'NAME_MULTIPLE_PEOPLE', severity: 'info', message: `Two people in one name field: "${raw}" - review for a second contact` });
  }

  if (raw.includes(',')) {
    const [last, rest] = raw.split(',', 2);
    return { value: { first: cleanText(rest), last: cleanText(last) }, issues };
  }

  const parts = raw.split(' ').filter(Boolean);
  if (parts.length === 1) {
    issues.push({ code: 'NAME_SINGLE_TOKEN', severity: 'info', message: `Single-token name: "${raw}"` });
    return { value: { first: null, last: parts[0]! }, issues };
  }

  return { value: { first: parts.slice(0, -1).join(' '), last: parts.at(-1)! }, issues };
}

/** Detect a business rather than a household, so kind is set correctly. */
export function looksLikeCompany(name: string | null): boolean {
  if (!name) return false;
  return /\b(inc|llc|ltd|corp|co|company|assoc|association|club|resort|inn|hotel|condo|properties|management|mgmt|realty|school|church|town of|city of|state of|dept|department)\b\.?/i
    .test(name);
}
