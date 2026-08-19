-- 0011 — Phase 3, unit 1: the item master.
--
-- The catalogue only: what a thing IS. Stock levels, receipts, movements and
-- parts-consumed-on-a-job are later units and are deliberately absent. A table
-- that knows what a Hayward shaft seal is earns its keep before anything
-- counts them — the counter can look one up, a job can name one.
--
-- ── Why there is no cost and no price column ────────────────────────────────
--
-- There is no cost, avg_cost, last_cost, list_price or retail_price here, and
-- that is a decision rather than an oversight.
--
-- The moment a cost column exists somebody sums qty * cost and calls it a
-- valuation report. Inventory has then quietly become the inventory asset
-- account, staff start trusting a number nobody reconciled, and an inventory
-- phase has turned into a money phase without anyone deciding to do that.
-- ADR 0001 is explicit: Evosus stays the system of record for money, and
-- anything touching money cuts over January–March, outside pool season
-- (April–September) and stove season (September–December). This is August.
--
-- When money does cut over, cost belongs on a receipt line (what we paid, on a
-- date, to a vendor) and price on a price list with an effective date — not as
-- two mutable scalars on the item that rewrite history every time a
-- distributor raises a price.
--
-- ── Three tables, not one ───────────────────────────────────────────────────
--
--   item          the thing
--   item_barcode  the codes that scan to it — many per item, with pack_qty
--   item_fitment  the equipment MODELS it fits — not one installed unit
--
-- Both children exist because the alternative is a column that can only hold
-- one value for a fact that genuinely has several. Reasoning is on each table.

-- ── item ────────────────────────────────────────────────────────────────────
--
-- uom carries more weight here than in normal retail. Backwash hose is sold by
-- the foot off a coil, salt by the bag, chemicals by weight, parts each.
-- Receive a 100ft coil, sell 27ft, 73 remain — that is not "each", and the
-- movement maths in a later unit is wrong in a way nobody notices until a
-- physical count if this is not right from the start.
--
-- Text with the known set in a comment rather than a Postgres enum, matching
-- how this repo already handles customer.kind, contact.role, work_order.type
-- and every status column: adding a value must be a code change, never a
-- migration that locks the table.
--
--   uom       each | foot | pound | ounce | gallon | bag | case | box | roll | pair | hour
--   category  chemical | part | equipment | accessory | media | hardware | fuel | consumable
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"description" text,
	"category" text,
	"uom" text DEFAULT 'each' NOT NULL,
	"manufacturer" text,
	"model" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── item_barcode ────────────────────────────────────────────────────────────
--
-- A CHILD table, never a column on item, because one item genuinely has many
-- barcodes. A case of chlorine tabs carries a different UPC than the single
-- bucket inside it, a relabelling distributor issues another, and the
-- Canadian-packaged version of the same product carries a different code
-- again. That last one is not theoretical here: Vermont and northern New York
-- get Canadian-packaged goods routinely.
--
-- Hence pack_qty on the row: scanning the case barcode means four buckets, not
-- one, and the movement layer multiplies by this rather than guessing from the
-- description. Numeric rather than integer because uom is not always
-- countable — a barcode can legitimately mean 2.5 pounds.
--
-- `code` is STORED NORMALIZED to 13 digits where the symbology allows it.
-- UPC-A is EAN-13 with a leading zero, so the US box and the Canadian box of
-- the same product are the same number; left-pad the zero and both scans land
-- on one row instead of creating a phantom second item that then holds its own
-- stock. The normalization itself belongs in the write layer of a later
-- unit — it depends on symbology and has to reject malformed input rather than
-- pad it silently — so this migration only shapes the column for it: plain
-- text (CODE_128 is not numeric at all) and unique across every item, so one
-- physical barcode can never point at two products. search_items() below
-- already matches a 12-digit scan against a stored 13-digit code, so the read
-- side works before the write side lands.
--
--   symbology  upc_a | ean_13 | code_128 | other
CREATE TABLE "item_barcode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"code" text NOT NULL,
	"symbology" text DEFAULT 'other' NOT NULL,
	"pack_qty" numeric(12, 3) DEFAULT '1' NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── item_fitment ────────────────────────────────────────────────────────────
