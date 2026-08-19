# 0010 — Who may schedule work

Status: accepted, implemented
Date: 2026-08-19

Closes the gap ADR 0009 recorded in its Consequences as needing "a separate
change with its own review".

## Context

ADR 0009 scoped the gate-code reveal: a technician sees a code only for a
property they have an assigned job on. Its own Consequences section then said,
plainly, that this was an accident control rather than a boundary — because a
technician could open `/schedule`, assign any job at any property to themselves,
and the new check would then admit them correctly.

That was true. Office pages were gated on session alone, every server action
called `requireUser()` with no role predicate, and the work-order write layer
had no authorization at all. The header of `workOrders.ts` listed three things
that "are business rules rather than plumbing"; who is allowed to do them was
not among them.

So the whole chain — encryption, the access log, per-job scoping — was one form
submission wide.

## Decision

Scheduling work is an office write, enforced in `@lcp/db`.

- `DISPATCH_ROLES` = `admin`, `manager`, `staff`. `createWorkOrder`,
  `rescheduleWorkOrder` and `cancelWorkOrder` refuse anyone else.
- An **allow-list**, not `role !== 'tech'`, so a role added later is refused
  rather than silently admitted.
- **Not `admin || manager`.** Both `createUser` and `user-cli` default a new
  account to `staff`, so everyone behind the counter is `staff`. Ranking this
  predicate would lock the entire office out of its own scheduling board. That
  trap has now been laid three separate times in this repository; the smoke
  suites assert against it in two places, and one of those assertions exists
  only to fail loudly if somebody "tightens" this in good faith.
- The check is the first statement in each function, ahead of any row lookup, so
  a refusal does not also confirm that a job or customer id exists.
- The refusal names no role and suggests no way around itself, for the same
  reason ADR 0009's 403 does not end with "or ask to be assigned the job".

**Office staff may assign a job to themselves.** In a shop this size whoever is
free drives the truck — the assignee picker deliberately offers every active
user, not just technicians, and the write-layer fixtures already modelled a
manager taking a delivery. A blanket self-assignment ban would have broken a
real workflow to close a hole that only exists for one role. A technician
assigning a job to themselves is refused explicitly, belt-and-braces, even
though the allow-list already makes it unreachable.

## Consequences

Gate-code scoping is now a boundary rather than a courtesy. A technician cannot
obtain a code by routing around the check, because they cannot create the
assignment the check looks for.

**The boundary is the write layer, not the hidden form.** The office pages stop
rendering dispatch controls to a technician, but that is cosmetic — a courtesy
so nobody is invited to do something that will be refused. Both the enforcement
and the hiding were verified by calling the server actions directly with a
technician's session and no form involved.

**Reads are untouched.** A technician can still open the schedule board and any
customer record, seeing names, addresses, phone numbers and job history.
Whether a personal phone should be able to pull the whole customer base is a
real question, and nobody has decided it. It is not this ADR's question, and it
should not be mistaken for one that has been answered.

**The ETL bypass stands.** `seed-jobs.ts` hand-rolls its insert and never enters
the write layer, so it creates jobs with no actor and no authorization. That is
already documented as a deliberate bypass for synthetic data, and it is fine for
exactly as long as it stays synthetic.

**A technician can still extend their own reveal window.** The undated branch of
ADR 0009's check is bounded by `updated_at`, and a technician's own status or
notes action touches that column. Someone holding an undated, non-cancelled job
of their own can therefore keep the two-day window open indefinitely by working
on it. They cannot create the assignment, which is what this ADR closes, but
they can keep one alive.

**Still open, carried forward from 0009:** the photo GET is session-gated but
not job-scoped and is cached `immutable` for a year; a cached gate code on a
device outlives an unassignment until the next day refresh; refusals are logged
to stdout and not to the database; and free text remains the hole that
column-level protection does not cover.
