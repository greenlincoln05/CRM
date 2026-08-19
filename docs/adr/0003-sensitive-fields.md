# 0003 — Sensitive field handling

Status: accepted, implemented
Date: 2026-08-18

## Context

The property profile deliberately stores gate codes, lockbox codes, alarm
information, and access instructions. That is the point of the feature: a
technician should know how to get in before arriving.

It also means the database holds the means of physical entry to several hundred
Vermont and New York homes.

## Decision

1. `property.gate_code` and similar fields are never displayed in list views,
   only on a property a technician has an assigned job for.
2. Access to these fields is logged.
3. Before the technician mobile app ships (Sprint 3), these columns get
   column-level encryption with the key held outside the database.
4. They are excluded from any export, report, or AI context window.
5. Photo storage keys are unguessable; images are served through signed,
   short-lived URLs, never public bucket paths.

## Status

Point 3 is done, and was done before any mobile work started. Gate codes are
AES-256-GCM ciphertext in `property.gate_code_enc`, encrypted in the application
(`packages/db/src/crypto.ts`) so the key never reaches Postgres as a query
parameter and never lands in a query log. The plaintext column is dropped, not
kept alongside.

Point 2 is done: every reveal writes to `sensitive_access_log`, which is
append-only by trigger. The log is written before the code is returned, so a
reveal that fails to record does not succeed.

Point 1 is done in the web app: the page payload carries a boolean, never the
code. Revealing is an explicit POST for one property, and the value re-hides
after a minute — the realistic risk is a browser left open on the counter, not
an attacker.

Two list surfaces now exist and they are deliberately not the same. The office
board (`getDaySchedule`) writes its SELECT list out by hand and carries only
`has_gate_code` — it is a screen showing forty houses to someone behind a
counter. `/api/tech/day` does carry `access_notes` and `pet_notes`, on purpose:
it is one technician's own assigned day, and knowing about the dog before
opening the gate is the point of the property profile. The gate code itself is
in neither, and still comes one property at a time through the logged reveal.

**The invariant is enforced on columns, and free text goes around it.** The
office board also renders `instructions`, `work_performed` and
`incomplete_reason`, which are typed by people. A technician standing at a gate
that did not open will reasonably type "code on file didn't work, owner says
it's now 1234" — plaintext, one table over from the encrypted column, and worse,
`instructions` and a cancellation reason are copied verbatim into timeline
events, which are append-only by trigger and can never be redacted. The
mitigation is a warning next to those fields and keeping full free text off list
views; neither is a guarantee. If a code ever does land in a timeline row,
removing it takes a migration.

Point 4 is half done. Exports and reports are covered:
`packages/etl/src/sensitive.ts` encrypts gate-code-shaped keys at the staging
boundary and strips them from `import_issue` payloads, which are read and pasted
around. The AI context window half has no code yet and arrives with Phase 4.

Point 5 was written as a future trigger and that trigger has fired — photo
capture shipped with the technician PWA. Most of the substance is met: storage
keys are `YYYY/MM/<uuid v4>.<ext>` and unguessable, the key is never a
browser-facing URL, and bytes are served behind a session rather than from a
public bucket. What is not done is the signed, short-lived URL: the GET is
session-gated but not scoped to the viewer's job, and responses are cached
`immutable` for a year.

Authentication closed 2026-08-18 (ADR 0005, staff authentication): the
reveal endpoint refuses without a session and records a real `app_user` id, so
the log answers "who" with a name. A Clerk implementation was written the same
day against ADR 0007 and then deleted — Sprint 2's PIN-and-session scheme
shipped first, the write path depends on it, and two auth systems in one app is
worse than either. ADR 0007 still names an identity provider as the long-term
answer, and `app_user.external_id` is still there for it.

One condition of the current model, decided here:
- **The reveal is deliberately role-agnostic.** Any active user, any role, any
  property, every reveal logged. With roughly ten staff and no self-service
  signup the audit trail is the control; per-job scoping (point 1's "assigned
  job" wording) arrives with dispatch, when jobs exist to scope to.

  **That condition has come due.** Dispatch shipped 2026-08-19: work orders
  carry `assigned_user_id` and a scheduled date, so there are now jobs to scope
  to. `/api/tech/photo` already performs exactly this check — a non-supervisor
  requesting someone else's job gets a 403 — while `/api/gate-code` remains
  role-agnostic. The inconsistency is now visible in the code and should be
  closed deliberately rather than left to drift.

Still open, and blocking before real technicians use this:
- **Key custody.** `LCP_FIELD_KEY` must be backed up somewhere that is neither
  this repository nor the database backup. Stored together, the encryption buys
  nothing; lost together, the gate codes are unrecoverable. ADR 0008
  specifies the mechanism and it is implemented; what remains is operational —
  create the KMS key and seal the paper copy.

## Consequences

A stolen database backup should not be a stolen set of house keys.

This also affects the AI features in Phase 4: property summaries must be
generated from a filtered view, never from `SELECT *`.
