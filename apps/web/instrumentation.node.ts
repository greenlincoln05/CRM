/**
 * Node-runtime startup: unwrap the field encryption key.
 *
 * This is the whole point of ADR 0008's design — KMS belongs in the path of
 * deployment, not in the path of a technician standing at a gate in the rain.
 * A bad region, a missing kms:Decrypt grant, or an unreachable KMS shows up
 * here, in the deploy logs before traffic, rather than as a failed reveal for
 * the first person who needs a code.
 *
 * It does not throw. An instance that refuses to boot takes down search and
 * the timeline too, and neither needs the key; the reveal endpoint calls
 * initFieldKey() again (idempotent) and fails there, alone, with the real
 * error and a 503.
 */
import { initFieldKey } from '@lcp/db';

if (process.env.LCP_FIELD_KEY_WRAPPED) {
  try {
    await initFieldKey();
    console.log('[startup] field key unwrapped from KMS');
  } catch (err: any) {
    console.error('[startup] FIELD KEY UNAVAILABLE — gate code reveals will fail:', err?.message);
  }
}
