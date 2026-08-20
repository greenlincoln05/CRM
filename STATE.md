# State — as of 2026-08-20

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 2 (service & dispatch) is capacity-aware and gate-code scoping is closed
per ADR 0009. Phase 3 (inventory: item master, barcodes, fitment, channel
listings) shipped in a prior, previously-unlogged stretch and is smoke-tested.
Phase 1 (customer, timeline, property profiles, photos) is behind both. This
session added an office UI shell over the top of all of it — navigation now
covers every `CORE.md` area, but most of that surface is an honest
placeholder, not new functionality.

## Branch position

`main` / `origin/main` are at `b3c7eca` — a merge of `office-ui` (UI overhaul)
which itself carried `service-story` (capacity limits, photo scoping, docs
unification). `office-ui` / `origin/office-ui` are at `4b1cfb4`.
`service-story` / `origin/service-story` are at `86b8f2e`. All three branches
are pushed. The controller switches the working tree back to `main` after
this snapshot is written.

## Working

- Domain model: customer, contact, address, property, property equipment,
  timeline, attachments, water tests, work orders, inventory item master,
  channel listings
- Writable app: customers, contacts, properties, timeline, water tests, work
  orders (with capacity-aware scheduling), channel listings
- Office UI shell: Apollo-style icon rail + section panel + top bar with
  global search, brand-light theme scoped under `.office`
  (`apps/web/app/office.css`, `apps/web/app/ui/OfficeNav.tsx`); the
  technician PWA and `globals.css` are untouched by it
- Navigation as data (`apps/web/lib/nav.ts`) enumerating every area named in
  `CORE.md`; 23 destinations render as honest placeholders
  (`apps/web/app/ui/PlaceholderPage.tsx`), the rest are real pages
- `/customers` directory page; read-only `/settings/staff` roster
  (`listStaff()` in `apps/web/lib/queries.ts` — name, role, active only, no
  sensitive fields)
- Staff authentication: PIN + server-side session (`apps/web/lib/session.ts`,
  `getSessionUser()`), ADR 0005 — the live auth system
- Offline technician PWA with photo sync; photo GET is job-scoped
- Fuzzy customer search in `search_customers()`; fuzzy item/barcode search
  from Phase 3; migrations through 0013
- Append-only timeline and `sensitive_access_log`, enforced by trigger
- Gate code encryption: AES-256-GCM in `packages/db/src/crypto.ts`, `v1:` +
  base64(iv||ct||tag). Reconstruction caveat stands — ciphertext from the
  original lost implementation is not guaranteed to decrypt; only synthetic
  data ever existed
- Legacy transform + normalizers, data-quality checks passing on synthetic data

## Shipped this session (office-ui, 11 commits bf74d28..4b1cfb4)

- Apollo-style shell per `docs/superpowers/specs/2026-08-20-office-ui-
  overhaul-design.md`: icon rail + section panel + top bar with global
  search
- `apps/web/lib/nav.ts` (318 lines): navigation as one data structure,
  covering every `CORE.md` area
- 23 honest placeholder pages; a `/customers` directory; a read-only
  `/settings/staff` roster; a light restyle of `apps/web/app/login/page.tsx`
- Two new verification gates: `apps/web/scripts/smoke-nav.ts` (28 targets,
  56 checks, green) and `apps/web/scripts/check-contrast.ts` (15 WCAG AA
  pairs, all pass)
- Decided in the spec, not built: Google Workspace as the platform's home
  (Calendar sync, Gmail, eventual Google sign-in), which supersedes ADR
  0007's Clerk assumption — wants its own ADR when auth work begins
- Reviewed: two per-task fix rounds (an `OfficeNav` active-state bug traced
  to the plan itself, and a back-link label); `repo-reviewer` clean on the
  whole branch (three items flagged as worth tidying, not blocking — see
  below); `sensitive-data-guard` clean
