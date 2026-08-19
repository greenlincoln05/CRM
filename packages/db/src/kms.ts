/**
 * AWS KMS envelope for the field encryption key (ADR 0005).
 *
 * The 32-byte field key is never stored anywhere in its usable form. It is
 * encrypted ("wrapped") under a KMS customer managed key, and the ciphertext
 * is what lives in the deployment environment. At boot the application asks
 * KMS to unwrap it and holds the plaintext in process memory only.
 *
 * What this buys, precisely: the hosting dashboard holds DATABASE_URL and the
 * wrapped key. Anyone who gets into that account — a stolen session, a
 * compromised integration — has both halves of the OLD design and could
 * decrypt every gate code offline at leisure. With wrapping they have
 * ciphertext and a database, and still need IAM access to a specific KMS key
 * to make either useful.
 *
 * KMS is in the path of DEPLOYMENT, not in the path of a technician standing
 * at a gate in the rain. One unwrap per process at startup; reveals are local
 * AES after that. See ADR 0005 for why per-reveal KMS calls were rejected.
 *
 * The SDK is imported dynamically so that development, the ETL, and any build
 * without a wrapped key never load it.
 */

/**
 * Binds ciphertext to its purpose. KMS refuses to decrypt unless the same
 * context is supplied, so a blob wrapped for something else cannot be
 * substituted, and CloudTrail shows what the key was used for.
 */
const CONTEXT = { app: 'lcp', purpose: 'field-key' } as const;

/** Region for the KMS client. Explicit beats AWS's implicit resolution here. */
function region(): string {
  const r = process.env.LCP_KMS_REGION ?? process.env.AWS_REGION;
  if (!r) {
    throw new Error(
      'LCP_KMS_REGION (or AWS_REGION) must be set to use the wrapped field key.',
    );
  }
  return r;
}

async function client() {
  const { KMSClient } = await import('@aws-sdk/client-kms');
  return new KMSClient({ region: region() });
}

/**
 * Unwrap the field key. Input is base64 KMS ciphertext; output is the raw
 * 32-byte key.
 *
 * KMS identifies the key from the ciphertext itself, so no key id is needed
 * here — which also means a ciphertext from the wrong key fails as an access
 * or decrypt error rather than silently producing garbage.
 */
export async function unwrapFieldKey(wrappedBase64: string): Promise<Buffer> {
  const { DecryptCommand } = await import('@aws-sdk/client-kms');
  const kms = await client();

  // KeyId is passed even though the ciphertext names its own key: without it,
  // anyone able to set LCP_FIELD_KEY_WRAPPED could substitute a blob wrapped
  // under a key they control and the app would adopt an attacker-chosen field
  // key. Whoever can write env vars already owns the deployment, so this is
  // depth, not a door — but AWS's own guidance is to always pass it.
  const keyId = process.env.LCP_KMS_KEY_ID;

  let plaintext: Uint8Array | undefined;
  try {
    const out = await kms.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(wrappedBase64, 'base64'),
      EncryptionContext: { ...CONTEXT },
      ...(keyId ? { KeyId: keyId } : {}),
    }));
    plaintext = out.Plaintext;
  } catch (err: any) {
    // Be loud and specific: at boot, "cannot reach KMS" and "not allowed to
    // use this key" are different problems with different fixes, and the
    // difference is invisible from a generic error.
    throw new Error(
      `KMS could not unwrap LCP_FIELD_KEY_WRAPPED (${err?.name ?? 'error'}): ${err?.message ?? err}. ` +
      `Check the IAM role has kms:Decrypt on the key, that LCP_KMS_REGION is right, ` +
      `and that the key was wrapped by this tool (the encryption context must match).`,
    );
  }

  if (!plaintext) throw new Error('KMS returned no plaintext for the wrapped field key.');
  const key = Buffer.from(plaintext);
  if (key.length !== 32) {
    throw new Error(`Unwrapped field key is ${key.length} bytes, expected 32.`);
  }
  return key;
}

/**
 * Wrap a raw 32-byte key under the KMS key. Used once, by the key tool, when
 * the production key is generated — never on a request path.
 */
export async function wrapFieldKey(raw: Buffer, keyId: string): Promise<string> {
  if (raw.length !== 32) throw new Error(`Key must be 32 bytes, got ${raw.length}.`);
  const { EncryptCommand } = await import('@aws-sdk/client-kms');
  const kms = await client();
  const out = await kms.send(new EncryptCommand({
    KeyId: keyId,
    Plaintext: raw,
    EncryptionContext: { ...CONTEXT },
  }));
  if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext.');
  return Buffer.from(out.CiphertextBlob).toString('base64');
}
