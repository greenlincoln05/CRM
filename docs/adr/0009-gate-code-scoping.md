# 0009 — Who can reveal a gate code

Status: accepted, implemented
Date: 2026-08-19

Supersedes the "reveal is deliberately role-agnostic" condition in ADR 0003,
which deferred this decision until there were jobs to scope to.

## Context

ADR 0003 encrypts gate codes and logs every reveal, and its point 1 says a
technician should see a code "only on a property a technician has an assigned
job for". That could not be built when it was written — there were no jobs. So
the reveal shipped role-agnostic, with the audit trail as the whole control, and
the ADR recorded that per-job scoping would arrive with dispatch.

Dispatch shipped. Work orders now carry an assignee and a scheduled date, so the
deferred condition is due.

This is written as its own ADR rather than a sixth amendment to 0003's status
section, because it is a decision with live trade-offs — who counts as field
staff, how wide the window is, what the office keeps — and those deserve their
own context and their own review rather than a paragraph appended to someone
else's Decision. CLAUDE.md says accepted ADRs are superseded, not edited; 0003's
status had drifted into a changelog, and three of its sentences were false by
the time anybody noticed.

## Decision

**Scope by field versus office, not by rank.**

- `role = 'tech'` — must have a work order on that property, assigned to them,
  not cancelled, and either scheduled between two days ago and tomorrow, or
  undated but touched within the last two days. Otherwise 403.
- `admin`, `manager`, `staff` — unchanged. Any property, every reveal logged.

**Do not implement this with the `admin || manager` predicate** used by the
technician routes. Both `auth.ts` and `user-cli.ts` default a new account to
`staff`, so everyone behind the counter is `staff`, and `staff` is never
assigned a job. Scoping by rank would 403 the entire office. The question is
"is this person in the field", not "is this person senior".

### Why the office keeps an unscoped reveal

The counter takes the call that starts "I'm at the Beauchamps' and the gate
won't open". Someone there looks the customer up, satisfies themselves about who
is asking, and reads the code out. Removing that does not remove the call — it
moves the code onto a sticky note by the phone, or into a text message, or into
the instructions field where it becomes part of an append-only timeline nobody
can redact. A logged reveal by a named person is the better of the two
available outcomes.

### Why the window leans backward

Two days back, one day forward. The instinct is to lean forward — tomorrow's
route, next week's prep — but the case that actually strands somebody is in the
past: "come back Thursday with the part" is a revisit that still carries
Monday's date until the office reschedules it, and a technician standing at that
gate on Thursday needs the code. Forward, one day covers tomorrow's route being
looked at tonight. Anything further just accumulates codes on a phone for houses
nobody has visited yet, and `/api/tech/day` will serve a future date to any
technician who asks for one.

Undated work is included because an assigned job with no date is a real job —
same-day emergencies are assigned before they are dated — but bounded by
`updated_at`, because otherwise one job parked in March is an open-ended key to
that house.

## Consequences

**This was an accident control, not a boundary — closed by ADR 0010 on
2026-08-19, which made scheduling an office-role write. The reasoning below is
what motivated that change and is kept for the record.**
Office pages are gated on session only: any signed-in user, including a
technician, can open the schedule and assign a job to themselves, and the check
then admits them correctly. Closing that means role-gating the office writes and
forbidding self-assignment, which is a separate change with its own review. What
this ADR buys today is that a borrowed phone, a stolen session, or a curious
afternoon does not hand over every code in the database — and that taking one
anyway leaves two records: the reassignment on the timeline, and the reveal in
`sensitive_access_log`. The audit trail is still doing the security work.

**A cached code outlives the check.** The phone holds a revealed code until
midnight so a technician in a dead zone is not locked out by their own signal.
The scoping decision is only consulted on the fetch, so a technician pulled off
a job keeps that code until the next day refresh evicts it. Refreshing the day
now drops codes for properties that are no longer on it, which closes the
ordinary case; a device that never refreshes keeps it until midnight. A read
from that cache is also a reveal to a human eye with no log row — the one place
ADR 0003's "every reveal is logged" is not literally true.

**Refusals are not recorded.** A 403 writes a server log line and nothing to the
database, deliberately, so that "who had our code" stays a list of people who
actually got one. A technician walking property ids is therefore invisible to
the audit trail. If that becomes a real concern, it wants its own table rather
than muddying the reveal log.

**Still open from 0003**, and carried forward here so it is not lost when that
ADR stops being amended: key custody is physical and unverifiable from code; the
photo GET is session-gated but not job-scoped and is cached `immutable` for a
year; and free text remains the standing hole that column-level protection does
not cover — the mitigation is a warning beside every box that lands in a
property-linked field, and that is a convention, not a mechanism.
