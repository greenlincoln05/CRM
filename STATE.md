# State — as of 2026-08-20

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 2 (service & dispatch) is capacity-aware and gate-code scoping is closed
per ADR 0009. Phase 3 (inventory: item master, barcodes, fitment, channel
listings) shipped in a prior, previously-unlogged stretch and is smoke-tested.
Phase 1 (customer, timeline, property profiles, photos) is behind both.

## Branch position

Working tree is on `service-story`, created from `main` at `df51658`, now 10
commits ahead (`ac685e2` .. `ff810c8`). `main` / `origin/main` are unchanged at
`df51658`. `service-story` has no upstream yet — the push to
`origin/service-story` and the decision to merge to `main` happen right after
this snapshot is written, and are not reflected in it. Working tree clean
(`git status --short` empty).

## Working

- Domain model: customer, contact, address, property, property equipment,
  timeline, attachments, water tests, work orders, inventory item master,
  channel listings
- Writable app: customers, contacts, properties, timeline, water tests, work
  orders (with capacity-aware scheduling), channel listings
- Staff authentication: PIN + server-side session (`apps/web/lib/session.ts`,
  `getSessionUser()`), ADR 0005 — the live auth system
- Offline technician PWA with photo sync; photo GET is now job-scoped
  (see below)
- Fuzzy customer search in `search_customers()`; fuzzy item/barcode search
  from Phase 3; migrations through 0013
- Append-only timeline and `sensitive_access_log`, enforced by trigger
- Gate code encryption: AES-256-GCM in `packages/db/src/crypto.ts`, `v1:` +
  base64(iv||ct||tag). Reconstruction caveat stands — ciphertext from the
  original lost implementation is not guaranteed to decrypt; only synthetic
  data ever existed
- Legacy transform + normalizers, data-quality checks passing on synthetic data

## Shipped this session (service-story)

- Migration 0013: `app_user.daily_capacity_minutes`, default 480
- `packages/db/src/write/workOrders.ts`: a capacity rule — scheduling into an
  already-full day is refused unless the caller passes an explicit override,
  recorded on the timeline. 11 new smoke checks. Fixed a LEFT-JOIN
  phantom-row bug in the planned SQL with `FILTER (WHERE w.id IS NOT NULL)`
- Day board (`apps/web/app/(office)/schedule/page.tsx`): per-technician load
  display, override checkboxes on both scheduling forms; `getDaySchedule`
  carries `assignee_capacity`
- ADR 0009 closed in code: the assignment window predicate is shared, in
  `apps/web/lib/assignment.ts`, between `/api/gate-code` and a newly
  job-scoped `/api/tech/photo` GET; out-of-scope requests get the same 404
  from both so the response shape doesn't distinguish "wrong job" from "no
  photo". Tech-side cache 1h, office immutable. 7 new probes in
  `apps/web/scripts/smoke-tech-api.ts` (52/52). uuid-shape 400 guard added to
  the photo GET; TOCTOU comment left on `assertCapacity`
- `DEMO.md` created as the single unified context document (reconciles
  `CORE.md` into it); `README.md` rewritten as a landing page, old version at
  `archive/README-2026-08-20.md`; `CLAUDE.md` pointers updated
- Dated closure notes added to ADRs 0003, 0009, 0010 for the photo-scoping item

## Found unlogged this session — Phase 3 inventory (dc59057..df51658)

Eight commits landed on `main` before this session with no `SESSIONS.md`
entry: `d73025b` "Phase 3 begins: item master, barcodes, fitment, and a
channel seam" through `df51658`. They shipped
`packages/db/src/schema/inventory.ts`, migrations
`0011_inventory_item_master.sql` and `0012_inventory_channel_listing.sql`,
`packages/db/src/write/channels.ts`, and roughly 1000 lines of new smoke
checks. All files are tracked and migrations are journaled correctly (checked
this session). Recorded now in `SESSIONS.md` for the first time; treat it as
shipped, not as new work.

## Free text is not encrypted — a live constraint on the UI

