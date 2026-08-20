# The demo, in one document

This repository is a **demonstration**: a working model of what a modern
operating platform for Lake Champlain Pools, Spas & Stoves could be. It
emulates production-level software — real schema, real encryption, real
offline sync, real authorization — without being the production system. It
runs entirely on a laptop, on synthetic data. No cloud account is
provisioned, no real customer record has ever entered it, and the legacy
system it "migrates from" has never actually been connected.

Two things are being demonstrated at once:

1. **The product** — the platform described in `CORE.md`, built far enough
   to click through: search, customer records, timelines, scheduling, a
   technician app, gate-code security.
2. **The process** — how one person with an agent roster, a session
   protocol, and an enforced review gate can build it. The `.claude/agents/`
   files, `SESSIONS.md`, and the review-gate story are as much the demo as
   the app is.

The rest of this document unifies everything the repo's markdown says:
requirements, status, decisions, architecture, process, and honest limits.
Deep detail stays in the source documents, linked throughout.

## The scenario

Lake Champlain Pools, Spas & Stoves — a real-shaped business modeled from
`CORE.md`: 600–900 retail transactions, 50–80 service calls, and 15–20
deliveries or builds in a busy week, on twenty years of data in an on-prem
Evosus install. One person builds the replacement while also running the
store. Pool season is April–September, stove season September–December;
anything touching money cuts over January–March, between them.

The strategy is a **strangler fig** (ADR 0001): build alongside Evosus and
move one domain at a time — customer/timeline/photos, then service and
dispatch, then inventory, then POS and payments. Evosus stays the system of
record for money and inventory until the end. A read-only extract lands its
rows verbatim in staging; transforms upsert into the domain model keyed on
`(legacy_source, legacy_id)` so re-running is safe; everything the
transform cannot make sense of becomes an `import_issue` row — never an
exception, never a silent null. Fix the mapping, re-run, re-read. That loop
is the entire migration.

Guiding principle, from `CORE.md`: **One customer. One timeline. One
workflow.** The software adapts to the business, not the other way around.

## Feature goals versus what the demo contains

`CORE.md` is the source of truth for what the demo is aiming at. This table
is the reconciliation, honest in both directions. Status vocabulary:

- **working** — built, runs in the demo, most items tested
- **partial** — a real subset works; the rest is named
- **designed** — decided and documented (usually an ADR), little or no code
- **not started** — aimed at, nothing yet

### Customer experience

| CORE.md goal | Status | Where / what's missing |
|---|---|---|
| One customer record, multiple properties & contacts | working | Domain model: customer, contact, address, property, equipment |
| Google-style fuzzy search | working, tested | `search_customers()` in the database — `pg_trgm`, `word_similarity()`, ADR 0002 |
| One communication timeline | partial | Append-only timeline enforced by trigger, tested. Only internal events and water tests feed it; Podium texts, email, and calls are not ingested |
| Address validation / autocomplete, ZIP-to-city | not started | ETL normalizers repair legacy ZIPs, but no live validation exists |

### Property profiles, photos & documentation

| CORE.md goal | Status | Where / what's missing |
|---|---|---|
| Property profiles: equipment, access instructions, gate codes, pet info | working | The flagship security story — encrypted gate codes, logged reveals, per-job scoping (ADRs 0003, 0009) |
| Field photo capture | working | Technician PWA captures offline and syncs; stored with capture metadata, not yet surfaced on the timeline |
| Photos in cloud storage, signed URLs | designed | R2 with presigned uploads is decided (ADR 0007); today photos are served locally, session-gated and job-scoped for field roles |
| Easy review of historical job photos | not started | Photos are stored and job-scoped for retrieval, but no office or tech surface renders them yet |

### Service & dispatch

| CORE.md goal | Status | Where / what's missing |
|---|---|---|
| Mobile technician app | working | Offline-first PWA at `/tech`: local-first reads, outbox sync, checklists, photos, wipe |
| Booking, scheduling, cancelling jobs | working, tested | Write layer + `/schedule` day board grouped by technician; office-role-only (ADR 0010) |
| Technician GPS / status | partial | Position fixes at meaningful moments (`work_order_ping`) — breadcrumbs, deliberately not live tracking; a PWA cannot report location in the background (ADR 0004). Fleet tracking stays in the existing fleet system |
| Capacity limits (block overbooked days) | working | Per-person daily minutes budget (default 480) enforced in the write layer; the office may book anyway, and the timeline records the arithmetic |
| Parts gating before scheduling | not started | Phase 2 roadmap; needs inventory (Phase 3) first |
| Route optimization | not started | — |

### Inventory & purchasing

