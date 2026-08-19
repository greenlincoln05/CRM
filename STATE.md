# State — as of 2026-08-18

Snapshot. Overwritten each session by `session-scribe`. The log lives in `SESSIONS.md`.

## Phase

Phase 1 (customer, timeline, property profiles, photos), in progress.

## Branch position

HEAD is on `main` at `e8cf99f` = `origin/main` — main is whole and pushed; a
fresh clone builds and migrates again. `docs/cloud-architecture` is also pushed
(`origin/docs/cloud-architecture` at `d32e2bc`). The working tree carries this
session's authentication work, uncommitted as of this snapshot: modified
`.env.example`, `README.md`, `apps/web/app/api/gate-code/route.ts`,
`apps/web/app/api/search/route.ts`, `apps/web/app/customers/[id]/page.tsx`,
`apps/web/app/page.tsx`, `apps/web/package.json`, `docs/adr/0003-sensitive-fields.md`,
`docs/adr/0004-hosting.md`, `package-lock.json`,
`packages/db/migrations/meta/_journal.json`, `packages/db/src/schema/timeline.ts`;
new `apps/web/lib/auth.ts`, `apps/web/lib/require-auth.tsx`,
`apps/web/middleware.ts`, `packages/db/migrations/0007_auth_external_id.sql`,
`packages/db/migrations/meta/0007_snapshot.json`.

## Working

- Domain model: customer, contact, address, property, property equipment, timeline, attachments, water tests
- Fuzzy customer search in `search_customers()`, tested, through migration 0007
- Append-only timeline, enforced by trigger
- Legacy transform + normalizers, 36 data-quality checks passing on synthetic data
- Web app: search, customer detail, timeline — runs at http://localhost:3100
- Gate code encryption (reconstructed 2026-08-18): AES-256-GCM in
  `packages/db/src/crypto.ts`, wire format `v1:` + base64(iv||ct||tag), null
  passthrough; `LCP_FIELD_KEY` from env with a persisted dev-only key fallback at
  `.pgdata/dev-field-key` when no `DATABASE_URL`. Caveat: reconstruction —
  ciphertext from the original lost implementation is not guaranteed to decrypt;
  only synthetic data ever existed, nothing real lost
- Authentication per ADR 0004 (accepted this session), Clerk path written but
  unexercised (see below):
  - `apps/web/lib/auth.ts` — `currentAppUser`: Clerk when BOTH keys set;
    half-configured fails closed; `DATABASE_URL` without Clerk fails closed;
    dev identity only on embedded PGlite and never in production builds
  - `apps/web/lib/require-auth.tsx` — page gate
  - `apps/web/middleware.ts` — `clerkMiddleware` when configured, passthrough
    otherwise; documented as convenience, not enforcement
  - Auth checks on all data surfaces: gate-code reveal, `/api/search`, customer
    page, home page
  - Gate-code route logs real `user_id` FK, validates uuid (400 not 500), no
    longer names env vars to clients or embeds customer names in the append-only log
  - Migration 0007 (unique index `app_user.external_id`), drizzle-kit generated
    with snapshot; `@clerk/nextjs` 7.7.8 added; `.env.example` and README
    status table updated

Verified this session (8 runtime probes): dev reveal 200 with FK-backed log row;
dev search 200; bad uuid 400; home 200; with bogus `DATABASE_URL` and no keys:
reveal 401, search 401, home renders "Sign in required"; half-configured
(secret only) 401. `tsc` clean everywhere; production build compiles; demo
36/36; migrate passes through 0007 (8 migration files total).

Reviewed: sensitive-data-guard and repo-reviewer both ran; all blocks-commit and
breaks-production findings fixed (fail-closed originally covered only the reveal
endpoint; half-configured keys 500ed; unescaped dot in the middleware matcher
let paths like `/sitemap` bypass; the invite-only assumption was undocumented).

## Clerk path is written but unexercised

No Clerk instance exists yet. Until one does, the Clerk branch of
`currentAppUser` has never run. Needed: create an invite-only Clerk instance
(public sign-ups disabled — first sign-in auto-provisions an active staff
account, and any active account can reveal gate codes), then keys into
`apps/web/.env.local` locally and Vercel env in production. The reveal is
deliberately role-agnostic until Phase 2 dispatch gives jobs to scope to. Both
conditions are recorded in ADRs 0003 and 0004.

## Written but never run against a real Evosus server

- Evosus schema discovery (`etl -- discover`)
- SQL Server extract (`extract:mssql`). The CSV path is tested; MSSQL is not
- Every candidate column name in `packages/etl/src/mappings/evosus.ts` is a guess until discovery runs

## Blocked on a human

- Create the invite-only Clerk instance and supply keys (see above)
- Read-only credentials and network access to the on-prem Evosus SQL Server, or a vendor CSV export
- `LCP_FIELD_KEY` backed up offline. ADR 0005 proposes KMS-wrapped with a sealed offline copy — still proposed, not accepted, nothing implemented
- Whether to accept ADRs 0005 and 0006 (0004 was accepted 2026-08-18)

## Incident log

2026-08-18: `.pgdata` corrupted mid-session by two concurrent writers — a
taskkill of the npm wrapper left next.js alive holding the PGlite lock, exactly
the single-writer gotcha CLAUDE.md warns about. Rebuilt from scratch; the dev
field key regenerated with it; synthetic data only, no loss.

## Not started

Technician mobile app · service and dispatch · inventory · purchasing · POS and payments

## Next up

1. Create the invite-only Clerk instance and exercise the auth path end to end
2. Decide ADR 0005 (`LCP_FIELD_KEY` custody)
3. Run discovery against real Evosus, correct `mappings/evosus.ts`, read the issue report
