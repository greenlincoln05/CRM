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
