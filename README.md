# Lake Champlain Pools, Spas & Stoves — platform demo

A demonstration of a modern operating platform for a pool, spa & stove
retailer replacing a legacy system (Evosus). It emulates production-level
software — real schema, encryption, offline sync, authorization — while
running entirely on a laptop, on synthetic data. Nothing is deployed and no
real customer record has ever entered it.

**Start with [`DEMO.md`](DEMO.md)** — the unified context: what this demo
contains, the status of every feature goal, the architecture decisions, and
the process that built it. The business requirements it aims at are in
[`CORE.md`](CORE.md).

## Quick start

Node 22+. No Docker, no Postgres install — development runs on embedded
PGlite (real Postgres 17 compiled to WASM).

```bash
npm install
npm run db:migrate
npm run etl -- demo
```

The app requires a sign-in, and there is no sign-up form on purpose
(ADR 0005). Create the first account:

```bash
npm run db:user -- add --email you@example.com --name "Your Name" --role admin --pin 4417
```

```bash
npm run dev -w @lcp/web
```

The back office runs at http://localhost:3100 and the technician app at
http://localhost:3100/tech — open that one on a phone, or in a narrow
browser window, and install it to the home screen.

> PGlite allows a single writer. Stop the dev server before running
> `npm run etl`, or the ETL cannot open the database.

The demo command runs the entire migration pipeline end to end against
synthetic legacy data built to mimic twenty-year-old records — 7-digit
phone numbers, ZIPs missing a leading zero, two people in one name field,
orphaned invoices — and then verifies the result. It is the fastest way to
see what the system does.

## Commands

```bash
npm run db:migrate                  # apply migrations
npm run db:studio                   # browse the database
npm run db:user -- list             # staff accounts, and who is signed in
npm run etl -- demo                 # full pipeline on synthetic data
npm run etl -- report               # data quality worklist
npm run check                       # typecheck all packages, then both smoke suites
```

> `npm run check` truncates and rebuilds the database it runs against.
> Point `PGLITE_DIR` somewhere scratch if that is not your dev data.

## Layout

```
packages/db     schema, migrations, database client, write layer, crypto
packages/etl    legacy discovery, extraction, transform, data quality
apps/web        office app and the technician PWA
docs/adr/       why things are the way they are
archive/        superseded versions of rewritten documents
```

Working sessions on this repo follow the protocol in [`CLAUDE.md`](CLAUDE.md).
The previous long-form README is preserved at
[`archive/README-2026-08-20.md`](archive/README-2026-08-20.md).
