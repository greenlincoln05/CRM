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