Phase 3 has **begun in code**: an item master with barcodes and fuzzy counter
search, and a sales-channel seam (`packages/db/src/schema/inventory.ts`,
migrations 0011-0012) — work that reached the repo without a session log entry at the time. Reorder
suggestions, seasonal forecasting, purchasing, and the rest of this section
are **not started**.

### Sales, POS & payments

Cleaner quotes, unified payments, surcharge support: **not started**. POS is
Phase 4, last on purpose (ADR 0001): highest-risk, most regulated, least
differentiated, and it benefits most from a domain model already proven in
daily use. The offline-register problem is already designed around
(`docs/cloud-architecture.md`, "The register problem").

### AI opportunities

Natural-language search, purchase recommendations, forecasting, dashboards,
summaries: **not started** (Phase 4). Two pieces of groundwork exist:
`pgvector` is available in the same Postgres when semantic search arrives,
and ADR 0003 point 4 already constrains it — AI features read from filtered
views, never `SELECT *`, so a property summary can never swallow a gate code.

### CORE.md non-negotiables, scored

| Non-negotiable | Status |
|---|---|
| Cloud-native | designed — Vercel/Neon/R2/KMS decided (ADR 0007), nothing provisioned |
| Excellent POS | not started (Phase 4) |
| Strong inventory management | begun in code (Phase 3) |
| Integrated CRM | working in the demo |
| Service scheduling | working, first cut |
| Mobile apps | working (PWA — see the open ADR contradiction below) |
| Open API | partial — internal route handlers only, no public API |
| AI-ready | groundwork only |
| Easy training / vendor support | answered by the build-it path itself: one search box, no vendor |

## Architecture digest

Ten ADRs, all accepted. Each line is the decision; the file has the
reasoning.

- **0001 — Strangler fig.** Replace Evosus one domain at a time, POS last,
  money cutovers January–March only.
- **0002 — Postgres, PGlite for dev.** Real Postgres 17 compiled to WASM as
  an npm dependency; production is the same code with `DATABASE_URL` set.
  Search lives in the database.
- **0003 — Sensitive fields.** Gate codes encrypted (AES-256-GCM) in the
  application, never in list views, every reveal logged before it returns,
  excluded from exports and AI context. The database holds the means of
  physical entry to several hundred homes; a stolen backup must not be a
  set of house keys.
- **0004 — Technician app is a PWA.** No app store, ships instantly, one
  codebase. Known cost: no background GPS — breadcrumbs instead.
- **0005 — Staff authentication.** Email + PIN (scrypt), lockout doing the
  real work, server-side revocable sessions, no self-service signup, every
  write carries an actor. Interim by design: replacing it with an identity
  provider is a deletion, not a migration.
- **0006 — Offline field app.** Local-first, outbox sync, client-generated
  ids for idempotent replay, day-scoped cached access codes in secure
  storage. *Chose Expo/React Native and rejected a PWA — see the
  contradiction below.*
- **0007 — Managed hosting.** Vercel + Neon + R2 + Clerk (chosen, not
  implemented) + AWS KMS. ETL stays on the shop server beside Evosus.
  Managed services because one seasonal operator cannot own a VM.
- **0008 — Key custody.** The field key is KMS-wrapped; the raw key exists
  in process memory and on one sealed piece of paper. A stolen backup
  needs a second, separate compromise.
- **0009 — Gate-code scoping.** Field roles see a code only with an
  assigned, current job on that property; the office keeps an unscoped,
  logged reveal because the alternative is a sticky note by the phone.
- **0010 — Who may dispatch.** Scheduling is an office write, enforced as
  an allow-list in the write layer — which turned 0009 from an accident
  control into a boundary.

The full deployment picture — environments, backups, observability, costs
(~$70–130/month), seasonality, the Phase 4 register problem — is
`docs/cloud-architecture.md`. All of it is **designed, not provisioned**.

## The other half of the demo: the process

The repo demonstrates a way of working as much as a product.

**Agents.** Work is decomposed by `orchestrator` and routed to specialists,
each with an owned surface and explicit handoffs (`.claude/agents/`):
`schema-steward` (tables, migrations, search), `backend-builder` (write
layer, actions, routes, auth), `frontend-builder` (office pages, PWA),
`cloud-architect` (deploy, env, providers), `migration-engineer` (ETL),
`data-quality-analyst` (issue triage), `sensitive-data-guard` (ADR 0003
enforcement), `repo-reviewer` (pre-push review), `cutover-planner`
(sequencing, build-vs-buy), `session-scribe` (continuity). Builders do not
commit or push.

**Sessions.** Short and far apart, so continuity is externalized:
`session-scribe` opens each session by reconciling `STATE.md` against git
(drift is assumed, not exceptional) and closes it by rewriting `STATE.md`
and appending to `SESSIONS.md`. Snapshot versus log; decisions become
numbered ADRs, superseded rather than edited.

