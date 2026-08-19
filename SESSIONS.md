# Session log

Append only, newest at the bottom. Written by `session-scribe` at the end of each
session. Absolute dates.

---

## 2026-08-18 — Session methodology set up

**Built.** Agent roster in `.claude/agents/` (session-scribe, schema-steward,
migration-engineer, data-quality-analyst, sensitive-data-guard, cutover-planner,
repo-reviewer), `CLAUDE.md`, `STATE.md`, this log.

**Found.** Commit `56bf5be` is incomplete on the remote — `packages/db/src/crypto.ts`,
`packages/db/src/env.ts`, and `packages/db/migrations/0006_encrypt_sensitive_fields.sql`
are referenced but untracked. A clean clone does not build and `db:migrate` fails at
journal entry 6. Not fixed here; the files exist only on the machine that wrote them.

**Decided.** Nothing architectural. The agent roster encodes decisions already made in
ADRs 0001–0003 rather than adding new ones.

**Next.** Recover and push the three missing files, then real auth on the gate code
reveal endpoint.

**Also appeared, mid-session.** `docs/adr/0004-hosting.md`, `0005-key-custody.md`,
`0006-field-app-offline.md`, and `docs/cloud-architecture.md` were written into the
working tree during this session and are untracked. All `status: proposed`. Recorded
here so the next session knows they are intentions, not implemented decisions.

## 2026-08-18 — Session open: drift reconciled

**Built.** Nothing — OPEN-mode brief plus this correction. The agent roster,
session protocol, and proposed ADRs 0004–0006 from earlier today are now
committed as `d70bc82` (with `1be4705` for `docs/cloud-architecture.md`) on
local branch `docs/cloud-architecture`. Unpushed, no upstream; `main` is still
`56bf5be` = `origin/main`.

**Decided.** Nothing architectural.

**Broke / corrected.** The recovery story for the three files missing from
`56bf5be` was wrong. `packages/db/src/crypto.ts`, `packages/db/src/env.ts`, and
`packages/db/migrations/0006_encrypt_sensitive_fields.sql` are absent from this
clone's working tree and from its entire git history — this is not the machine
that has them. Options are now: locate the originating machine and push from it,
or reconstruct all three from the schema and ADR 0003, accepting that existing
`gate_code_enc` values may be unreadable if the key handling or ciphertext
format differs. This checkout does not typecheck and `db:migrate` fails at
journal entry 6.

**Next.** Recover-or-reconstruct the three files; push or merge
`docs/cloud-architecture`; then real auth on the gate code reveal endpoint.

## 2026-08-18 — Lost encryption files reconstructed, gitignore trap found

**Built.** The three files missing from `56bf5be`, reconstructed from the schema
and ADR 0003: `packages/db/src/crypto.ts` (AES-256-GCM, `v1:` + base64(iv||ct||tag)
wire format, null passthrough, `LCP_FIELD_KEY` from env with a persisted dev-only
key fallback at `.pgdata/dev-field-key` when no `DATABASE_URL`),
`packages/db/src/env.ts` (`loadRepoEnv`, repo-root `.env` parser, BOM-safe), and
`packages/db/migrations/0006_encrypt_sensitive_fields.sql` (`gate_code` →
`gate_code_enc`, `sensitive_access_log` + append-only trigger). Plus
`meta/0006_snapshot.json` hand-built to match — `drizzle-kit generate` reports
"No schema changes".

**Found.** Root cause of the loss: `.gitignore`'s stock Visual Studio section
carried the NuGet rule `**/[Pp]ackages/*`, silently ignoring every new file
under `packages/`. That is how the originals never made it into `56bf5be`. Rule
deleted with an explanatory comment; the three files are now visible to git.
Repo-reviewer findings all addressed: gitignore trap (fixed), missing snapshot
(built), cache-before-validate in `crypto.ts` (fixed), BOM in `env.ts` (fixed).

**Verified.** Fresh `.pgdata` migrate passes all 7 migrations; etl demo 36/36
PASS including `v1:` format and decrypt roundtrip; `tsc` clean in db, etl, web;
append-only trigger on `sensitive_access_log` blocks UPDATE and DELETE (probed
directly).