--
-- Deliberately manufacturer + model TEXT and NOT a foreign key to
-- property_equipment. Fitment is a property of a MODEL of equipment, not of
-- one installed unit: a shaft seal fits every Hayward Super Pump in the
-- territory, not the specific pump at 12 Lakeshore Drive. Pointing at one
-- customer's equipment row would mean re-entering the same fitment fact once
-- per customer, and losing it when that equipment is replaced.
--
-- property_equipment already carries manufacturer/model/serial_number per
-- property, so joining these two on manufacturer/model answers both directions
-- of the question that actually gets asked:
--
--   "what fits the heater at 12 Lakeshore Drive"
--     property -> property_equipment -> item_fitment -> item
--
--   "which customers have the pump this recall covers"
--     item -> item_fitment -> property_equipment -> property -> customer
--
-- The join is on free text, which is loose. That is honest about the data:
-- twenty years of Evosus equipment records spell "Hayward" four ways. NULL
-- model means "every model this manufacturer makes" — a universal fit.
CREATE TABLE "item_fitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"manufacturer" text NOT NULL,
	"model" text,
	"notes" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Children die with the item. Neither a barcode nor a fitment row means
-- anything on its own.
ALTER TABLE "item_barcode" ADD CONSTRAINT "item_barcode_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_fitment" ADD CONSTRAINT "item_fitment_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- SKU is the human primary key: the number on the shelf label and the one said
-- out loud at the counter. Two items sharing one is somebody picking the wrong
-- part off the shelf. Not partial — every item has a SKU.
CREATE UNIQUE INDEX "item_sku_unique_idx" ON "item" USING btree ("sku");
--> statement-breakpoint

-- Non-negotiable #2: the ETL upserts on (legacy_source, legacy_id), and an
-- upsert needs an inferable ON CONFLICT target. Without this index a re-run of
-- an item import inserts the catalogue a second time — the exact defect 0010
-- had to go back and fix for work_order. Partial, because a manually created
-- item has no legacy id and NULLs must stay unconstrained.
CREATE UNIQUE INDEX "item_legacy_key_idx" ON "item" USING btree ("legacy_source","legacy_id") WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "item_category_idx" ON "item" USING btree ("category");
--> statement-breakpoint
CREATE INDEX "item_manufacturer_model_idx" ON "item" USING btree ("manufacturer","model");
--> statement-breakpoint

