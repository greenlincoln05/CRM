# Working on this repository

Lake Champlain Pools, Spas & Stoves — a demo of the operating platform replacing
Evosus. One customer. One timeline. One workflow.

This repository is a demonstration: it emulates production-level software while
running entirely locally on synthetic data. The scenario it models — one person
building this while running the store, in short, far-apart sessions — drives
everything below.

## Read first

- `DEMO.md` — the unified context: what the demo contains, feature status,
  architecture digest, process, honest limits
- `CORE.md` — the business requirements the demo is built against
- `README.md` — landing page and quick start
- `docs/adr/` — why things are the way they are. All accepted: `0001` strangler
  fig, `0002` database, `0003` sensitive fields, `0004` mobile platform, `0005`
  staff authentication, `0006` field app offline, `0007` hosting, `0008` key
  custody, `0009` gate-code scoping (supersedes a condition in `0003`), `0010`
  who may dispatch. Note
  `0004` and `0006` reach different conclusions about the same app —
  unresolved, see `STATE.md`
- `docs/cloud-architecture.md` — the deployment picture the ADRs assume
- `STATE.md` — where the work actually is right now
- `SESSIONS.md` — the log of what happened, newest last

## Session protocol

**Start:** run `session-scribe` in OPEN mode. It reconciles `STATE.md` against
git and reports drift. Do not trust `STATE.md` on its own.

**End:** run `session-scribe` in CLOSE mode. It rewrites `STATE.md` and appends
to `SESSIONS.md`. A session that ends without this loses its context.

`STATE.md` is a snapshot and gets overwritten. `SESSIONS.md` is a log and only
gets appended to. Decisions become ADRs in `docs/adr/`, numbered, never edited
in place once accepted — supersede instead.

## Which agent

Start with `orchestrator` when the work touches more than one layer — it returns a
plan naming who does what, in the order the seams require.

| Work | Agent |
|---|---|
| Decomposing a feature, deciding who does what | `orchestrator` |
| Start or end a session, "where were we" | `session-scribe` |
| Tables, columns, migrations, search behaviour | `schema-steward` |
| Write layer, server actions, routes, queries, session | `backend-builder` |
| Office pages, technician PWA, forms, CSS | `frontend-builder` |
| Hosting, env vars, deploy config, KMS/R2/Neon | `cloud-architect` |
| Evosus discovery, extract, mappings, transform | `migration-engineer` |
| Reading an ETL run's issue report, deciding what to fix | `data-quality-analyst` |
| Anything touching gate codes, access notes, photos, PII | `sensitive-data-guard` |
| What to build next, phase sequencing, build vs buy | `cutover-planner` |
| **Every code change, before it is pushed** | `repo-reviewer` |

The builders do not commit and do not push. They finish, verify, and hand the diff
to review.

## The review gate

Nothing reaches the remote unreviewed, and that is enforced rather than trusted:
a `PreToolUse` hook blocks `git push` unless `.claude/review-state.json` records a
review of the exact commit being pushed.

The hook lives in **user settings** (`~/.claude/settings.json`, script at
`~/.claude/hooks/review-gate.mjs`) rather than in this repo. Project settings only
load for a session whose project root is that project, so a repo-local gate is
silently absent whenever Claude Code is started from somewhere else — which is
how three pushes went out unreviewed here before anyone noticed. A global gate
has no such gap, and it covers every repository on the machine.

```
build  →  verify  →  commit  →  repo-reviewer  →  mark  →  push
```

After a review is done and its findings are fixed or consciously accepted:

```bash
node ~/.claude/hooks/mark-reviewed.mjs repo-reviewer
```

Add `sensitive-data-guard` as a second reviewer whenever the change touches gate
codes, access notes, photos, or PII — and name both when marking.

Commit again and the marker goes stale, so an amend or one-more-small-fix re-arms
the gate. That is the intent: commit 56bf5be lost three files to a push nobody
checked, and the repo has been paying for it since.

Three honest limits.

1. It sees only what Claude Code runs through its shell tools. A push typed into
   a terminal is untouched, and so is one inside a script the model merely
   invokes.
2. The marker is an ordinary file, so anything that can write files can clear it
   without a review. This stops the accident, not a determined bypass.
3. Registering the hook needs a restart — settings are read at startup. Edits to
   the script itself take effect immediately, since it is re-executed per tool
   call.

A repository opts out with `.claude/review-gate-off`. That file can be committed,
which would disable the gate for every clone; legitimate, but review it like
anything else. Install and reasoning live in `tools/review-gate/` — the scripts
are versioned there and copied to `~/.claude/hooks/`, not loaded from the repo.

## Non-negotiables

1. **Evosus is read-only.** Nothing in this repository writes to it. The account
   it connects with should not have permission to.
2. **The ETL is idempotent.** Everything upserts on `(legacy_source, legacy_id)`.
   Running a transform twice produces the same database, not two copies of the
   business.
3. **Bad data becomes an `import_issue` row**, never an exception and never a
   silent null. Fix the mapping, re-run, re-read. That loop is the migration.
4. **Gate codes are the means of physical entry to several hundred homes.**
   Encrypted at rest, logged on every reveal, never in a list view, an export, a
   log line, or an AI context window. See ADR 0003.
5. **`data/`, `.env`, `.pgdata/` never leave this machine.** Real customer
   records. Not in a commit, not on a shared drive, not pasted into a document.
6. **Anything touching money cuts over January–March**, outside pool season
   (April–September) and stove season (September–December).

## Local gotchas

- **PGlite is single-writer.** Stop `npm run dev -w @lcp/web` before running
  `npm run etl`, or the ETL cannot open the database.
- **An applied migration is immutable.** Drizzle decides what to run by
  comparing the journal's `when` against the newest applied row; it stores a
  file hash and never reads it back. So editing a migration a database has
  already run is a silent no-op there — `[migrate] ok`, and the database keeps
  behaving like the version that actually ran. Land the change as a NEW
  migration (`CREATE OR REPLACE FUNCTION` for search changes). `npm run
  db:migrate` now warns when it sees this, but the warning is a backstop, not
  permission. Same rule as ADRs: supersede, never edit in place. The warning is
  hash-based, so it also fires on a comment-only edit; that is harmless to the
  database and still means the file no longer matches what ran.
- Hand-written migrations need `--> statement-breakpoint` between every
  statement. PGlite runs one statement per call.
- Query results are unwrapped with `(r?.rows ?? r)` — the two drivers differ.
- Date-only legacy values are pinned to local noon in `America/New_York`. UTC
  midnight renders a day early in Eastern.
- Node 22+. No Docker, no local Postgres install.

## Before you commit

Run `repo-reviewer`. It checks the failure modes that pass locally and break for
a fresh clone: untracked files the build imports, migration journal entries with
no `.sql` file, non-idempotent writes, driver-shape assumptions.