**Caveat.** This is a reconstruction: ciphertext written by the original lost
implementation is not guaranteed to decrypt under this one. Only synthetic demo
data ever existed, so nothing real is lost. Noted in the `crypto.ts` header.

**Decided.** Nothing architectural — the reconstruction implements ADR 0003 as
written.

**Next.** Commit and push (branch `docs/cloud-architecture` is still local-only);
real auth on the gate code reveal endpoint; run discovery against real Evosus.

**Merged.** `docs/cloud-architecture` fast-forward merged to `main` and pushed
(`56bf5be..d32e2bc`). The default branch builds again for a fresh clone; the
reconstruction survives off this machine. Both branch refs point at `d32e2bc`.

## 2026-08-18 — Authentication on every data surface; ADR 0004 accepted

**Built.** Authentication per ADR 0004: `apps/web/lib/auth.ts`
(`currentAppUser` — Clerk when BOTH keys set; half-configured fails closed;
`DATABASE_URL` without Clerk fails closed; dev identity only on embedded PGlite
and never in production builds), `apps/web/lib/require-auth.tsx` (page gate),
`apps/web/middleware.ts` (`clerkMiddleware` when configured, passthrough
otherwise — documented as convenience, not enforcement). Auth checks on all
data surfaces: gate-code reveal, `/api/search`, customer page, home page. The
gate-code route now logs a real `user_id` FK, validates uuid (400 not 500), and
no longer names env vars to clients or embeds customer names in the append-only
log. Migration 0007 (unique index `app_user.external_id`) generated via
drizzle-kit with snapshot. `@clerk/nextjs` 7.7.8 added. `.env.example` and the
README status table updated. Uncommitted at session close.

**Decided.** ADR 0004 accepted (status flipped in `docs/adr/0004-hosting.md`).
Two conditions added during review and recorded in ADRs 0003 and 0004: the
Clerk instance must be invite-only (public sign-ups disabled — first sign-in
auto-provisions an active staff account and any active account can reveal gate
codes), and the reveal is deliberately role-agnostic until Phase 2 dispatch
gives jobs to scope to.

**Reviewed.** sensitive-data-guard and repo-reviewer both ran; all
blocks-commit and breaks-production findings fixed: fail-closed originally
covered only the reveal endpoint; half-configured keys 500ed; an unescaped dot
in the middleware matcher let paths like `/sitemap` bypass; the invite-only
assumption was undocumented.

**Verified.** 8 runtime probes — dev reveal 200 with FK-backed log row; dev
search 200; bad uuid 400; home 200; bogus `DATABASE_URL` with no keys: reveal
401, search 401, home renders "Sign in required"; half-configured (secret only)
401. `tsc` clean everywhere; production build compiles; demo 36/36; migrate
passes through 0007 (8 migration files).

**Broke.** `.pgdata` corrupted mid-session by two concurrent writers — a
taskkill of the npm wrapper left next.js alive holding the PGlite lock, the
CLAUDE.md single-writer gotcha exactly. Rebuilt from scratch; dev field key
regenerated with it; synthetic data only, no loss.

**Also.** Between sessions the reconstruction was committed (`d32e2bc`), merged,
and pushed: `main` is `e8cf99f` = `origin/main` and whole again;
`docs/cloud-architecture` is pushed too. The Clerk path itself is written but
unexercised — no instance exists yet.

**Next.** Create the invite-only Clerk instance and exercise the auth path end
to end; decide ADR 0005 (`LCP_FIELD_KEY` custody); run discovery against real
Evosus.

**Decided (2026-08-18, later).** ADRs 0005 (key custody: KMS-wrapped
`LCP_FIELD_KEY`, sealed offline copy) and 0006 (offline-first Expo technician
app with an outbox) accepted. Decisions only — nothing implemented: the KMS
unwrap does not exist in code, the offline copy has not been made, the mobile
app is not started. All six ADRs are now accepted; CLAUDE.md and cross-
references updated to match.

