# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 1 (customer, timeline, property profiles, photos), in progress.

## Working

- Domain model: customer, contact, address, property, property equipment, timeline, attachments, water tests
- Fuzzy customer search in `search_customers()`, tested, through migration 0005
- Append-only timeline, enforced by trigger
- Legacy transform + normalizers, 30 data-quality checks passing on synthetic data
- Web app: search, customer detail, timeline — runs at http://localhost:3100
- Gate code reveal flow in the web app: page payload carries a boolean, reveal is an explicit POST, value re-hides after a minute

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs

## Broken on `main` — blocks a fresh clone

Commit `56bf5be` ("Encrypt gate codes and log every reveal") is incomplete on the
remote. Three files it depends on were never pushed:

- `packages/db/src/crypto.ts` — re-exported by `packages/db/src/index.ts`
- `packages/db/src/env.ts` — re-exported by `packages/db/src/index.ts`
- `packages/db/migrations/0006_encrypt_sensitive_fields.sql` — `meta/_journal.json` has the entry, the file is absent

Consequence: a clean clone does not typecheck and `npm run db:migrate` fails at
entry 6. It works on the machine where the files exist locally. Recovering them
from that machine and pushing is the first move of the next session — if that
machine is gone, `gate_code_enc` cannot be read at all.

## Blocked on a human

- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export
- `LCP_FIELD_KEY` backed up offline. ADR 0005 proposes KMS-wrapped with a sealed offline copy — proposed, not accepted, and nothing is implemented
- Identity provider. ADR 0004 proposes Clerk — proposed, not accepted. The reveal endpoint records `unauthenticated-dev` until this lands
- Whether to accept ADRs 0004, 0005, 0006. All three are untracked in git as of this snapshot

## Untracked planning docs

`docs/adr/0004-hosting.md`, `docs/adr/0005-key-custody.md`,
`docs/adr/0006-field-app-offline.md`, `docs/cloud-architecture.md` — written
2026-08-18, status `proposed`, not committed. They describe Vercel + Neon + R2 +
Clerk + KMS hosting, key custody, and an Expo offline-first technician app.
Decisions, not implementations: no code in the repository depends on any of them yet.

## Not started

Technician mobile app · service and dispatch · inventory · purchasing · POS and payments

## Next up

1. Push the three missing files so `main` builds
2. Real authentication on the gate code reveal endpoint — blocks the mobile app (ADR 0003)
3. Run discovery against real Evosus, correct `mappings/evosus.ts`, read the issue report
