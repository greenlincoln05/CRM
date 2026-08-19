-- 0012 — Phase 3, unit 2: the selling-channel seam.
--
-- One table. It maps an item we own to its identity on a channel we do not.
--
-- ── Why a seam and not a Shopify integration ────────────────────────────────
--
-- There is no Shopify account, no API credential and no webhook endpoint for
-- this business today. A live sync written against an API nobody can call is
-- untested code that rots until somebody buys the account, and then it is
-- five-month-old untested code being debugged against a live storefront in
-- season. The seam and the domain model, on the other hand, test perfectly
-- against nothing: an in-memory fake exercises every rule below without a
-- network, and the rules are the part that is expensive to get wrong.
--
-- So this migration lands the mapping, the write layer lands the rules, and
-- the HTTP client is a later unit that implements an interface which by then
-- already has tests standing behind it.
--
-- ── The direction of authority. Do not invert it. ───────────────────────────
--
-- THIS system owns the item master. THIS system owns stock. A channel is a
-- SALES CHANNEL, never the master.
--
--   outward   a subset of the catalogue, and an availability number
--   inward    orders, as events against the unified customer record
--
-- Nothing pulled from a channel may edit item, create an item, or set a stock
-- level. If Shopify says the title is "Hayward Super Pump Shaft Seal (NEW!)"
-- and we say "SEAL, SHAFT, HAYWARD SP1600", we are right — the channel is
-- displaying a marketing string we pushed to it that somebody has since edited
-- in their admin. "Fixing" that by copying their title back over ours makes a
-- web store the system of record for the parts catalogue, and the counter, the
-- job and twenty years of service history then disagree with it.
--
-- Which is why this table holds a mapping and nothing else: our id, their id,
-- and the timestamps that say when we last spoke. Any product data stored here
-- would immediately become a second, competing item master.
--
-- ── No price. Not this phase. ───────────────────────────────────────────────
--
-- There is no price column here, for the same reason 0011 has no cost or price
-- on item. ADR 0001 puts money in the January–March window, outside pool
-- season (April–September) and stove season (September–December); it is
-- August. A price column on a storefront-facing table is the shortest path
-- there is to an inventory phase quietly becoming a money phase.
--
-- A real push to a live storefront does need a price eventually. That is a
-- later unit inside the money window, and it reads from a price list with an
-- effective date — not from a mutable scalar stapled to a listing row that
-- rewrites its own history every time somebody edits it.
--
--   channel  shopify | vendor_edi | other
--
-- Text with the known set in a comment rather than a Postgres enum, matching
-- customer.kind, contact.role, work_order.type, item.uom and every status
-- column in this schema: adding a channel must be a code change, never a
-- migration that locks the table.
CREATE TABLE "channel_listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"external_handle" text,
	"listed" boolean DEFAULT true NOT NULL,
	"last_pushed_at" timestamp with time zone,
	"last_pulled_at" timestamp with time zone,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The listing dies with the item. A mapping to a deleted part means nothing.
ALTER TABLE "channel_listing" ADD CONSTRAINT "channel_listing_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ── The two unique indexes are the whole point of the table ─────────────────
--
-- One external id maps to at most one item. Without this, two items can both
-- claim variant 55512345 and an inbound order line resolves to whichever row
-- the planner happened to hand back first — silently picking the wrong part
-- off the shelf, the exact failure item_sku_unique_idx exists to prevent.
CREATE UNIQUE INDEX "channel_listing_external_unique_idx" ON "channel_listing" USING btree ("channel","external_id");
--> statement-breakpoint

-- And one item has at most one listing per channel: the other direction of the
-- same rule. Two listings for one item is two availability numbers pushed for
-- one pile of stock, and the later push wins at random.
CREATE UNIQUE INDEX "channel_listing_item_unique_idx" ON "channel_listing" USING btree ("channel","item_id");
--> statement-breakpoint

-- "Which channels is this item on." The unique index above leads with channel,
-- so it cannot answer this one.
CREATE INDEX "channel_listing_item_idx" ON "channel_listing" USING btree ("item_id");
--> statement-breakpoint

-- Non-negotiable #2: an ETL upsert needs an inferable ON CONFLICT target.
-- Partial, because a listing created by the app has no legacy id.
CREATE UNIQUE INDEX "channel_listing_legacy_key_idx" ON "channel_listing" USING btree ("legacy_source","legacy_id") WHERE legacy_id IS NOT NULL;
--> statement-breakpoint

-- ── updated_at maintenance ──────────────────────────────────────────────────
-- Same as item/item_barcode/item_fitment in 0011.
CREATE TRIGGER channel_listing_touch_trg BEFORE UPDATE ON channel_listing
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