## 2026-08-18 — Sprint 2 merged, KMS key custody, Clerk removed, ADRs renumbered

**Merged.** Another session pushed Sprint 2 to `origin/main` while this branch
worked: writable app (customers, contacts, properties, timeline, water tests),
PIN + server-side session staff auth, work orders, offline technician PWA with
photo sync. Merged at `869a84b`. Collisions resolved in the gate-code route,
which keeps Sprint 2's `getSessionUser()` as the live auth plus this branch's
KMS unwrap (503 with its own message), uuid validation (400 not 500), and a
redacted audit reason (no customer name in an append-only table).
`packages/db/migrations/0007_auth_external_id.sql` deleted — Sprint 2 rewrote
the `app_user` block, dropped the `external_id` unique index from the schema,
and its journal never carried the tag, so the file was inert and duplicated a
migration number.

**Built — cloud compliance** (before the merge, `04f43ee`). `db:migrate` now
refuses to migrate an embedded PGlite database in a deploy/CI context instead of
printing "ok" while production stays unmigrated. `vercel.json` runs migrations
for production builds only, so a preview branch cannot migrate the real
database. Serverless pool sizing for Neon's pooled endpoint is parsed so an
empty `DB_POOL_MAX` cannot yield a zero-connection pool. `.vercelignore` keeps
`data/` and `.pgdata/` off a CLI deploy. Verified clean: `drizzle-orm/pglite` is
an optional peer dep, so production without PGlite is safe.

**Built — key custody** (ADR 0008, was 0005). `packages/db/src/kms.ts`,
`initFieldKey()` in `crypto.ts`, `apps/web/instrumentation.node.ts` unwraps at
startup, and `packages/db/src/keytool.ts` (`npm run key -- generate|verify`)
mints, wraps, and self-verifies, printing the raw key once to stderr while
refusing CI and pipes and refusing to overwrite without `--force`.

**Found.** ADR 0005's core claim was false: the ETL landed Evosus rows verbatim,
so `legacy_row.payload` held every gate code in cleartext and
`import_issue.payload` copied them again. `packages/etl/src/sensitive.ts` now
encrypts at the boundary and redacts them from issue payloads; the demo asserts it.

**Deleted.** The Clerk implementation — `apps/web/lib/auth.ts`,
`apps/web/lib/require-auth.tsx`, the `@clerk/nextjs` dependency, the
`.env.example` block. Sprint 2's PIN auth is the live system and two auth
systems is worse than either. ADR 0007 now states plainly that Clerk is chosen
but not implemented.

**Renumbered.** The two colliding ADRs: `0004-hosting` → `0007-hosting`,
`0005-key-custody` → `0008-key-custody`, with every reference updated per-file —
Sprint 2 uses 0004 for mobile-platform and 0005 for staff-authentication, so
blind replacement would have corrupted theirs. Auth attribution corrected in
ADRs 0003, 0006, 0008, `docs/cloud-architecture.md`, and both affected agent
files.

**Verified.** `npm run typecheck` passes; `npm run smoke` passes both suites;
etl demo 42/42; production build compiles; no ADR number collisions; no dangling
Clerk references except the `external_id` schema comments, which are correct —
the column stays for a future provider.

**Open — needs a human.** ADR 0004 (mobile platform) and ADR 0006 (offline field
app) reached different conclusions about the same app: 0006 chose Expo/React
Native and explicitly rejected a PWA; Sprint 2 shipped a PWA. Two accepted ADRs
contradict each other and the code follows one. Unresolved. Also: the KMS key
does not exist yet and the sealed offline copy of the raw key has not been made
(a physical act only Lincoln can do); key rotation is unwritten, which makes
`key generate --force` destructive; and nothing is provisioned — no Vercel,
Neon, R2, or AWS account.

**Next.** Resolve 0004 vs 0006; generate the KMS key and seal the offline copy,
with rotation written first; provision the cloud accounts; then Evosus discovery.

## 2026-08-18 — Phase 2 first cut: the office can schedule jobs