The day board renders no free text. `instructions`, `work_performed` and
`incomplete_reason` are how a gate code typed into a sentence bypasses the
encrypted column and lands on a list of forty addresses. The board links
instead of rendering, and both free-text inputs carry a warning. Keep it that
way.

## Local database note — two `.pgdata` directories exist on this machine

`.pgdata` was corrupted this session by the two-writer failure CLAUDE.md
warns about (a dev server held the PGlite lock while a migrate opened the
database; the kill mid-run completed the damage) — the same failure as
2026-08-18. It is preserved untouched at `./.pgdata`, not repaired or
deleted. A gitignored repo-root `.env` now sets
`PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2`, where the database was
rebuilt clean (migrate through 0013, `etl demo` 42/42). `.gitignore` widened
from `.pgdata/` to `.pgdata*/` to cover both. Synthetic data only, no loss.

**Gotcha for next session:** the smoke scripts do not read `.env`. Any smoke
run needs `PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2` set explicitly on
the command line, or it will look in the default (corrupt) `./.pgdata`.

## ADR 0009 — closed

ADR 0009 (who may reveal a gate code, scoped to the assigned job) is now
implemented, not just decided: `/api/gate-code` and the tech `/api/tech/photo`
GET share one scoping predicate and one 404 shape. Dated closure notes are in
ADRs 0003, 0009, 0010.

## Contradiction — needs a decision

ADR 0004 (mobile platform) and ADR 0006 (offline field app) reach different
conclusions about the same app: 0006 chose Expo/React Native and explicitly
rejected a PWA; the shipped technician app is a PWA. Two accepted ADRs
contradict each other and the code follows one. Unresolved.

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a
  guess until discovery runs

## Verified this session

`smoke:writes` green including 11 new capacity checks; `smoke-tech-api`
52/52 against a freshly started server; `typecheck` clean across workspaces;
`etl demo` 42/42; a real-browser click-through of capacity refusal →
book-anyway override → timeline arithmetic → over-capacity day board.

## Reviewed this session

`repo-reviewer` and `sensitive-data-guard` both ran clean (repo-reviewer's
ADR-staleness finding fixed in `e254991`); a final whole-branch review found
two Important findings, both fixed (`bfe6223`, `ac49a3b`) and re-verified.

## Blocked on a human

- Resolve the ADR 0004 vs 0006 contradiction — one must be superseded
- The KMS key does not exist yet, and the sealed offline copy of the raw key
  has not been made. A physical act only Lincoln can do
- Key rotation is unwritten, which makes `key generate --force` destructive
- Nothing is provisioned: no Vercel, Neon, R2, or AWS account
- Read-only credentials and network access to the on-prem Evosus SQL Server,
  or a vendor CSV export
- Decision: merge `service-story` to `main`, or keep iterating on the branch

## Incident log

2026-08-18: `.pgdata` corrupted by two concurrent writers. Rebuilt from
scratch; synthetic data only, no loss.

2026-08-20: `.pgdata` corrupted again, same failure mode. This time preserved
untouched rather than deleted; rebuilt at `.pgdata2` via `PGLITE_DIR` in a
gitignored `.env`. Synthetic data only, no loss. See "Local database note"
above.

## Not started

Purchasing · POS and payments. (Inventory item master and channel listings
moved from "not started" to "Working" this session — see Phase 3 note above.)

## Deferred, named but not built this session

- Smoke assertion for the reschedule-override timeline note
- A check that completed/incomplete jobs still count toward capacity
- React 19 form-action reset clears form fields after a *failed* submit —
  an `ActionForm`-wide UX issue
- A `FIELD_ROLES` allow-list to mirror `DISPATCH_ROLES` on the two
  field-scoped read surfaces
- Photo-GET timing side-channel — noted in code as defense-in-depth only

## Next up

1. Resolve ADR 0004 vs 0006 — supersede one, and say which the shipped PWA
   satisfies
2. Generate the KMS key and seal the offline copy, with rotation written first
3. The two deferred smoke assertions above (reschedule-override timeline
   note; completed/incomplete jobs counting toward capacity), then Evosus
   discovery once credentials or a vendor export exist
