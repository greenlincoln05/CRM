# Cloud architecture

How this runs in production, and why it is deliberately small.

## What this has to be

The load is not the problem. A busy week is 600-900 retail transactions, 50-80
service calls, and 15-20 deliveries, against tens of thousands of customers and
maybe thirty people who log in. A single Postgres instance and one web process
handle that with room to spare, and will keep handling it after Evosus is gone.

The actual constraints are different ones:

**One person operates this, and that person also runs the store.** Every piece
of infrastructure has to survive being ignored for a month in July. Anything
that needs patching, tuning, or a 6am restart on a Saturday in June is
disqualified regardless of technical merit.

**Losing data is the only unrecoverable failure.** Twenty years of customer
history is the asset. Downtime is an annoyance; a lost database is the business.

**The database holds the means of physical entry to several hundred homes.**
ADR 0003 covers this. It changes where the encryption key can live, and it
changes what a lost phone means.

**Technicians work where cell coverage is bad.** Rural Vermont and northern New
York. The field app cannot assume a network.

**Evosus is the fallback, until it isn't.** During migration, if the new system
is down, staff use Evosus and lose the good search. That safety net disappears
in Phase 4, and the architecture has to be ready before it does.

## The shape

```
                        staff browsers          technician phones
                              │                        │
                              ▼                        ▼
                    ┌──────────────────────────────────────┐
                    │  Vercel — Next.js app + route         │
                    │  handlers, US East                    │
                    └───────┬──────────────┬───────────────┘
                            │              │
              ┌─────────────┘              └──────────────┐
              ▼                                           ▼
   ┌────────────────────┐                    ┌──────────────────────┐
   │  Neon Postgres 17  │                    │  Cloudflare R2       │
   │  pg_trgm, unaccent │                    │  photos, documents   │
   │  PITR, branching   │                    │  signed URLs only    │
   └────────┬───────────┘                    └──────────────────────┘
            │
            │  ▲ writes over TLS
            │  │
   ┌────────┴──┴──────────┐        ┌──────────────────┐   ┌──────────────┐
   │  shop server (on-prem)│        │  Clerk           │   │  AWS KMS     │
   │  scheduled ETL task   │        │  staff + tech    │   │  wraps the   │
   │  reads Evosus, r/o    │        │  identity, MFA   │   │  field key   │
   └───────────┬───────────┘        └──────────────────┘   └──────────────┘
               │ read-only
               ▼
     ┌───────────────────┐
     │  Evosus SQL Server │   ← untouched, still the system of record
     │  (on-prem)         │      for money and inventory until Phase 4
     └───────────────────┘
```

Five managed services and one scheduled task on a machine that already exists.
That is the whole production footprint for Phase 1 and Phase 2.

## Where each piece goes, and why

**App — Vercel.** The app is Next.js 15 and nothing about it wants a container.
Vercel means no build pipeline to maintain, preview deployments per branch for
free, and no server to patch. The alternative worth naming is a single small VM
running `next start` behind Caddy, which is cheaper and gives you somewhere to
put cron jobs, at the cost of being a machine someone has to own. Given who
operates this, that trade goes the other way. See ADR 0007.

**Database — Neon.** Already assumed in `packages/db/src/index.ts`. Serverless
Postgres 17 with `pg_trgm` and `unaccent` available, point-in-time recovery, and
database branching that pairs exactly with Vercel preview deployments: every
pull request gets its own copy of the schema and a throwaway dataset. Pick the
US East region — roughly 20ms from Vermont, and it is where Vercel's default
region is, which keeps the query path short.

Autoscaling matters more than it looks here. This business is seasonal: pool
season is April through September, stove season September through December, and
the quiet weeks in between are genuinely quiet. Scale-to-zero on a dev branch
and a small always-on production compute is the right shape.

**Photos and documents — Cloudflare R2.** Object storage with no egress fees,
which matters because the same install photos get viewed repeatedly by staff and
technicians over their working life. Uploads go directly from the browser or
phone to R2 with a presigned URL, never through the app process — a technician
on a slow LTE connection uploading twelve photos should not be occupying a
serverless function for four minutes.