- Session was interrupted once by an API spend limit mid-Task-3; resumed
  cleanly

## Shipped prior session (service-story, 10 commits ac685e2..ff810c8)

- Migration 0013: `app_user.daily_capacity_minutes`, default 480
- `packages/db/src/write/workOrders.ts`: a capacity rule — scheduling into an
  already-full day is refused unless the caller passes an explicit override,
  recorded on the timeline. 11 new smoke checks. Fixed a LEFT-JOIN
  phantom-row bug in the planned SQL with `FILTER (WHERE w.id IS NOT NULL)`
- Day board (`apps/web/app/(office)/schedule/page.tsx`): per-technician load
  display, override checkboxes on both scheduling forms; `getDaySchedule`
  carries `assignee_capacity`
- ADR 0009 closed in code: the assignment window predicate is shared, in
  `apps/web/lib/assignment.ts`, between `/api/gate-code` and a
  job-scoped `/api/tech/photo` GET; out-of-scope requests get the same 404
  from both so the response shape doesn't distinguish "wrong job" from "no
  photo". Tech-side cache 1h, office immutable. 7 new smoke probes in
  `apps/web/scripts/smoke-tech-api.ts` (52/52). uuid-shape 400 guard added to
  the photo GET; TOCTOU comment left on `assertCapacity`
- `DEMO.md` created as the single unified context document (reconciles
  `CORE.md` into it); `README.md` rewritten as a landing page, old version at
  `archive/README-2026-08-20.md`; `CLAUDE.md` pointers updated
- Dated closure notes added to ADRs 0003, 0009, 0010 for the photo-scoping item

## Found unlogged in a prior session — Phase 3 inventory (dc59057..df51658)

Eight commits landed on `main` before that session with no `SESSIONS.md`
entry: `d73025b` "Phase 3 begins: item master, barcodes, fitment, and a
channel seam" through `df51658`. They shipped
`packages/db/src/schema/inventory.ts`, migrations
`0011_inventory_item_master.sql` and `0012_inventory_channel_listing.sql`,
`packages/db/src/write/channels.ts`, and roughly 1000 lines of new smoke
checks. All files are tracked and migrations are journaled correctly. Recorded
in `SESSIONS.md`; treat it as shipped, not as new work.

## Free text is not encrypted — a live constraint on the UI

The day board renders no free text. `instructions`, `work_performed` and
`incomplete_reason` are how a gate code typed into a sentence bypasses the
encrypted column and lands on a list of forty addresses. The board links
instead of rendering, and both free-text inputs carry a warning. Keep it that
way. The new office shell does not change this — placeholders render no data
at all.

## Local database note — two `.pgdata` directories exist on this machine

`.pgdata` was corrupted in the 2026-08-20 service-story session by the
two-writer failure CLAUDE.md warns about. It is preserved untouched at
`./.pgdata`, not repaired or deleted. A gitignored repo-root `.env` sets
`PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2`, where the database was
rebuilt clean (migrate through 0013, `etl demo` 42/42). `.gitignore` covers
`.pgdata*/` to include both.

**Gotcha for next session:** the smoke scripts do not read `.env`. Any smoke
run needs `PGLITE_DIR=/Users/mkozak/GitHub/CRM/.pgdata2` set explicitly on
the command line, or it will look in the default (corrupt) `./.pgdata`.

## ADR 0009 — closed

ADR 0009 (who may reveal a gate code, scoped to the assigned job) is
implemented, not just decided: `/api/gate-code` and the tech `/api/tech/photo`
GET share one scoping predicate and one 404 shape. Dated closure notes are in
ADRs 0003, 0009, 0010.

## Contradiction — needs a decision

ADR 0004 (mobile platform) and ADR 0006 (offline field app) reach different
conclusions about the same app: 0006 chose Expo/React Native and explicitly
rejected a PWA; the shipped technician app is a PWA. Two accepted ADRs
contradict each other and the code follows one. Unresolved.

