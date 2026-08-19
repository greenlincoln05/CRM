# 0005 — Staff authentication

Status: accepted, implemented
Date: 2026-08-18

## Context

Sprint 1 shipped a read-only app. Every row in the database had arrived through
the ETL and carried its Evosus provenance, so "who put this here" always had an
answer without anyone having to sign in.

Sprint 2 lets staff type into it. That changes the question. A customer record
that is wrong, a note that says something surprising, a gate code that changed
last Tuesday — the first thing anyone asks is who did it, and an app with no
identity cannot answer. ADR 0003 already named authentication as blocking before
real technicians use the system, and it is equally blocking before anyone can
edit a customer.

The constraint is that this is a shop, not a SaaS product. There are on the
order of ten staff, several of them seasonal. The machine at the counter is
shared and people walk away from it mid-task. Nobody is going to carry a
hardware token, and a password policy that requires a manager to reset something
during pool season will be worked around within a week.

An identity provider (Clerk, WorkOS) is the right long-term answer, and
`app_user.external_id` has been sitting in the schema for it since Phase 1. But
buying and wiring one is not a thing to do in the same sprint as the write path,
and the write path cannot ship without identity.

## Decision

Ship an interim credential now, shaped so that replacing it later is a deletion
rather than a migration.

1. **Email plus a PIN.** 4–12 digits, hashed with scrypt in `app_user.pin_hash`.
   Trivial PINs — a repeated digit, a run of consecutive digits — are refused.
2. **The lockout does the real work.** Five wrong attempts locks the account for
   fifteen minutes. A four-digit PIN is weak against unlimited guessing and
   entirely adequate against fifteen minutes per five tries.
3. **Server-side sessions**, in `app_session`. Twelve-hour expiry, which covers
   the longest shift without expiring mid-customer.
4. **The cookie holds a random token; the table holds only its SHA-256.** A
   stolen database backup contains no usable session.
5. **No self-service signup.** Accounts are created from the command line
   (`npm run db:user`). There is no admin screen, because an admin screen is a
   login page nobody guards on the machine that holds every customer's gate
   code.
6. **Every write carries the actor**, by id and by denormalized label. The id is
   the truth; the label keeps a 2026 note readable in 2040 after that person's
   account is gone — exactly what the migration already relies on for legacy
   rows naming employees who no longer exist.

## Why sessions are a table rather than a signed cookie

A self-contained signed cookie needs no storage and cannot be revoked. The
realistic failures here are all revocation:

- the shop laptop that went home in somebody's bag
- the seasonal hire who finished in October
- a PIN change, after which every session opened with the old one should end

All three need a sign-out that works without the browser's cooperation. That
needs server-side state, and one indexed lookup per request is not the expensive
part of rendering a customer page.

## What this is not

- **Not authorization.** The only role check in the system is that hiding a
  timeline entry requires manager or admin. Everything else any signed-in
  member of staff may do, which matches how the shop actually works.
- **Not defence against a determined attacker on the network.** The counter
  machine runs this over plain HTTP today, so the session cookie is `secure`
  only in production. Putting TLS in front of it is a deployment task, not a
  code one, and it is a prerequisite for the technician app leaving the
  building.
- **Not multi-tenant.** One shop, one set of staff.

## Consequences

`sensitive_access_log` now records a real user id rather than the
`unauthenticated-dev` placeholder ADR 0003 flagged, so "who had our gate code"
has an answer with a name in it. That was the blocking item on the technician
app, and it is closed.

Middleware does a cookie-presence check only. It runs on the edge runtime where
there is no database driver, so it cannot verify a session, and it is not the
security boundary — `requireUser()` in each server component is, and it resolves
the token against `app_session` on every request. A forged cookie gets past the
middleware and straight into a failed lookup.

Swapping in an identity provider means filling in `external_id`, pointing
`verifySession` at the provider's session, and dropping four columns from
`app_user`. Nothing that references a user references the PIN.

`LCP_FIELD_KEY` custody, from ADR 0003, remains open and is unaffected by this.