**Built.** Three commits: `60b2914` (the build), `36a552d` (first review round),
`f223373` (second review round). HEAD is `f223373` = `origin/main`, clean.

- Migration 0010: `work_order_number_seq`, a partial unique index on number, and
  the `(legacy_source, legacy_id)` index `work_order` never had despite
  non-negotiable #2
- `packages/db/src/write/workOrders.ts` — `createWorkOrder`,
  `rescheduleWorkOrder`, `cancelWorkOrder`. Number allocated inside the INSERT,
  ownership checked, checklist seeded from job type, timeline event on every
  write. 16 new write checks
- Reads `getWorkOrders`, `getDaySchedule`, `getTechnicians` in
  `apps/web/lib/queries.ts`
- UI: Jobs section on the customer page, a new `/schedule` day board grouped by
  technician with an unassigned bucket, nav link, subtitle now
  "Phase 2 · service & dispatch"
- `packages/etl/src/seed-jobs.ts` fixed — bare `ON CONFLICT` with no inferable
  target, so it re-inserted every run

**Agents.** First run of the orchestrator + builder roster. orchestrator planned
and routed; schema-steward, backend-builder and frontend-builder built;
repo-reviewer and sensitive-data-guard reviewed twice. Both builder agents were
killed mid-task by a spend limit — frontend's work had landed, backend's had
not, and the backend fixes were finished directly.

**What review caught.** The gate earned itself. Migration 0010's sequence
started at 1001 without moving past existing numbers, so the first four office
bookings would collide on any database that ran the old seeder once — and the
fix was then off by one (two-arg `setval` marks the value used), which only the
second review caught. `CURRENT_DATE` is GMT while the board reads shop-local, so
evening seeding landed jobs on a day the board would not show; five sites. The
board rendered `instructions` / `work_performed` / `incomplete_reason` in full —
free text is how a gate code typed into a sentence bypasses the encrypted column
and lands on a list of forty addresses; the board now links instead, and both
free-text inputs carry a warning. The first error-logging fix logged
`err.message`, which in drizzle IS the statement plus every parameter, the exact
leak it claimed to prevent. The new ADR 0003 regression test could pass
vacuously two ways.

**Docs.** ADR 0003's status section rewritten — points 4 and 5 were described as
open when both are half done, and its own deferral of per-job scoping has come
due now that dispatch exists: `/api/tech/photo` scopes to the assigned job,
`/api/gate-code` still does not. README status table and layout corrected.

**New, worth carrying.** `incomplete_reason` has no write path from the phone
yet — TechApp has a bare "Couldn't finish" button and the field only arrives via
the sync endpoint or seeded data. The dispatch UI for it is built ahead of its
source.

**Still open, unchanged.** ADR 0004 vs 0006 contradiction; KMS key generation and
the sealed offline copy; key rotation unwritten, so `key generate --force` is
destructive; no cloud accounts provisioned; Evosus discovery needs credentials.

**Next.** A phone write path for `incomplete_reason`; per-job scoping on
`/api/gate-code`; resolve 0004 vs 0006; generate and seal the KMS key.

**Correction to the entry above.** It credited "the gate" with catching the
Phase 2 findings. Those came from running the `repo-reviewer` and
`sensitive-data-guard` agents by hand; the hook itself never executed once
during that work. It was installed in this repo's `.claude/settings.json`, and
project settings load only for a session whose project root is that project —
this session is rooted at the home directory, so the file was read by nothing
and three pushes went out unreviewed while the gate appeared to be in place.

Fixed by moving it to `~/.claude/settings.json`, where it covers every
repository regardless of where a session is rooted. It first actually blocked a
push at commit 34c4f87. Reviewing that move then turned up four more holes in
the global version: it failed OPEN on every phrasing it could not parse
(`pushd`, `Set-Location`, a second `cd`, cygdrive and WSL prefixes), a clean
marker in any other repository acted as a skeleton key for this one,
`mark-reviewed` deadlocked permanently inside a git worktree, and its own
recovery instructions did not run in PowerShell. All closed. A gate that is
believed while doing nothing is worse than no gate, which is the whole lesson
of this stretch.
