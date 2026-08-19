/**
 * Field-level encryption for the handful of columns that are the means of
 * physical entry to customers' homes: gate codes and lockbox codes.
 *
 * ADR 0003. Encryption happens HERE, in the application, so the key never
 * reaches Postgres as a query parameter and never lands in a query log. The
 * database stores only ciphertext; a stolen backup is not a stolen set of
 * house keys.
 *
 * NOTE — this file is a reconstruction (2026-08-18). The original was written
 * for commit 56bf5be but never pushed, and no clone of it survives. The wire
 * format below satisfies every surviving call site (the `v1:` prefix the demo
 * asserts, null passthrough in the ETL, throw-on-bad-key in the reveal route),
 * but ciphertext written by the ORIGINAL implementation is NOT guaranteed to
 * decrypt under this one. Only synthetic demo data ever existed, so nothing of
 * value is lost — re-run `npm run etl -- demo` to re-encrypt dev data.
 *
 * Where the key comes from, in order (see initFieldKey below):
 *
 *   1. LCP_FIELD_KEY_WRAPPED — KMS ciphertext, unwrapped once at startup.
 *      This is production (ADR 0005).
 *   2. LCP_FIELD_KEY — raw base64. Simple, and weaker: it sits in the same
 *      dashboard as DATABASE_URL, so one account compromise yields both
 *      halves. Fine for a staging box, not for real gate codes.
 *   3. A generated dev key on embedded PGlite, so the quick start needs no
 *      configuration at all.
 *
 * Wire format, version 1:
 *
 *   "v1:" + base64( iv[12] || ciphertext || gcmTag[16] )
 *
 * AES-256-GCM. A fresh random IV per value; the GCM tag means tampering with
 * the ciphertext fails loudly at decrypt rather than yielding garbage.
 */
import {
  createCipheriv, createDecipheriv, randomBytes,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRepoEnv, repoRoot } from './env.js';

const PREFIX = 'v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Resolve the 32-byte field key.
 *
 * Order:
 *   1. LCP_FIELD_KEY (base64, 32 bytes) — required whenever DATABASE_URL is
 *      set, i.e. against any real Postgres. Production never falls through.
 *   2. Dev fallback, PGlite only: a generated key persisted at
 *      `.pgdata/dev-field-key`. The quick start ("clone, install, demo") has
 *      to work with no .env, and the web dev server has to decrypt what the
 *      demo pipeline encrypted in a different process — so the dev key must
 *      be stable across processes, not ephemeral. Keeping it inside the
 *      gitignored PGlite directory is acceptable ONLY because dev data is
 *      synthetic; ADR 0005 governs custody of the real key.
 */
/**
 * Resolve the field key, including the async KMS path, and cache it.
 *
 * Call this once during startup, and before the first encrypt or decrypt in
 * any process that might use a wrapped key — the reveal endpoint, the ETL.
 * It is idempotent and cheap after the first call, so calling it defensively
 * on a request path is fine; it is one unwrap per process, not per request.
 *
 * Deliberately NOT called lazily from inside encryptField/decryptField: those
 * are synchronous at every call site, and making them async would ripple
 * through the ETL transform for no security gain. An explicit boot step also
 * means a KMS misconfiguration fails at startup with a clear message rather
 * than at the moment a technician asks for a gate code.
 */
export async function initFieldKey(): Promise<void> {
  if (cachedKey) return;
  if (inFlight) return inFlight; // N cold requests must not mean N KMS calls
  inFlight = (async () => {
    loadRepoEnv();
    const wrapped = process.env.LCP_FIELD_KEY_WRAPPED;
    if (wrapped) {
      assertOneKeySource();
      const { unwrapFieldKey } = await import('./kms.js');
      cachedKey = await unwrapFieldKey(wrapped);
      return;
    }
    fieldKey(); // no wrapped key: the synchronous sources are authoritative
  })();
  try {
    await inFlight;
  } finally {
    // Clear on failure too: a transient KMS outage must not poison the process.
    inFlight = null;
  }
}

/**
 * Both key sources configured is not a preference to resolve quietly — it
 * means the raw key is still sitting in the deployment dashboard, which is
 * the exact condition ADR 0005 exists to eliminate. Say so.
 */
