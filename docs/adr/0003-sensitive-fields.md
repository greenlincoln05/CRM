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

Points 4-5 remain open, and point 5 becomes urgent the moment photo capture
ships.

Authentication closed 2026-08-18 (ADR 0004 accepted, Clerk): every data
surface — the pages, the search API, and the reveal endpoint — resolves a real
`app_user` server-side before touching data, and the reveal records `user_id`
in the log. Development on the embedded database runs as an auto-provisioned
dev identity (never in production builds); a deployment with `DATABASE_URL`
set and missing or half-configured Clerk keys rejects all of these surfaces —
it fails closed instead of becoming a decrypt oracle or an open customer
browser. The Clerk path itself is written but unexercised until an instance
exists and keys are issued.

Two conditions of that model, decided here:
- **The Clerk instance must be invite-only** (public sign-ups disabled).
  First sign-in auto-provisions an active staff account, and any active
  account can reveal any gate code — so "can sign in" must mean "works here."
- **The reveal is deliberately role-agnostic today.** Any active user, any
  role, any property, every reveal logged. With ~30 invited employees the
  audit trail is the control; per-job scoping (point 1's "assigned job"
  wording) arrives with dispatch in Phase 2, when jobs exist to scope to.

Still open, and blocking before real technicians use this:
- **Key custody.** `LCP_FIELD_KEY` must be backed up somewhere that is neither
  this repository nor the database backup. Stored together, the encryption buys
  nothing; lost together, the gate codes are unrecoverable. ADR 0005 proposes
  the mechanism.

## Consequences

A stolen database backup should not be a stolen set of house keys.

This also affects the AI features in Phase 4: property summaries must be
generated from a filtered view, never from `SELECT *`.
