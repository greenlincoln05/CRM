# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 2 (service & dispatch), first cut shipped. The office can create, schedule,
reschedule and cancel jobs. Phase 1 (customer, timeline, property profiles,
photos) and Sprint 2 writes are behind it.

## Branch position

HEAD is on `main` at `f223373` = `origin/main`, working tree clean. This
session's three commits: `60b2914` (the build), `36a552d` (first review round),
`f223373` (second review round). `docs/cloud-architecture` is stale at `d32e2bc`
and can be deleted.

## Working

- Domain model: customer, contact, address, property, property equipment, timeline, attachments, water tests, work orders
- Writable app: customers, contacts, properties, timeline, water tests, work orders
- Staff authentication: PIN + server-side session (`apps/web/lib/session.ts`,
  `getSessionUser()`), ADR 0005 — the live auth system
- Offline technician PWA with photo sync
- Fuzzy customer search in `search_customers()`, migrations through 0010
- Append-only timeline and `sensitive_access_log`, enforced by trigger
- Gate code encryption: AES-256-GCM in `packages/db/src/crypto.ts`, `v1:` +
  base64(iv||ct||tag). Reconstruction caveat stands — ciphertext from the
  original lost implementation is not guaranteed to decrypt; only synthetic data
  ever existed
- Legacy transform + normalizers, data-quality checks passing on synthetic data

## Phase 2, shipped this session

- Migration 0010 (`packages/db/migrations/0010_work_order_numbering.sql`):
  `work_order_number_seq`, partial unique index on number, and the
  `(legacy_source, legacy_id)` index `work_order` never had despite
  non-negotiable #2
- `packages/db/src/write/workOrders.ts` — `createWorkOrder` /
  `rescheduleWorkOrder` / `cancelWorkOrder`. Number allocated inside the INSERT,
  ownership checked, checklist seeded from job type, timeline event on every
  write. 16 new write checks
- Reads: `getWorkOrders`, `getDaySchedule`, `getTechnicians` in
  `apps/web/lib/queries.ts`
- UI: Jobs section on the customer page; new `/schedule` day board grouped by
  technician with an unassigned bucket; nav link; subtitle now
  "Phase 2 · service & dispatch"
- `packages/etl/src/seed-jobs.ts` fixed — it had a bare `ON CONFLICT` with no
  inferable target and re-inserted every run

## Free text is not encrypted — a live constraint on the UI

The day board renders no free text. `instructions`, `work_performed` and
`incomplete_reason` are how a gate code typed into a sentence bypasses the
encrypted column and lands on a list of forty addresses. The board links instead
of rendering, and both free-text inputs carry a warning. Keep it that way.

## ADR 0003 status, corrected

Points 4 and 5 were documented as open when both are half done. ADR 0003's own
deferral of per-job scoping has come due now that dispatch exists:
`/api/tech/photo` scopes to the assigned job, `/api/gate-code` still does not.
README status table and layout corrected.

## Agent roster — first run of orchestrator + builders

orchestrator planned and routed; schema-steward, backend-builder and
frontend-builder built; repo-reviewer and sensitive-data-guard reviewed twice.
Both builder agents were killed mid-task by a spend limit — frontend's work had
landed, backend's had not, and the backend fixes were finished directly.

## What review caught (the agents, not the hook)

- Migration 0010's sequence started at 1001 without moving past existing numbers,
  so the first four office bookings would collide on any database that ran the
  old seeder once. The fix was then off by one — two-arg `setval` marks the value
  used — which only the SECOND review caught
- `CURRENT_DATE` is GMT while the board reads shop-local, so evening seeding
  landed jobs on a day the board would not show. Five sites
- The board rendered `instructions` / `work_performed` / `incomplete_reason` in full
- The first error-logging fix logged `err.message`, which in drizzle IS the
  statement plus every parameter — the exact leak it claimed to prevent
- The new ADR 0003 regression test could pass vacuously two ways

## Built ahead of its source

`incomplete_reason` has no write path from the phone yet. TechApp has a bare
"Couldn't finish" button, and the field only arrives via the sync endpoint or
seeded data. The dispatch UI for it exists before anything real can populate it.

## Contradiction — needs a decision

ADR 0004 (mobile platform) and ADR 0006 (offline field app) reach different
conclusions about the same app: 0006 chose Expo/React Native and explicitly
rejected a PWA; the shipped technician app is a PWA. Two accepted ADRs
contradict each other and the code follows one. Unresolved.

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs

## Blocked on a human

- Resolve the ADR 0004 vs 0006 contradiction — one must be superseded
- The KMS key does not exist yet, and the sealed offline copy of the raw key has
  not been made. A physical act only Lincoln can do
- Key rotation is unwritten, which makes `key generate --force` destructive
- Nothing is provisioned: no Vercel, Neon, R2, or AWS account
- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export

## Incident log

2026-08-18: `.pgdata` corrupted by two concurrent writers — a taskkill of the npm
wrapper left next.js alive holding the PGlite lock, the single-writer gotcha
CLAUDE.md warns about. Rebuilt from scratch; dev field key regenerated with it;
synthetic data only, no loss.

## Not started

Inventory · purchasing · POS and payments

## Next up

1. A write path for `incomplete_reason` from the phone, so the dispatch UI has a source
2. Per-job scoping on `/api/gate-code`, matching what `/api/tech/photo` already does (ADR 0003)
3. Resolve ADR 0004 vs 0006 — supersede one, and say which the shipped PWA satisfies
4. Generate the KMS key and seal the offline copy, with rotation written first
