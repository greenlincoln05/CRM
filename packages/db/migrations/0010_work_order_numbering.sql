-- 0010 — Job numbers, and the idempotency target work orders never had.
--
-- Two separate problems, one migration, because both are about a work order
-- having a stable identity that survives being created twice.
--
-- ── 1. The number people say out loud ────────────────────────────────────────
--
-- "Job 4417" is how the office and the tech refer to the same visit on the
-- phone, and how a customer refers to it three months later. Counting in
-- application code (SELECT MAX(number) + 1) is the same race as the account
-- number in 0009: two people creating a job from two terminals both read the
-- same maximum and both write the same number.
--
-- A sequence is the only allocator that is correct under concurrency. It is
-- deliberately NOT wired up as a column DEFAULT here — legacy jobs arrive
-- already numbered by Evosus, and imported rows must keep the number the
-- customer has on their paperwork rather than being renumbered by us. The
-- write layer calls nextval() only when it is creating a job of its own.
--
-- Starting at 1001 so job numbers are four digits from the first one and sort
-- as text without a leading-zero convention nobody will remember.
CREATE SEQUENCE work_order_number_seq START 1001;
--> statement-breakpoint

-- Then move it past anything already numbered.
--
-- The seed fixture used to write W-1001..W-1004 literally. On a database that
-- ran it once there are no duplicates, so the unique index below builds fine
-- and this migration reports success — and then the first four jobs booked
-- from the office each collide on a number that already exists, failing in a
-- way that looks intermittent because the fifth one works.
--
-- GREATEST keeps a fresh database at 1001. The regex only matches our own
-- W-<digits> shape, so an Evosus number in some other format is ignored
-- rather than parsed into nonsense.
SELECT setval(
  'work_order_number_seq',
  GREATEST(
    1001,
    COALESCE((SELECT max(substring(number from '^W-([0-9]+)$')::bigint) FROM work_order), 1000)
  )
);
--> statement-breakpoint

-- One number, one job.
--
-- Today `number` is plain nullable text with nothing stopping a second job
-- claiming 4417. That is worse than the duplicate-account-number case, because
-- a job number is what someone reads off a truck sheet before doing physical
-- work at somebody's house.
--
-- Partial, because NULL is legitimate and common: every job created before
-- this sequence existed has no number, and NULLs must stay unconstrained.
--
-- If this migration fails, the database already holds duplicates. Find them:
--
--   SELECT number, count(*), array_agg(summary)
--     FROM work_order WHERE number IS NOT NULL
--    GROUP BY number HAVING count(*) > 1;
--
-- The likely source is `npm run etl -- seed:jobs`, which re-inserted its four
-- demo jobs on every run. Wipe .pgdata and re-seed rather than relaxing this.
CREATE UNIQUE INDEX "work_order_number_unique_idx"
  ON "work_order" USING btree ("number")
  WHERE number IS NOT NULL;
--> statement-breakpoint

-- ── 2. Migration integrity (non-negotiable #2) ──────────────────────────────
--
-- Everything upserts on (legacy_source, legacy_id) so that running a transform
-- twice produces the same database, not two copies of the business. contact,
-- property, address, timeline_event and property_equipment all got this index
-- in 0001; work_order was added in 0007 and never did.
--
-- The consequence is not theoretical: an upsert needs an inferable ON CONFLICT
-- target, and with no unique index on the pair there is nothing to infer, so
-- job imports fall back to a bare ON CONFLICT DO NOTHING that conflicts with
-- nothing and inserts a fresh row every single run. This index is the target.
CREATE UNIQUE INDEX "work_order_legacy_key_idx"
  ON "work_order" USING btree ("legacy_source","legacy_id")
  WHERE legacy_id IS NOT NULL;
