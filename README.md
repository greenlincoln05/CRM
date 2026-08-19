# Lake Champlain Pools, Spas & Stoves — operating platform

Replacement for Evosus, built in phases. One customer. One timeline. One workflow.

## Where this is

**Phase 1, in progress.** The customer/property/timeline core, the legacy data
migration, and the counter app are working and tested. Staff can now sign in and
edit records, so everything written from the app carries a name.

| Piece | State |
|---|---|
| Domain model (customer, property, contact, address, timeline, photos, water tests) | working |
| Fuzzy customer search | working, tested |
| Append-only timeline | working, enforced in the database |
| Evosus schema discovery | written, needs a real server to run against |
| Legacy extract (SQL Server + CSV) | written, CSV path tested |
| Legacy transform + data quality reporting | working, 41 checks passing |
| Web app (search, customer detail, timeline) | working |
| Staff sign-in, sessions, actor on every write | working, tested |
| Creating and editing customers, contacts, properties | working, tested |
| Timeline entry, pinning, manager-only redaction | working, tested |
| Water tests with out-of-range flagging | working, tested |
| Gate-code encryption + access log | working |
| Work orders and checklists | minimal model, enough for the mobile app |
| Technician PWA (offline, photos, checklists) | working |
| Inventory, purchasing, POS | not started — see the roadmap |

## Quick start

Nothing to install beyond Node 22+. No Docker, no Postgres — development runs
on embedded PGlite, which is real Postgres 17 compiled to WASM.

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run etl -- demo
```

The app requires a sign-in, and there is no sign-up form on purpose (ADR 0005).
Create the first account:

```bash
npm run db:user -- add --email you@example.com --name "Your Name" --role admin --pin 4417
```

```bash
npm run dev -w @lcp/web
```

The back office runs at http://localhost:3100 and the technician app at
http://localhost:3100/tech — open that one on a phone, or in a narrow browser
window, and install it to the home screen.

> PGlite allows a single writer. Stop the dev server before running `npm run etl`,
> or the ETL cannot open the database. This does not apply once `DATABASE_URL`
> points at a real Postgres.

The demo command runs the entire migration pipeline end to end against
synthetic legacy data built to mimic twenty-year-old records — 7-digit phone
numbers, ZIPs missing a leading zero, two people in one name field, orphaned
invoices — and then verifies the result. It is the fastest way to see what the
system does.

## Layout

```
packages/db     schema, migrations, database client
packages/etl    Evosus discovery, extraction, transform, data quality reports
apps/           web and mobile (not yet started)
docs/adr/       why things are the way they are
```

## The migration, in one paragraph

Evosus keeps running. A read-only extract lands its rows verbatim in a staging
table as JSONB, tagged with a batch id. Transforms read staging and upsert into
the real domain model, keyed on the original Evosus id so re-running is safe and
produces no duplicates. Everything the transform could not make sense of becomes
a row in `import_issue` rather than an exception or a silent null, and
`npm run etl -- report` turns those into a worklist. Fix the mapping, re-run,
re-read. That loop is the entire strategy.

## Commands

```bash
npm run db:migrate                  # apply migrations
npm run db:studio                   # browse the database
npm run db:user -- list             # staff accounts, and who is signed in
npm run etl -- discover             # profile the on-prem Evosus database
npm run etl -- transform            # legacy staging -> domain model
npm run etl -- report               # data quality worklist
npm run etl -- demo                 # full pipeline on synthetic data
npm run check                       # typecheck all packages, then both smoke suites
```

Run against real Postgres instead of embedded by setting `DATABASE_URL`.

### Staff accounts

```bash
npm run db:user -- add --email dana@example.com --name "Dana Whitcomb" --role manager
npm run db:user -- pin --email dana@example.com        # reset a PIN, ends their sessions
npm run db:user -- deactivate --email dana@example.com # leaver: ends their sessions too
```

Set `LCP_PIN` in the environment rather than passing `--pin`, unless you want the
PIN in your shell history. Roles are `admin`, `manager`, `staff`, `tech`; the only
thing the role currently gates is hiding a timeline entry.

> `npm run check` truncates and rebuilds the database it runs against. Point
> `PGLITE_DIR` somewhere scratch if that is not your dev data.

## Working with real data

Copy `.env.example` to `.env` and fill in **read-only** credentials for the
on-prem SQL Server. Nothing in this repository writes to Evosus, and the
account it connects with should not have permission to.

```bash
npm run etl -- discover
```

Read `data/discovery/schema-*.md`, then correct the candidate column names in
`packages/etl/src/mappings/evosus.ts`. That file is the only place field
mapping lives.

```bash
npm run etl -- extract:mssql --entity customer --table dbo.Customer --key CustomerID
```

If the vendor will only produce exports, `extract:csv` lands them in the same
place and everything downstream is identical.

> `./data/` holds real customer records and is gitignored. Keep it off shared
> drives.

## Roadmap

Phase 1 (now) customer, timeline, property profiles, photos, technician app
Phase 2 service and dispatch — capacity limits, parts gating, routing
Phase 3 inventory
Phase 4 POS and payments, then Evosus is decommissioned

Anything touching money cuts over between January and March, when neither pool
season nor stove season is running.