**The review gate.** A `PreToolUse` hook blocks `git push` unless the exact
commit at HEAD has a recorded review. It lives in user settings, not the
repo — a repo-local gate silently never ran while three pushes went out
unreviewed, which is the origin story (`tools/review-gate/README.md`). It
stops the accident, not a determined bypass, and says so.

**The process earning its keep** (from `SESSIONS.md`): review caught a
sequence collision whose first fix was off by one (only the second review
pass caught that); `CURRENT_DATE` in GMT landing jobs on a day the board
would not show; free text rendered onto a forty-address board — the exact
path a gate code takes around column encryption; an error-logging "fix"
that logged the very statement-plus-parameters leak it claimed to prevent;
and a `.gitignore` NuGet rule silently swallowing every file under
`packages/`, which is how a commit once pushed incomplete and a clean clone
stopped building.

## Running the demo

Node 22+. No Docker, no Postgres install — development runs on embedded
PGlite.

```bash
npm install
npm run db:migrate
npm run etl -- demo        # full migration pipeline on synthetic legacy data
npm run db:user -- add --email you@example.com --name "Your Name" --role admin --pin 4417
npm run dev -w @lcp/web
```

Back office at http://localhost:3100, technician app at
http://localhost:3100/tech (best on a phone or a narrow window). There is
no sign-up form on purpose (ADR 0005). The `etl -- demo` run is the fastest
tour: synthetic legacy data built to mimic twenty-year-old records —
7-digit phone numbers, ZIPs missing a leading zero, two people in one name
field — through the full pipeline, verified at the end.

```
packages/db     schema, migrations, database client, write layer, crypto
packages/etl    Evosus discovery, extraction, transform, data quality
apps/web        office app and the technician PWA
docs/adr/       why things are the way they are
```

The gotchas that actually bite (`CLAUDE.md` has the full list): PGlite
allows a single writer, so stop the dev server before `npm run etl`; an
applied migration is immutable — supersede with a new one, never edit;
hand-written migrations need `--> statement-breakpoint` between statements;
query results unwrap with `(r?.rows ?? r)` because two drivers differ;
date-only legacy values pin to local noon in `America/New_York`.

## Current state and honest limits

As of 2026-08-20 (`STATE.md` is the live snapshot; this is the summary):

**Phase 2, first cut shipped.** The office can create, schedule, reschedule
and cancel jobs on a day board; Phase 1 (customer, timeline, property
profiles, photos) and staff auth are behind it.

**What is emulated rather than real:**

- Only synthetic data has ever existed. `data/`, `.env`, `.pgdata/` are
  gitignored on principle, but there are no real customer records anywhere.
- Nothing is provisioned: no Vercel, Neon, R2, or AWS account. The KMS key
  does not exist; the sealed offline copy has not been made; key rotation
  is unwritten, which makes `key generate --force` destructive.
- Evosus schema discovery and the SQL Server extract are written but have
  never run against a real server. Every candidate column name in
  `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs.
- External integrations named in `CORE.md` — Podium, QuickBooks, fleet
  tracking — are not wired to anything.

**Open contradiction:** ADRs 0004 and 0006 reach different conclusions
about the same app — 0006 chose Expo/React Native and explicitly rejected
a PWA; the shipped technician app is a PWA. Both are accepted. One must be
superseded, and that is a human decision no agent gets to make.

**Known security limits, carried deliberately** (ADRs 0009/0010 record the
reasoning): free text is the standing hole column encryption does not
cover — a gate code typed into a sentence lands in an append-only timeline
nobody can redact, and the mitigation is a warning, not a mechanism; a
cached code on a phone outlives an unassignment until the day refresh;
refusals are not written to the audit log, so probing is invisible to it.

**Next up** (ranked, from `STATE.md`): resolve 0004 vs 0006; generate
and seal the KMS key, rotation written first.

## Where everything lives

| Document | Role |
|---|---|
| `CORE.md` | The business requirements the demo is built against — the feature list it aims to contain |
| `DEMO.md` | This file — the unified context |
| `README.md` | Landing page and quick start |
| `CLAUDE.md` | Operating instructions for working sessions: protocol, agents, review gate, non-negotiables |
| `STATE.md` | Snapshot of where the work is, rewritten each session |
| `SESSIONS.md` | Append-only log of what actually happened |
| `docs/adr/0001–0010` | The decisions, never edited once accepted — superseded instead |
| `docs/cloud-architecture.md` | The full deployment design the ADRs assume |
| `tools/review-gate/` | The push gate: scripts and reasoning |
| `.claude/agents/` | The eleven specialist agent definitions |
| `archive/` | Superseded versions of rewritten documents |