-- One physical barcode, one item. This is the whole point of the table.
CREATE UNIQUE INDEX "item_barcode_code_unique_idx" ON "item_barcode" USING btree ("code");
--> statement-breakpoint
CREATE INDEX "item_barcode_item_idx" ON "item_barcode" USING btree ("item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "item_barcode_legacy_key_idx" ON "item_barcode" USING btree ("legacy_source","legacy_id") WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "item_fitment_item_idx" ON "item_fitment" USING btree ("item_id");
--> statement-breakpoint

-- The recall direction: given a manufacturer and model, which items fit it.
CREATE INDEX "item_fitment_model_idx" ON "item_fitment" USING btree ("manufacturer","model");
--> statement-breakpoint
CREATE UNIQUE INDEX "item_fitment_legacy_key_idx" ON "item_fitment" USING btree ("legacy_source","legacy_id") WHERE legacy_id IS NOT NULL;
--> statement-breakpoint

-- The same fitment fact recorded twice, differing only in case or trailing
-- whitespace, is how "which customers have this pump" starts double-counting.
-- Expression index rather than a plain unique constraint because the data is
-- typed by hand: "Hayward " and "hayward" are the same manufacturer.
-- COALESCE so the universal-fit row (NULL model) is also constrained to one.
CREATE UNIQUE INDEX item_fitment_unique_idx
  ON item_fitment (item_id, lower(btrim(manufacturer)), lower(btrim(COALESCE(model, ''))));
--> statement-breakpoint

-- ── updated_at maintenance ──────────────────────────────────────────────────
-- Same as contact/property/address/property_equipment in 0001.
CREATE TRIGGER item_touch_trg BEFORE UPDATE ON item
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER item_barcode_touch_trg BEFORE UPDATE ON item_barcode
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER item_fitment_touch_trg BEFORE UPDATE ON item_fitment
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- ── Search haystack ─────────────────────────────────────────────────────────
--
-- Generated column, same shape as address.search_text in 0001: maintained by
-- Postgres rather than by a trigger, because everything in it lives on the row
-- itself. lower() only — unaccent() is not IMMUTABLE and cannot appear in a
-- generated column, so it is applied at query time in search_items().
ALTER TABLE item
  ADD COLUMN IF NOT EXISTS search_text text
  GENERATED ALWAYS AS (
    lower(
      COALESCE(sku,'')          || ' ' ||
      COALESCE(description,'')  || ' ' ||
      COALESCE(manufacturer,'') || ' ' ||
      COALESCE(model,'')        || ' ' ||
      COALESCE(category,'')
    )
  ) STORED;
--> statement-breakpoint

-- GIN + trigram, the same index that makes customer search fast enough to run
-- on every keystroke.
CREATE INDEX item_search_trgm_idx ON item USING gin (search_text gin_trgm_ops);
--> statement-breakpoint

-- Barcodes get their own trigram index. A partial scan or a hand-typed code
-- with a transposed digit is a real counter event, and the code lives on the
-- child row, so it cannot ride along on item.search_text.
CREATE INDEX item_barcode_code_trgm_idx ON item_barcode USING gin (code gin_trgm_ops);
--> statement-breakpoint

-- Fitment text is searchable too, so "raypak 406" finds the parts that fit one
-- even when the item's own manufacturer is a third-party maker.
CREATE INDEX item_fitment_trgm_idx ON item_fitment
  USING gin ((COALESCE(manufacturer,'') || ' ' || COALESCE(model,'')) gin_trgm_ops);
--> statement-breakpoint

-- ── search_items() ──────────────────────────────────────────────────────────
--
-- Sibling to search_customers(), and held to the same discipline (ADR 0002):
--
--  1. word_similarity() rather than similarity(). similarity() compares the
--     query against the ENTIRE haystack, so three letters of a part
--     description against a concatenated SKU + description + manufacturer +
--     model + barcodes always scores near zero.
--
--  2. The threshold is attached to THIS function with SET. Tuning item search
--     — which will need tuning, because a parts catalogue is full of short
--     alphanumeric tokens that behave nothing like surnames — cannot shift
--     customer search, which is the search the business is judged on.
--
--  3. Trigram indexes above, so it stays fast on every keystroke.
--
-- It has to serve one counter and two input methods. Someone TYPES ("hayward
-- seal", "sp1600", "hose") and someone SCANS (a full barcode arrives as a
-- burst of digits and an Enter). Both land here, so both are scored:
--
--   * a barcode hit is 1.0, above everything. A scan is unambiguous.
--   * an exact SKU is 1.0 for the same reason — staff type these from memory.
--   * then SKU prefix, whole-query prefix, substring, all-tokens-present, and
--     finally fuzzy, which is the misspelling case.
--
-- Inactive items stay in the results rather than being filtered out. Twenty
-- years of service history names parts we no longer stock, and "what did we
-- put in that heater in 2011" has to keep resolving; `active` comes back in
-- the row so the caller can grey it out, and ties break toward active items.
CREATE OR REPLACE FUNCTION search_items(q text, lim int DEFAULT 20)
RETURNS TABLE (
  item_id         uuid,
  sku             text,
  description     text,
  manufacturer    text,
  model           text,
  category        text,
  uom             text,
  active          boolean,
  matched_barcode text,
  score           real
)
LANGUAGE sql
STABLE
SET pg_trgm.word_similarity_threshold = 0.35
AS $$
  WITH nq AS (
    SELECT
      -- strip LIKE wildcards so a typed '%' cannot turn into a table scan
      replace(replace(lower(unaccent(btrim(q))), '%', ''), '_', '') AS qtext,
      regexp_replace(q, '\D', '', 'g')                              AS qdigits
  ),
  t AS (
    SELECT
      nq.qtext,
      nq.qdigits,
      ARRAY(SELECT tok FROM unnest(string_to_array(nq.qtext, ' ')) AS tok
             WHERE tok <> '')                                       AS tokens,
      -- UPC-A is EAN-13 with a leading zero. A US box scans 12 digits, the
      -- Canadian box of the same product scans 13. Pad the query so a scan off
      -- either box reaches the one stored row. The write layer will store the
      -- padded form; this makes the read side correct in the meantime, and
      -- correct anyway for legacy rows imported unpadded.
      CASE WHEN length(nq.qdigits) = 12 THEN '0' || nq.qdigits
           ELSE nq.qdigits END                                      AS qean
    FROM nq
  ),
  -- Every barcode an item has, in one pass, so a typed partial code is part of
  -- the fuzzy haystack rather than only an exact lookup.
  bc AS (
    SELECT b.item_id AS iid, string_agg(b.code, ' ') AS codes
    FROM item_barcode b
    GROUP BY b.item_id
  ),
  -- Fitment likewise: "raypak 406" should find the parts that fit one.
  fit AS (
    SELECT f.item_id AS iid,
           string_agg(COALESCE(f.manufacturer,'') || ' ' || COALESCE(f.model,''), ' ') AS txt
    FROM item_fitment f
    GROUP BY f.item_id
  ),
  hay AS (
    SELECT
      i.id            AS iid,
      i.sku           AS i_sku,
      i.description   AS i_description,
      i.manufacturer  AS i_manufacturer,
      i.model         AS i_model,
      i.category      AS i_category,
      i.uom           AS i_uom,
      i.active        AS i_active,
      lower(unaccent(
        i.search_text
        || ' ' || COALESCE(bc.codes, '')
        || ' ' || COALESCE(fit.txt, '')
      )) AS haystack
    FROM item i
    LEFT JOIN bc  ON bc.iid  = i.id
    LEFT JOIN fit ON fit.iid = i.id
  )
  SELECT
    h.iid,
    h.i_sku,
    h.i_description,
    h.i_manufacturer,
    h.i_model,
    h.i_category,
    h.i_uom,
    h.i_active,
    mb.code,
    GREATEST(
      -- a scan is unambiguous: top of the list, always
      CASE WHEN mb.code IS NOT NULL              THEN 1.0  ELSE 0 END,
      -- our own SKU, typed from memory
      CASE WHEN lower(h.i_sku) = t.qtext         THEN 1.0  ELSE 0 END,
      CASE WHEN lower(h.i_sku) LIKE t.qtext || '%'         THEN 0.96 ELSE 0 END,
      -- predictive typing against the whole haystack
      CASE WHEN h.haystack LIKE t.qtext || '%'             THEN 0.94 ELSE 0 END,
      CASE WHEN h.haystack LIKE '%' || t.qtext || '%'      THEN 0.88 ELSE 0 END,
      -- every token present, any order: "seal hayward" = "hayward seal"
      CASE WHEN cardinality(t.tokens) > 1
            AND (SELECT bool_and(h.haystack LIKE '%' || tok || '%')
                 FROM unnest(t.tokens) AS tok)             THEN 0.85 ELSE 0 END,
      -- Fuzzy: the misspelling case, and DELIBERATELY CAPPED AT 0.8.
      --
      -- word_similarity() returns exactly 1.0 for any token that appears whole
      -- in the haystack, so uncapped it hands "shaft seal" the same 1.0 as a
      -- scanned barcode. At a counter that means scanning a box and getting
      -- some other item first because it sorted earlier — the tiers above stop
      -- meaning anything. Scaling keeps every fuzzy hit strictly below the
      -- plain substring match at 0.88, which already covers the
      -- contained-word case exactly.
      0.8 * COALESCE((SELECT min(word_similarity(tok, h.haystack))
                      FROM unnest(t.tokens) AS tok), 0)
    )::real AS score
  FROM hay h
  CROSS JOIN t
  -- Exact barcode lookup, kept separate from the fuzzy haystack so a scan is
  -- never approximate. length >= 8 (EAN-8 is the shortest real symbology) so
  -- the "1.5" in "1.5 hp motor" cannot be mistaken for a scan.
  LEFT JOIN LATERAL (
    SELECT b.code
    FROM item_barcode b
    WHERE b.item_id = h.iid
      AND length(t.qdigits) >= 8
      AND (
           b.code = t.qdigits
        OR b.code = t.qean
        -- both sides stripped of leading zeros, for legacy rows imported
        -- before the write layer normalizes on the way in
        OR ltrim(b.code, '0') = ltrim(t.qdigits, '0')
      )
    LIMIT 1
  ) mb ON true
  WHERE t.qtext <> ''
    AND (
         mb.code IS NOT NULL
      OR lower(h.i_sku) = t.qtext
      OR h.haystack LIKE '%' || t.qtext || '%'
      -- EVERY token must match somewhere. AND rather than OR: a second word
      -- should narrow the list, never widen it. Same rule as 0004/0005.
      OR (SELECT bool_and(h.haystack LIKE '%' || tok || '%' OR tok <% h.haystack)
          FROM unnest(t.tokens) AS tok)
    )
  -- A scan breaks a tie against a typed match, and a stocked item breaks a tie
  -- against a discontinued one, before anything falls back to alphabetical.
  ORDER BY score DESC, (mb.code IS NOT NULL) DESC, h.i_active DESC, h.i_sku
  LIMIT lim;
$$;
