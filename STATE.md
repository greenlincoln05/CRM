# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 1 (customer, timeline, property profiles, photos), in progress.

## Branch position

HEAD is on local branch `docs/cloud-architecture` at `d70bc82`, two commits ahead
of `main` (`1be4705`, `d70bc82`). No upstream; nothing on it is pushed. `main` is
still `56bf5be` and matches `origin/main`. Working tree clean.

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

## Broken everywhere — blocks this clone too

Commit `56bf5be` ("Encrypt gate codes and log every reveal") depends on three
files that are absent from this clone's working tree and from its entire git
history (`git log --all` finds nothing):

- `packages/db/src/crypto.ts` — re-exported by `packages/db/src/index.ts` (line 63)
- `packages/db/src/env.ts` — re-exported by `packages/db/src/index.ts` (line 64)
- `packages/db/migrations/0006_encrypt_sensitive_fields.sql` — `meta/_journal.json` has entry 6, no `.sql` file exists

Consequence: this checkout does not typecheck and `npm run db:migrate` fails at
journal entry 6 — here, not just on a fresh clone. An earlier snapshot said the
files "exist locally" on the machine that wrote them and could simply be pushed;
this machine is not that machine, and no build output survives to salvage. The
real options are: (a) locate the originating machine and push from it, or
(b) reconstruct `crypto.ts`, `env.ts`, and migration 0006 from the schema and
ADR 0003 — accepting that existing `gate_code_enc` values may be unreadable if
the reconstructed key handling or ciphertext format differs from the original.

## Blocked on a human

- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export
- `LCP_FIELD_KEY` backed up offline. ADR 0005 proposes KMS-wrapped with a sealed offline copy — proposed, not accepted, and nothing is implemented
- Identity provider. ADR 0004 proposes Clerk — proposed, not accepted. The reveal endpoint records `unauthenticated-dev` until this lands
- Whether to accept ADRs 0004, 0005, 0006 — committed on `docs/cloud-architecture`, still `status: proposed`
- Whether the machine that wrote `56bf5be` still exists — decides recover vs reconstruct above

## Planning docs — committed, unpushed, undecided

`docs/adr/0004-hosting.md`, `docs/adr/0005-key-custody.md`,
`docs/adr/0006-field-app-offline.md`, `docs/cloud-architecture.md` — written
2026-08-18, committed in `1be4705` and `d70bc82` on local branch
`docs/cloud-architecture`, not pushed and not merged to `main`. All
`status: proposed`. They describe Vercel + Neon + R2 + Clerk + KMS hosting, key
custody, and an Expo offline-first technician app. Decisions, not
implementations: no code in the repository depends on any of them yet.

## Not started

Technician mobile app · service and dispatch · inventory · purchasing · POS and payments

## Next up

1. Resolve the three missing files: locate the originating machine and push, or
   reconstruct `crypto.ts`, `env.ts`, and migration 0006 from the schema and ADR 0003
2. Push `docs/cloud-architecture` (or merge to `main` and push) so ADRs 0004–0006
   and the session protocol stop living only on this machine
3. Real authentication on the gate code reveal endpoint — blocks the mobile app (ADR 0003)
4. Run discovery against real Evosus, correct `mappings/evosus.ts`, read the issue report