## New this session — a second ADR question, not yet written

The `office-ui-overhaul-design.md` spec declares Google Workspace (Calendar
sync, Gmail, eventual Google sign-in) as the platform's home, which
supersedes ADR 0007's Clerk assumption. This was a decision made in a spec
document, not code — nothing toward Google auth was built. It needs its own
ADR before auth work begins; none exists yet. Recommend one when that work
starts.

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a
  guess until discovery runs

## Verified this session (office-ui)

`smoke-nav` 28 targets / 56 checks green; `check-contrast` 15/15 WCAG AA
pairs pass.

## Verified prior session (service-story)

`smoke:writes` green including 11 capacity checks; `smoke-tech-api` 52/52
against a freshly started server; `typecheck` clean across workspaces;
`etl demo` 42/42; a real-browser click-through of capacity refusal →
book-anyway override → timeline arithmetic → over-capacity day board.

## Reviewed this session (office-ui)

Per-task reviews with two fix rounds (an `OfficeNav` active-state bug and a
back-link label); `repo-reviewer` clean on the full branch diff, with three
items named as worth tidying but not blocking (see "Deferred" below);
`sensitive-data-guard` clean.

## Blocked on a human

- Resolve the ADR 0004 vs 0006 contradiction — one must be superseded
- Write an ADR for the Google Workspace / auth-provider decision before auth
  work begins (supersedes ADR 0007's Clerk assumption)
- The KMS key does not exist yet, and the sealed offline copy of the raw key
  has not been made. A physical act only Lincoln can do
- Key rotation is unwritten, which makes `key generate --force` destructive
- Nothing is provisioned: no Vercel, Neon, R2, or AWS account
- Read-only credentials and network access to the on-prem Evosus SQL Server,
  or a vendor CSV export
- A real logo asset — the rail currently shows a "C" mark placeholder
- The review-gate hook is confirmed still not installed on this machine;
  review markers are being written by hand via the repo's marking script

## Incident log

2026-08-18: `.pgdata` corrupted by two concurrent writers. Rebuilt from
scratch; synthetic data only, no loss.

2026-08-20: `.pgdata` corrupted again, same failure mode. This time preserved
untouched rather than deleted; rebuilt at `.pgdata2` via `PGLITE_DIR` in a
gitignored `.env`. Synthetic data only, no loss. See "Local database note"
above.

## Not started

Purchasing · POS and payments (schema/write layer). Most of the newly-added
nav surface (23 destinations) is a placeholder page, not a built feature —
see `apps/web/lib/nav.ts` and `apps/web/app/ui/PlaceholderPage.tsx` for the
full list.

## Deferred, named but not built

- Three `repo-reviewer` tidying items from the office-ui review: a dead grid
  line in `apps/web/app/office.css`'s ≤900px block, an unreachable
  `/customers` fallback branch in `sectionForPath`, and a UX note about two
  search inputs appearing on the Home page
- Smoke assertion for the reschedule-override timeline note
- A check that completed/incomplete jobs still count toward capacity
- React 19 form-action reset clears form fields after a *failed* submit —
  an `ActionForm`-wide UX issue
- A `FIELD_ROLES` allow-list to mirror `DISPATCH_ROLES` on the two
  field-scoped read surfaces
- Photo-GET timing side-channel — noted in code as defense-in-depth only
- A real logo file for the office rail

## Next up

1. Write the ADR for the Google Workspace / auth-provider decision (spec
   says it supersedes ADR 0007's Clerk assumption) before touching any auth
   code
2. Resolve ADR 0004 vs 0006 — supersede one, and say which the shipped PWA
   satisfies
3. The three worth-tidying review findings from the office-ui review (dead
   CSS, unreachable fallback, duplicate search-input UX), then the two
   deferred smoke assertions carried from service-story (reschedule-override
   timeline note; completed/incomplete capacity counting)