function assertOneKeySource(): void {
  if (process.env.LCP_FIELD_KEY_WRAPPED && process.env.LCP_FIELD_KEY) {
    throw new Error(
      'Both LCP_FIELD_KEY_WRAPPED and LCP_FIELD_KEY are set. Remove the raw ' +
      'LCP_FIELD_KEY from the environment — leaving it there defeats the ' +
      'wrapping (ADR 0005). Keep the wrapped form.',
    );
  }
}

function fieldKey(): Buffer {
  if (cachedKey) return cachedKey;
  loadRepoEnv();
  assertOneKeySource();

  // Checked FIRST, before the raw key. If a deployment is mid-migration to
  // ADR 0005 and still carries both, resolving to the raw key here would let
  // the process encrypt real gate codes under the key being retired — and
  // because both resolvers early-return on the cache, whichever ran first
  // would win for the life of the process. The wrapped key is authoritative.
  if (process.env.LCP_FIELD_KEY_WRAPPED) {
    throw new Error(
      'LCP_FIELD_KEY_WRAPPED is set but the key has not been unwrapped. ' +
      'Await initFieldKey() during startup before encrypting or decrypting.',
    );
  }

  const fromEnv = process.env.LCP_FIELD_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `LCP_FIELD_KEY must be 32 bytes of base64 (got ${key.length}). ` +
        `Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    cachedKey = key;
    return key;
  }

  if (process.env.DATABASE_URL) {
    throw new Error(
      'Neither LCP_FIELD_KEY_WRAPPED nor LCP_FIELD_KEY is set. One is required ' +
      'against a real database — the dev-key fallback exists only for embedded ' +
      'PGlite. See .env.example and docs/adr/0005-key-custody.md.',
    );
  }

  // Explicit, not implied. Without DATABASE_URL the database is PGlite anyway,
  // so this is already unreachable in a real deployment — but an invariant that
  // rests on the absence of the very variable you'd worry about is worth
  // stating outright. Same rule as the dev identity in apps/web/lib/auth.ts.
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error(
      'Refusing to generate a development field key in a production runtime. ' +
      'Set LCP_FIELD_KEY_WRAPPED (see docs/adr/0005-key-custody.md).',
    );
  }

  // Dev fallback: generate once, persist next to the dev database.
  const dir = process.env.PGLITE_DIR ?? resolve(repoRoot(), '.pgdata');
  const file = resolve(dir, 'dev-field-key');
  if (existsSync(file)) {
    // Validate BEFORE caching: a corrupt key must throw this helpful error on
    // every call, not just the first one in a long-lived dev-server process.
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`Corrupt dev field key at ${file}. Delete it and re-run the demo.`);
    }
    cachedKey = key;
    return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
  console.warn(`[crypto] no LCP_FIELD_KEY set — generated a DEV-ONLY key at ${file}`);
  cachedKey = key;
  return key;
}

/**
 * Encrypt one sensitive value. Null passes through as null, so callers can
 * write `encryptField(cleanText(...))` without branching — most properties
 * have no gate code, and "no code" must stay visibly distinct from "code we
 * cannot read".
 */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', fieldKey(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, ct, cipher.getAuthTag()]);
  return PREFIX + packed.toString('base64');
}

/**
 * Decrypt one value produced by encryptField().
 *
 * Throws on the wrong key, a truncated value, or tampered ciphertext — all
 * three mean something is genuinely wrong, and the reveal route turns the
 * throw into a clear "check LCP_FIELD_KEY" rather than an empty box.
 */
export function decryptField(enc: string | null | undefined): string | null {
  if (enc === null || enc === undefined || enc === '') return null;
  if (!enc.startsWith(PREFIX)) {
    throw new Error(`Unrecognized ciphertext format (expected "${PREFIX}" prefix)`);
  }
  const packed = Buffer.from(enc.slice(PREFIX.length), 'base64');
  if (packed.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short to contain iv + data + tag');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(packed.length - TAG_LEN);
  const ct = packed.subarray(IV_LEN, packed.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', fieldKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
