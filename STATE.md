# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 1 (customer, timeline, property profiles, photos), in progress.

## Branch position

HEAD is on local branch `docs/cloud-architecture` at `d70bc82`, two commits ahead
of `main` (`1be4705`, `d70bc82`). No upstream; nothing on it is pushed. `main` is
still `56bf5be` = `origin/main`. Working tree carries this session's
reconstruction, uncommitted as of this snapshot: modified `.gitignore`, plus new
`packages/db/src/crypto.ts`, `packages/db/src/env.ts`,
`packages/db/migrations/0006_encrypt_sensitive_fields.sql`,
`packages/db/migrations/meta/0006_snapshot.json`.

## Working

- Domain model: customer, contact, address, property, property equipment, timeline, attachments, water tests
- Fuzzy customer search in `search_customers()`, tested, through migration 0005
- Append-only timeline, enforced by trigger
- Legacy transform + normalizers, 36 data-quality checks passing on synthetic data
- Web app: search, customer detail, timeline — runs at http://localhost:3100
- Gate code reveal flow in the web app: page payload carries a boolean, reveal is an explicit POST, value re-hides after a minute
- Gate code encryption, reconstructed 2026-08-18 (see below): AES-256-GCM in
  `packages/db/src/crypto.ts`, wire format `v1:` + base64(iv||ct||tag), null
  passthrough; `LCP_FIELD_KEY` from env with a persisted dev-only key fallback at
  `.pgdata/dev-field-key` when no `DATABASE_URL`
- `packages/db/src/env.ts` — `loadRepoEnv`, repo-root `.env` parser, BOM-safe
- Migration 0006 (`gate_code` → `gate_code_enc`, `sensitive_access_log` +
  append-only trigger) with a hand-built `meta/0006_snapshot.json`;
  `drizzle-kit generate` reports "No schema changes"

Verified this session: fresh `.pgdata` migrate passes all 7 migrations; etl demo
36/36 PASS including `v1:` format and decrypt roundtrip; `tsc` clean in db, etl,
web; append-only trigger on `sensitive_access_log` blocks UPDATE and DELETE
(probed directly).

**Caveat.** This is a reconstruction of files lost from commit `56bf5be`.
Ciphertext written by the original lost implementation is not guaranteed to
decrypt under this one. Only synthetic demo data ever existed, so nothing real
is lost. Noted in the `crypto.ts` header.

**Root cause of the loss, fixed.** `.gitignore`'s stock Visual Studio section
contained the NuGet rule `**/[Pp]ackages/*`, which silently ignored every new
file under `packages/`. The rule is deleted with an explanatory comment; the
three files are now visible to git. Repo-reviewer findings all addressed:
gitignore trap (fixed), missing snapshot (built), cache-before-validate in
`crypto.ts` (fixed), BOM handling in `env.ts` (fixed).

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs

## Blocked on a human

- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export
- `LCP_FIELD_KEY` backed up offline. ADR 0005 proposes KMS-wrapped with a sealed offline copy — proposed, not accepted, and nothing is implemented
- Identity provider. ADR 0004 proposes Clerk — proposed, not accepted. The reveal endpoint records `unauthenticated-dev` until this lands
- Whether to accept ADRs 0004, 0005, 0006 — committed on `docs/cloud-architecture`, still `status: proposed`

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

1. Commit the reconstruction, then push `docs/cloud-architecture` (or merge to
   `main` and push) — until pushed, the recovered files again exist on only one machine
2. Real authentication on the gate code reveal endpoint — blocks the mobile app (ADR 0003)
3. Run discovery against real Evosus, correct `mappings/evosus.ts`, read the issue report