ADR 0003 point 5 is a hard requirement here, not a preference: keys are
unguessable, the bucket is private, and every read is a signed URL with a short
expiry. There is no public path to any photo, ever.

**Identity — Clerk.** The schema already anticipates this: `app_user` carries
`external_id` with a comment naming Clerk or WorkOS, and roles are already
modelled as `admin | manager | staff | tech`. Clerk is the better fit of the two
because the users are employees on shared counter machines and phones, not
enterprise SSO tenants. It gives MFA, session management, and device revocation
without any of it being written here.

**Superseded in practice, 2026-08-18.** That hole is closed, but not by Clerk:
Sprint 2 shipped email-plus-PIN with server-side sessions (ADR 0005) because the
write path could not wait for a provider to be bought and wired. A Clerk
integration was written and then deleted rather than left as a second, unused
auth system. Clerk remains the intended destination — `external_id` is still
there for it — but nothing is wired to it today, and the cost line below is a
future cost, not a current one.

**Field encryption key — AWS KMS.** ADR 0003 leaves key custody open and flags
the reason: stored with the database, the encryption buys nothing; lost with the
database, the gate codes are unrecoverable. See ADR 0008 for the resolution.

## Where the ETL runs

On the shop server, not in the cloud.

The extract needs read-only access to an on-prem SQL Server. Running it in the
cloud means exposing Evosus to the internet, or building a VPN, or standing up a
tunnel — three ways to spend a week on plumbing and add a permanent thing to
maintain. Running it on a Windows machine that already sits on the same LAN as
Evosus means a scheduled task, an outbound TLS connection to Neon, and nothing
inbound at all.

This also keeps `./data/` — which holds real customer records — on a local disk
inside the building, which is where the README already says it belongs.

The practical requirements: the task runs under an account whose SQL Server
credentials are read-only, it logs to a file the operator can read, and it
alerts on failure rather than failing silently. A migration pipeline that
stopped working three weeks ago and nobody noticed is worse than one that never
ran.

## Environments

Three, and only one of them costs anything.

**Local** is PGlite, as it is today. Nothing installed, no Docker, works on the
plane. This stays exactly as it is.

**Preview** is a Vercel deployment per pull request against a Neon branch. The
branch is created from production's schema and seeded with the synthetic legacy
data from `npm run etl -- demo`, never with real customer records. Preview
environments are shared by URL and will end up in a browser somewhere they
shouldn't; they must not contain a real gate code.

**Production** is one Vercel project and one Neon database.

Migrations run as a deploy step, before the new app version takes traffic, and
they run forward only. Because the timeline is append-only and corrections are
new rows, there is very little that a migration ever needs to rewrite — that
design decision pays off here.

## Backups and recovery

Neon's point-in-time recovery covers the common cases: a bad migration, a
mistaken bulk update, an ETL run that mapped a column wrong. Set the retention
window to 30 days, because the realistic discovery time for "the 2011 invoices
imported with the wrong dates" is weeks, not hours.

PITR inside one provider is not a backup. Once a week, a logical dump goes to R2
in a different account than the primary, and it is encrypted. The gate code key
is not in it and never will be — that is the entire point of ADR 0008.

Restore gets tested twice a year, in January and in October, both outside the
two busy seasons. An untested backup is a belief, not a backup. The test is:
restore last week's dump into a Neon branch, run the app against it, search for
a customer, open a timeline. Twenty minutes.

**Recovery targets.** While Evosus is still running, a total outage of the new
system costs staff the good search and the unified timeline, and they fall back
to Evosus — so a few hours is survivable. After Phase 4, when the register is
here and Evosus is gone, an outage is a closed store. That is the point at which
the numbers have to tighten to under an hour, and it is the reason the register
problem below is an architecture question and not a feature question.

## Observability

Three things, chosen so that the operator hears about a problem before a
customer does, and hears about nothing else.

