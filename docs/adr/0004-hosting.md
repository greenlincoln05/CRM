# 0004 — Managed hosting: Vercel, Neon, R2, Clerk

Status: accepted
Date: 2026-08-18 (proposed), 2026-08-18 (accepted)

## Context

The application has to run somewhere other than a laptop. It is a Next.js 15 app
and a Postgres database, with photo storage and an authentication hole to fill.

The load is small and will stay small: a busy week is under a thousand
transactions, against tens of thousands of customers and around thirty users.
Nothing here needs horizontal scaling, a queue, or a cache.

What it does need is to keep running while the person who built it is selling
stoves. One person operates this, seasonally, without a Docker install on their
own machine. Infrastructure that requires attention is infrastructure that will
not get it.

The realistic options were a single VM running everything, a container platform
like Fly or Render, or managed services stitched together.

## Decision

Managed services, one per concern:

- **Vercel** for the Next.js app, US East region.
- **Neon** for Postgres, US East, with branching.
- **Cloudflare R2** for photos and documents.
- **Clerk** for identity.
- **AWS KMS** for the field encryption key (ADR 0005).

The ETL stays on the shop server as a scheduled task. It needs LAN access to
Evosus and there is no reason to give the cloud a route into that machine.

## Why not a single VM

A $20 VM running `next start`, Postgres, and Caddy would work, cost less, and
put everything in one place that is easy to reason about. It is genuinely the
better choice for a developer who enjoys owning a machine.

It is the wrong choice here because of who is on call. That VM needs security
updates, Postgres upgrades, certificate renewal, disk monitoring, and a backup
regime that someone actually verifies. Each is small. Together they are a
standing obligation that competes with running a store during the exact months
the system matters most.

The managed bill — call it a hundred dollars a month — buys the removal of that
obligation. Against a business doing this volume, that is not a close call.

## Why Neon specifically

Three reasons beyond it being managed Postgres.

Branching pairs with Vercel preview deployments: every pull request gets a real
database with the real schema, seeded from `npm run etl -- demo` rather than
from customer records. That is a meaningful safety property when the same person
writes and reviews everything.

Scale-to-zero on non-production branches suits a seasonal business with genuinely
quiet months.

And it was already the assumption in `packages/db/src/index.ts`, so nothing in
the data layer changes. `DATABASE_URL` gets set and the same code runs.

## Consequences

Five vendors instead of one machine. Each is a login, a bill, and an account
that can be lost. The mitigation is boring and necessary: one password manager,
recovery codes stored offline, and a second person who can get in — noted as an
open question in the architecture doc because it is not a software problem.

Vendor lock-in is real but shallow. The app is standard Next.js, the database is
standard Postgres with standard extensions, and R2 speaks the S3 API. Moving to
a VM later is a weekend, not a rewrite. The one genuinely sticky choice is
Clerk, because user identity migrations are always unpleasant — which is the
argument for the `app_user.external_id` indirection the schema already has.

The Clerk instance must be created **invite-only**, with public sign-ups
disabled, and stay that way. First sign-in auto-provisions an active staff
account (`apps/web/lib/auth.ts`), and any active account can reveal gate
codes — the sign-up switch in the Clerk dashboard is part of the security
model, not a preference.

Preview environments must never contain real customer data. They are shared by
URL and will end up somewhere they shouldn't. The synthetic legacy dataset that
already exists for the demo pipeline is what they get.

The seasonal deploy calendar applies to the platform too. Provider migrations,
tier changes, and region moves happen January through March.
