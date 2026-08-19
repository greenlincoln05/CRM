import {
  createCipheriv, createDecipheriv, randomBytes, timingSafeEqual,
} from 'node:crypto';

/**
 * Field-level encryption for the columns that open customers' gates.
 *
 * ADR 0003: this database holds the means of physical entry to several hundred
 * Vermont and New York homes. A stolen backup must not be a stolen set of keys.
 *
 * Encryption happens in the application, not in the database, so the key never
 * travels to Postgres as a query parameter and never lands in a query log. The
 * database only ever sees ciphertext.
 *
 * AES-256-GCM: authenticated, so a tampered value fails loudly instead of
 * decrypting to garbage. Format is base64 of iv(12) || tag(16) || ciphertext,
 * with a short version prefix so the scheme can be rotated later without
 * guessing what an old row was encrypted with.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MissingFieldKeyError extends Error {
  constructor() {
    super(
      'LCP_FIELD_KEY is not set, and this operation touches an encrypted field ' +
      '(gate codes, access notes).\n\n' +
      'Generate one:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n\n' +
      'Put it in .env as LCP_FIELD_KEY. Back it up somewhere that is NOT this ' +
      'repository and NOT the database backup - if both are lost together, the ' +
      'gate codes are unrecoverable.',
    );
    this.name = 'MissingFieldKeyError';
  }
}

function getKey(): Buffer {
  const raw = process.env.LCP_FIELD_KEY;
  if (!raw) throw new MissingFieldKeyError();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `LCP_FIELD_KEY must decode to exactly 32 bytes, got ${key.length}. ` +
      'Generate a fresh one with randomBytes(32).toString("base64").',
    );
  }
  return key;
}

/** True when a key is configured, without throwing. For startup checks. */
export function fieldKeyConfigured(): boolean {
  try { getKey(); return true; } catch { return false; }
}

export function encryptField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), enc]);
  return `${VERSION}:${packed.toString('base64')}`;
}

export function decryptField(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const sep = stored.indexOf(':');
  const version = sep > 0 ? stored.slice(0, sep) : '';
  if (version !== VERSION) {
    throw new Error(`Unknown encrypted field version "${version}". Refusing to guess.`);
  }

  const packed = Buffer.from(stored.slice(sep + 1), 'base64');
  if (packed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Encrypted field is truncated or corrupt.');
  }

  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = packed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  // Throws if the ciphertext or tag was modified - that is the point.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Constant-time comparison, for any future case where a code is checked rather
 * than displayed. Kept here so nobody reaches for === on a secret.
 */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
