# 0005 — Custody of the field encryption key

Status: accepted
Date: 2026-08-18 (proposed), 2026-08-18 (accepted)

## Context

ADR 0003 encrypts gate codes, lockbox codes, and alarm information with
AES-256-GCM in the application, and leaves one thing explicitly open:

> `LCP_FIELD_KEY` must be backed up somewhere that is neither this repository
> nor the database backup. Stored together, the encryption buys nothing; lost
> together, the gate codes are unrecoverable.

That is two failure modes pulling in opposite directions. Store the key too
close to the data and a single stolen backup is a set of house keys for several
hundred homes. Store it too far away, or in only one place, and a lost laptop
means nobody can ever open an encrypted record again.

The obvious answer is an environment variable in the hosting provider. It
satisfies the letter of ADR 0003 — not in the repository, not in the database
backup — and it is what most projects do.

It is weak in a specific way worth naming. The hosting dashboard holds both the
key and `DATABASE_URL`. Anyone who gets into that account, including through a
stolen session or a compromised third-party integration, has both halves and can
decrypt every gate code offline at leisure. The key also cannot be rotated
without a re-encryption pass that nothing currently supports, so in practice it
never gets rotated.

## Decision

Wrap the key rather than storing it.

`LCP_FIELD_KEY` is generated once, encrypted under an **AWS KMS** customer
managed key, and the resulting ciphertext is what lives in the hosting
environment variable. At startup the application calls KMS to unwrap it and
holds the plaintext key in process memory only. `packages/db/src/crypto.ts`
keeps working exactly as it does — it receives a 32-byte key and does not care
where it came from.

Three copies of the ability to decrypt exist, deliberately:

1. **KMS**, which holds the wrapping key and never releases it. Access is an IAM
   role scoped to `Decrypt` on that one key.
2. **The wrapped key**, in the Vercel environment. Useless on its own.
3. **An offline copy of the raw key**, written down and sealed — a safe, or a
   safe deposit box. Not in a password manager that syncs to the same laptop
   that has the database credentials.

Copy three is the disaster copy. It exists because AWS accounts get locked out,
and because the alternative to having it is telling several hundred customers
their gate codes are gone.

## Why not per-reveal KMS calls

A stricter version calls KMS on every gate code reveal, producing an independent
audit trail in CloudTrail that the application cannot forge.

That is real value, and it is already covered. `sensitive_access_log` is
append-only by trigger, and the reveal writes to it before returning the code —
so a reveal that fails to record does not succeed. A second audit trail would
mostly duplicate a good one, at the cost of a network round trip and a hard
dependency on KMS availability for a routine field operation.

Boot-time unwrapping puts KMS in the path of deployment rather than in the path
of a technician standing at a gate in the rain. That is the correct place for it.

## Consequences

A stolen database backup is now genuinely useless without a second, separate
compromise. That was the stated goal of ADR 0003 and this is what actually
achieves it.

Rotation becomes possible: KMS rotates the wrapping key on its own schedule
without touching any ciphertext, and rotating the field key itself is a
re-encryption job that can now be written against a stable interface.

The cost is one more vendor for roughly a dollar a month, and a startup
dependency — if KMS is unreachable at boot, the app starts but cannot decrypt
gate codes. It should say so clearly in that state rather than returning errors
that look like missing data.

The offline copy is the part most likely to be skipped, and it is the part that
matters most on the worst day. It should be done at the same time the key is
generated, not later.

## Status of the implementation

Implemented 2026-08-18. `packages/db/src/kms.ts` wraps and unwraps;
`initFieldKey()` in `crypto.ts` resolves the key once per process and
`apps/web/instrumentation.node.ts` calls it at startup, so a bad grant or
region fails in the deploy logs rather than at a gate. `npm run key --
generate` mints, wraps, self-verifies the round trip, and prints the raw key
once — to stderr, refusing to run in CI or through a pipe, and refusing to
overwrite an existing key without `--force`.

Copies 1 and 2 are enforced by code. **Copy 3 — the sealed offline key — is a
procedure, not a mechanism.** Nothing verifies it happened, and there is
deliberately no command to re-print the key later. This ADR predicted it is
the part most likely to be skipped; the tooling asks loudly and can do no more.

One correction to the reasoning above, found while implementing: the claim
that a stolen backup becomes useless was not true of this repository when it
was written. The migration pipeline landed Evosus rows verbatim, so
`legacy_row.payload` held every gate code in cleartext one table over from the
encrypted column, and `import_issue.payload` copied them again on every
data-quality finding. Both are now protected at the boundary
(`packages/etl/src/sensitive.ts`): gate codes are encrypted before they reach
staging, and redacted entirely from issue payloads. The demo asserts it.

Rotation remains future work, and it is now load-bearing: `generate --force`
orphans existing ciphertext because no re-encryption pass exists.

## Still open

Authentication was the other half of this and closed first — the reveal
endpoint authenticates and records a real `app_user` id (ADR 0004, accepted).
What remains here is operational, not code: create the KMS key, grant the app's
role `kms:Decrypt` on it and nothing else, run `npm run key -- generate`, and
seal the paper copy.
