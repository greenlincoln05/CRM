# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 1 (customer, timeline, property profiles, photos) plus Sprint 2 writes and
a technician PWA. Phase 2 (service and dispatch) not started.

## Branch position

HEAD is on `main` at `869a84b` = `origin/main` — the merge of Sprint 2 (pushed
by another session) with this branch's KMS key custody work. Preceding commits:
`04f43ee` (key custody + cloud claims), `308e5b5`, `bad6f48` (Sprint 2), `622e6b7`,
`566bfb6`. `docs/cloud-architecture` is stale at `d32e2bc` and can be deleted.

This session's ADR renumbering and Clerk removal are in the working tree,
uncommitted: modified `.claude/agents/cutover-planner.md`,
`.claude/agents/sensitive-data-guard.md`, `.env.example`, `README.md`,
`apps/web/app/api/gate-code/route.ts`, `apps/web/instrumentation.node.ts`,
`apps/web/package.json`, `docs/adr/0003-sensitive-fields.md`,
`docs/adr/0006-field-app-offline.md`, `docs/cloud-architecture.md`,
`package-lock.json`, `packages/db/src/crypto.ts`, `packages/db/src/keytool.ts`,
`packages/db/src/kms.ts`, `packages/etl/src/extract.ts`,
`packages/etl/src/sensitive.ts`; deleted `apps/web/lib/auth.ts` and
`apps/web/lib/require-auth.tsx`; renamed `docs/adr/0004-hosting.md` →
`0007-hosting.md` and `docs/adr/0005-key-custody.md` → `0008-key-custody.md`.

## Working

- Domain model: customer, contact, address, property, property equipment, timeline, attachments, water tests, work orders
- Writable app (Sprint 2): customers, contacts, properties, timeline, water tests
- Staff authentication: PIN + server-side session (`apps/web/lib/session.ts`,
  `getSessionUser()`), ADR 0005 — this is the live auth system
- Offline technician PWA with photo sync (Sprint 2)
- Fuzzy customer search in `search_customers()`, migrations through 0009
- Append-only timeline and `sensitive_access_log`, enforced by trigger
- Gate code encryption: AES-256-GCM in `packages/db/src/crypto.ts`, `v1:` +
  base64(iv||ct||tag), null passthrough. Reconstruction caveat still stands —
  ciphertext from the original lost implementation is not guaranteed to decrypt;
  only synthetic data ever existed
- Gate-code reveal route: Sprint 2's `getSessionUser()` as the live auth, plus
  KMS unwrap (503 with its own message), uuid validation (400 not 500), and a
  redacted audit reason (no customer name written into an append-only table)
- Legacy transform + normalizers, 42 data-quality checks passing on synthetic data

## Key custody (ADR 0008, formerly 0005)

- `packages/db/src/kms.ts`; `initFieldKey()` in `crypto.ts`;
  `apps/web/instrumentation.node.ts` unwraps at startup
- `packages/db/src/keytool.ts` — `npm run key -- generate|verify` mints, wraps,
  and self-verifies, prints the raw key once to stderr, refuses CI and pipes, and
  refuses to overwrite without `--force`
- ETL leak found and closed: ADR 0005's core claim was false — the ETL landed
  Evosus rows verbatim, so `legacy_row.payload` held every gate code in cleartext
  and `import_issue.payload` copied them again. `packages/etl/src/sensitive.ts`
  now encrypts at the boundary and redacts them from issue payloads; the demo
  asserts it

## Cloud compliance (commit 04f43ee)

- `db:migrate` refuses to migrate an embedded PGlite database in a deploy/CI
  context instead of printing "ok" while production stays unmigrated
- `vercel.json` runs migrations for production builds only, so a preview branch
  cannot migrate the real database
- Serverless pool sizing for Neon's pooled endpoint is parsed so an empty
  `DB_POOL_MAX` cannot yield a zero-connection pool
- `.vercelignore` keeps `data/` and `.pgdata/` off a CLI deploy
- Verified clean: `drizzle-orm/pglite` is an optional peer dep, so production
  without PGlite is safe

## Clerk is gone from the code

The Clerk implementation was deleted this session — `apps/web/lib/auth.ts`,
`apps/web/lib/require-auth.tsx`, the `@clerk/nextjs` dependency, and the
`.env.example` block. Sprint 2's PIN auth is the live system and running two auth
systems is worse than either. ADR 0007 (hosting) now states plainly that Clerk is
chosen but **not implemented**. Auth attribution corrected in ADRs 0003, 0006,
0008, `docs/cloud-architecture.md`, and both affected agent files. The only
remaining Clerk references are the `external_id` schema comments in
`packages/db/src/schema/timeline.ts`, which are correct — the column stays for a
future provider.

`packages/db/migrations/0007_auth_external_id.sql` was deleted: Sprint 2 rewrote
the `app_user` block, dropped the `external_id` unique index from the schema, and
its journal never carried the tag, so the file was inert and duplicated a
migration number. If an identity provider is adopted, the unique index should
come back as a new migration.

## ADR numbering

Renumbered to clear collisions with Sprint 2's ADRs: `0004-hosting` →
`0007-hosting`, `0005-key-custody` → `0008-key-custody`. Sprint 2 owns
`0004-mobile-platform` and `0005-staff-authentication`, so every reference was
updated per-file rather than by blind replacement. No number collisions remain.

## Verified this session

`npm run typecheck` passes · `npm run smoke` passes both suites · etl demo 42/42 ·
production build compiles · no ADR number collisions · no dangling Clerk
references except the intentional `external_id` schema comments.

## Contradiction — needs a decision

ADR 0004 (mobile platform) and ADR 0006 (offline field app) reach **different
conclusions about the same app**: 0006 chose Expo/React Native and explicitly
rejected a PWA; Sprint 2 shipped a PWA. Two accepted ADRs contradict each other
and the code follows one of them. Unresolved.

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs

## Blocked on a human

- Resolve the ADR 0004 vs 0006 contradiction (PWA vs Expo) — one must be superseded
- The KMS key does not exist yet, and the sealed offline copy of the raw key has
  not been made. That is a physical act only Lincoln can do
- Key rotation is unwritten, which makes `key generate --force` destructive
- Nothing is provisioned: no Vercel, Neon, R2, or AWS account
- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export

## Incident log

2026-08-18: `.pgdata` corrupted by two concurrent writers — a taskkill of the npm
wrapper left next.js alive holding the PGlite lock, the single-writer gotcha
CLAUDE.md warns about. Rebuilt from scratch; dev field key regenerated with it;
synthetic data only, no loss.

## Not started

Service and dispatch · inventory · purchasing · POS and payments

## Next up

1. Resolve ADR 0004 vs 0006 — supersede one, and say which the PWA in the repo satisfies
2. Generate the KMS key and make the sealed offline copy; write key rotation
   before `key generate --force` can hurt someone
3. Provision the cloud accounts (Vercel, Neon, R2, AWS) so ADR 0007 stops being theoretical
4. Run discovery against real Evosus, correct `mappings/evosus.ts`, read the issue report