Sentry for application errors, with the ETL reporting into it too. Uptime
monitoring that hits a real endpoint — one that touches the database, not a
static page — and texts on failure. Neon's own metrics for connection count and
storage growth.

Two alerts should exist on day one and then be left alone: the app is down, and
the nightly ETL did not run. Everything else can be a dashboard nobody looks at.

## Seasonality and the deploy calendar

This is unusual enough to write down, because it is the sort of thing that gets
forgotten and then hurts.

April through September is pool season. September through December is stove
season. Late June and July Saturdays are the busiest hours of the year. Nothing
risky ships on a Friday or Saturday between April and December, and the money
cutover in Phase 4 happens between January and March, exactly as ADR 0001 says.

The corollary is that January through March is when infrastructure work happens
— restore tests, dependency upgrades, the register cutover, anything that might
break. Plan the year around that window rather than fighting it.

## The register problem (Phase 4)

Worth stating now, while it is still cheap to design around.

The moment the register moves off Evosus, the store's internet connection
becomes a single point of failure for taking money. A cable outage on a Saturday
in June currently means Evosus keeps ringing sales; after cutover it would mean
the store cannot transact. That is a materially worse failure mode than anything
in Phases 1 through 3, and it is not solved by better uptime on the cloud side.

Three things address it, and all three should be in place before cutover:

1. A cellular failover router at the store. Roughly $30 a month and it removes
   the most likely cause outright.
2. Card processing through a terminal that has its own offline authorization
   (Stripe Terminal and Square both do this). The reader stores the transaction
   and settles when connectivity returns; the register does not have to be
   online to take a card.
3. An offline mode in the POS itself — queue sales locally, reconcile on
   reconnect. This is the same outbox pattern the field app needs, so build it
   once.

On card data: the terminal handles it and the application never sees a card
number. That keeps this a SAQ-A style scope rather than a real PCI audit, and it
is worth giving up integration flexibility to preserve.

## Cost

Rough monthly, at the size this business actually is:

| Piece | Monthly |
|---|---|
| Vercel Pro | $20 |
| Neon (Launch tier, one always-on branch) | $19-35 |
| Clerk | $0-25 |
| Cloudflare R2 (photos, growing) | $2-10 |
| AWS KMS (one key, low call volume) | ~$1 |
| Sentry | $26 |
| Uptime monitoring | $0-10 |
| **Total** | **~$70-130** |

Add roughly $30 a month for the failover router at Phase 4.

For comparison, Evosus licensing and support for a business this size runs
considerably more than that, which is worth remembering when a piece of this
looks expensive in isolation.

## What to do next

In order, because the order matters:

1. **Ship authentication.** It blocks the technician app, and until it lands the
   gate code audit log names nobody. This is the top of the list by a wide
   margin.
2. **Resolve key custody** per ADR 0008, including the offline copy of the
   key. Cheap to do now, unpleasant to discover later.
3. **Stand up Neon and Vercel** with a production deploy of what already exists.
   The web app works; putting it in front of staff on real data is what turns
   the search into feedback.
4. **Move the ETL to a scheduled task** on the shop server, with failure
   alerting.
5. **Wire R2 and presigned uploads** before photo capture ships, not alongside
   it. ADR 0003 point 5 becomes urgent the moment a technician takes a picture.

## Open questions

- **Does customer data have to stay in the United States, or in the building?**
  Everything above assumes US-hosted cloud is acceptable. If an insurer or a
  vendor contract says otherwise, the same architecture runs on a Postgres
  instance on the shop server, at the cost of owning backups yourself.
- **How many technicians, and on what phones?** It changes the field app
  decision in ADR 0006 more than anything else does.
- **Is QuickBooks staying?** The timeline schema lists it as an event source. If
  it stays, the Phase 4 boundary between it and the POS needs drawing.
- **Who is the second person with the keys?** Right now the operator is a single
  point of failure for the AWS account, the Neon account, and the offline copy
  of the field key. That is a real risk to the business, and it is solved with
  an envelope in a safe rather than with software.
