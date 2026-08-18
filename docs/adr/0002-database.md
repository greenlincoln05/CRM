# 0002 — Postgres, with embedded PGlite for development

Status: accepted
Date: 2026-08-18

## Context

The largest single complaint about Evosus is customer lookup: it requires exact
information, and staff want Google-style fuzzy search with predictive typing.

The developer is also the business operator, on Windows, without Docker.

## Decision

Postgres, with `pg_trgm` and `unaccent`.

Development runs on PGlite — genuine Postgres 17 compiled to WASM, embedded as
an npm dependency. Same SQL, same extensions, same migrations, nothing to
install. Production sets `DATABASE_URL` and the identical code talks to a real
server.

Search lives in a database function, `search_customers()`, not in application
code.

## Why not a search service

Typesense or Elasticsearch would be faster at a million customers. This business
has tens of thousands. A second datastore means a second thing to run, back up,
and keep in sync, for a problem Postgres solves at this scale. `pgvector` is
available in the same database when semantic search arrives in Phase 4.

## Notes

- `word_similarity()` rather than `similarity()`. Comparing a short query against
  a long concatenated haystack always scores near zero with the latter.
- The 0.35 threshold is scoped to the search function via a `SET` clause, so
  tuning search cannot shift behaviour anywhere else in the database.
- PGlite uses the extended query protocol: one statement per call. Custom
  migrations need `--> statement-breakpoint` between every statement.
