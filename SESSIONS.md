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
