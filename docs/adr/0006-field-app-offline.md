# 0006 — The technician app works without a network

Status: proposed
Date: 2026-08-18

## Context

The technician app is Phase 2 and it is the piece most likely to be judged
harshly, because it gets used standing in a driveway in the rain rather than at
a counter.

Service calls happen across rural Vermont and northern New York. Coverage is
patchy and, more to the point, unpredictable: a technician can have four bars at
the road and nothing behind the house where the equipment is. An app that spins
on a loading indicator at the moment someone needs a gate code is worse than the
paper it replaced.

Photo capture makes this sharper. Photos are the largest thing the app moves and
they are captured in exactly the places with the worst signal.

## Decision

Offline-first, with a local database and an outbox.

The app carries a local copy of what the technician needs for the jobs assigned
to them today: the customer, the property profile, the equipment, recent
timeline, and the access information. Everything captured in the field — notes,
water tests, photos, job status — is written locally first and queued for
upload. The network is treated as an optimisation, not a precondition.

**Build it with Expo and React Native.** A progressive web app is less work and
reuses more of the existing stack, and it is the tempting choice for one
developer. It loses on the two things this app is for: reliable background
upload of large photos, and camera behaviour on iOS. Both are exactly the
capabilities where web platform support is weakest and where failure is most
visible to the person using it.

**Sync is an outbox, not a merge.** Every field action is an append: a new
timeline event, a new photo, a new water test. The timeline is already
append-only and enforced by trigger, and corrections are already new rows rather
than edits. That means there is no merge conflict to resolve — the queue drains
in order and the server accepts. This is a property the existing design gives us
for free and it should not be given up.

Each queued item carries a client-generated id so that a retry after an
ambiguous failure is idempotent rather than a duplicate.

**Photos upload directly to R2** with a presigned URL, resumable, compressed on
the device before sending, and retried on a backoff that survives the app being
backgrounded. They never pass through the application server.

## Access information on the device

This is the part that needs care, and it follows directly from ADR 0003.

If gate codes are cached on a phone, then a lost phone is a set of house keys —
which is the same failure ADR 0003 exists to prevent, moved to a different
device. But refusing to cache them means the app cannot show a code exactly when
there is no signal, which is when it is needed.

The resolution:

- Access information is cached **only for jobs assigned to that technician for
  that day**, never the whole book.
- It is stored in the platform secure store, not in the general local database.
- It is wiped when the job is closed or the day rolls over, whichever is first.
- Revealing it is still an explicit action and still writes to
  `sensitive_access_log` — queued and uploaded like any other event when the
  network returns. A reveal that happened offline must still be recorded.
- Remote wipe on a lost device comes from Clerk session revocation, which is one
  of the reasons for choosing a real identity provider rather than rolling
  sessions here.

## Consequences

A second application to build and ship, in a stack that is adjacent to but not
the same as the web app. Business logic that both need — validation, water test
chemistry, formatting — belongs in a shared workspace package rather than being
written twice.

App store review is now in the release path, which is a new kind of delay. Expo
over-the-air updates cover most changes without a review cycle; anything native
does not.

Offline reveals mean `sensitive_access_log` is no longer strictly ordered by
arrival, and the recorded time must be when the reveal happened rather than when
it uploaded. The timeline already makes this distinction with `occurred_at`
versus `created_at`, and the access log should follow the same rule.

The decision to cache access information at all is a deliberate acceptance of
risk, made because the alternative fails at the moment of use. It is defensible
because the exposure is one technician's day rather than the whole customer
book, and because it is revocable remotely.

## Revisit if

Technicians turn out to be on a small number of company-owned Android devices
under mobile device management. That changes the risk calculation on cached
access information considerably, and might justify caching more.
