/**
 * Gate codes must not sit in cleartext anywhere, including the staging tables.
 *
 * ADR 0008 claims a stolen database backup is useless without a second,
 * separate compromise. That claim was false while the migration pipeline
 * landed Evosus rows verbatim: `legacy_row.payload->>'GateCode'` returned the
 * code for every property, permanently, one table over from the encrypted
 * column — and `import_issue.payload` copied the whole offending row again on
 * every data-quality finding.
 *
 * So the codes are encrypted at the boundary, on the way in, before anything
 * is written. `legacy_row` stays verbatim for every other field, which is what
 * makes re-running a transform free; this one class of field is the exception,
 * and it is the exception ADR 0003 already made for the same reason.
 *
 * Encrypting rather than dropping matters: the transform still needs the value
 * to populate `property.gate_code_enc`, and a redacted staging row would mean
 * re-extracting from Evosus to fix a mapping bug.
 */
import { encryptField } from '@lcp/db';

/**
 * Source column names that hold a means of physical entry. Matched
 * case-insensitively, and kept in sync with `gateCode` in mappings/evosus.ts.
 * When discovery reveals the real Evosus column, add it in both places.
 */
const SENSITIVE_KEYS = ['gatecode', 'accesscode', 'lockboxcode', 'alarmcode'];

/** Already-encrypted values carry the crypto module's version prefix. */
export function isEncrypted(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('v1:');
}

/**
 * Encrypt the sensitive fields of one legacy row, leaving everything else
 * untouched. Idempotent: a value that is already ciphertext passes through, so
 * re-landing the same row cannot double-encrypt it.
 */
export function protectRow(payload: Record<string, unknown>): Record<string, unknown> {
  let touched = false;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.includes(k.toLowerCase()) && typeof v === 'string' && v.trim() !== '' && !isEncrypted(v)) {
      out[k] = encryptField(v);
      touched = true;
    } else {
      out[k] = v;
    }
  }

  return touched ? out : payload;
}

/**
 * Strip sensitive fields entirely from a payload bound for `import_issue`.
 *
 * Different rule from landing, on purpose: the issue payload exists so a human
 * can eyeball a bad row in a triage report. Nobody triaging a malformed ZIP
 * needs the gate code, the report gets read and pasted around, and unlike
 * `legacy_row` nothing downstream reads this value back.
 */
export function redactForIssue(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) && v ? '[redacted]' : v;
  }
  return out;
}
