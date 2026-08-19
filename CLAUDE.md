# Working on this repository

Lake Champlain Pools, Spas & Stoves — the operating platform replacing Evosus.
One customer. One timeline. One workflow.

Built by one person who also runs the store. Sessions are short and far apart.
That single fact drives everything below.

## Read first

- `README.md` — what works and what does not, kept honest
- `docs/adr/` — why things are the way they are. All accepted: `0001` strangler
  fig, `0002` database, `0003` sensitive fields, `0004` hosting, `0005` key
  custody, `0006` field app offline
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

| Work | Agent |
|---|---|
| Start or end a session, "where were we" | `session-scribe` |
| Tables, columns, migrations, search behaviour | `schema-steward` |
| Evosus discovery, extract, mappings, transform | `migration-engineer` |
| Reading an ETL run's issue report, deciding what to fix | `data-quality-analyst` |
| Anything touching gate codes, access notes, photos, PII | `sensitive-data-guard` |
| What to build next, phase sequencing, build vs buy | `cutover-planner` |
| Before committing anything non-trivial | `repo-reviewer` |

Web UI and general implementation stay on the main thread.

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
