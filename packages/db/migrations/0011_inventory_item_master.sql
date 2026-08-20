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
-- `code` holds what was scanned, verbatim. UPC-A is EAN-13 with a leading
-- zero, so the US box and the Canadian box of the same product are the same
-- number written two ways — and uniqueness is therefore enforced on the
-- normalized form, by barcode_norm() and item_barcode_code_unique_idx below,
-- NOT on this raw column. A raw unique index would accept both spellings as
-- two rows against two different items, which is one scan returning two
-- products. Formatting a code on the way in is still write-layer work for a
-- later unit; nothing here depends on that having happened.
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A barcode meaning zero of something is a scan that does nothing; a
	-- negative one is a sale that ADDS stock. Both fail silently, because the
	-- movement layer in a later unit multiplies by this — the damage shows up
	-- as a count that drifts, not as an error. Cheap now, a table lock later.
	CONSTRAINT "item_barcode_pack_qty_positive" CHECK (pack_qty > 0)
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

-- ── Barcode normalization ───────────────────────────────────────────────────
--
-- GS1's own rule: UPC-A, EAN-8, EAN-13 and GTIN-14 are one numbering space,
-- the same value right-aligned in a wider field of leading zeros. '012345678905'
-- off a US box and '0012345678905' off the Canadian box are THE SAME PRODUCT.
--
-- Stripping the leading zeros of a numeric code is therefore exactly the GS1
-- equality test, not an approximation of it. What it is NOT safe on is a
-- CODE_128 code, which is arbitrary alphanumeric text where a leading '0' is a
-- character like any other — '0ABC' and 'ABC' are two different labels. Hence
-- the digits-only guard: normalization applies where the standard says the
-- codes are equal, and nowhere else.
--
-- What I checked before choosing this: within the digits-only branch, two
-- codes collapse together only when they differ solely in leading zeros, which
-- is precisely the GTIN identity. Codes of different LENGTH that are not
-- zero-padded variants (say '12345678905' and '912345678905') keep different
-- normal forms. The degenerate all-zeros code maps to '0' rather than to the
-- empty string, so two of those collide with each other — correct, since
-- neither is a real barcode and one is all the table should ever hold.
--
-- IMMUTABLE and STRICT so it can carry a unique index and so the planner can
-- use that index for lookups, which search_items() below relies on.
CREATE FUNCTION barcode_norm(code text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN $1 ~ '^[0-9]+$' THEN COALESCE(NULLIF(ltrim($1, '0'), ''), '0')
    ELSE $1
  END
$$;
--> statement-breakpoint

-- One physical barcode, one item — enforced on the NORMALIZED form.
--
-- A unique index on raw `code` does not hold for the exact case this table
-- exists for. With '0012345678905' already stored against the seal, inserting
-- '012345678905' against the hose is accepted by a raw index: two rows, two
-- items, one physical barcode. Scanning that box then returns both, each
-- scoring 1.0, tie-broken alphabetically — somebody handed the wrong part.
--
-- Enforcing it here rather than deferring to "the write layer will normalize"
-- matters because that write layer does not exist yet, and the ETL will import
-- legacy barcodes before it does.
CREATE UNIQUE INDEX "item_barcode_code_unique_idx"
  ON "item_barcode" (barcode_norm("code"));
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
-- ── immutable_unaccent() ────────────────────────────────────────────────────
--
-- The stored haystack has to be folded the SAME way the query is folded, or a
-- predicate over the stored column and a predicate over the derived one answer
-- different questions — and search_items() below narrows on the stored column
-- and then filters on the derived one. Case is easy: lower() is IMMUTABLE.
-- Accents are not, and that is worth explaining rather than working around.
--
-- One-argument `unaccent(text)` is declared STABLE, not IMMUTABLE, because it
-- resolves the `unaccent` dictionary through the current search_path — change
-- the path and the same input gives a different answer, which is precisely
-- what IMMUTABLE promises will not happen. Postgres therefore refuses it in a
-- generated column or an index.
--
-- The two-argument form takes the dictionary explicitly, so that ambiguity is
-- gone and this wrapper can honestly be labelled IMMUTABLE. The label is still
-- a promise the database cannot check: `ALTER TEXT SEARCH DICTIONARY unaccent`
-- would silently invalidate every stored value and every index built on it.
-- Nothing in this repository alters that dictionary, and nothing should. If
-- that ever changes, the item table must be reindexed and search_text
-- rebuilt — the rows will not fix themselves and will not complain.
--
-- Verified in PGlite before anything was built on it: the two-argument call
-- resolves, the wrapper creates, and a generated column over it accepts
-- 'Trévi' and stores 'trevi'.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
-- Both the function and the dictionary are schema-qualified, and the
-- dictionary is cast to regdictionary explicitly. Every part of that was
-- forced by a failure, so none of it should be tidied away:
--
--   * without the cast the literal is `unknown` and overload resolution picks
--     nothing — `function unaccent(unknown, text) does not exist`;
--   * with the cast but WITHOUT `public.` on the dictionary name, a bare
--     SELECT works and a generated column works, but CREATE INDEX over this
--     function fails with `text search dictionary "unaccent" does not exist`.
--     The index expression is planned with a restricted search_path, and an
--     unqualified regdictionary literal is resolved through search_path at
--     that moment. Measured both ways in PGlite before choosing.
--
-- Two other spellings also get past that (a plpgsql body, or a `SET
-- search_path` clause) and both are wrong here for the same reason: neither
-- can be INLINED. Inlining is not a nicety — item_fitment_trgm_idx is an
-- expression index over this function, and the planner can only match a query
-- to it once both sides have been flattened to the same expression. A wrapper
-- that cannot inline builds an index nothing will ever use, which is the exact
-- failure this whole migration was rewritten to fix.
--
-- `public` is where 0001's `CREATE EXTENSION unaccent` puts it. Installing the
-- extension into another schema on a future host would break these indexes at
-- build time — loudly, which is the right way for it to break.
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint

-- Generated column, same shape as address.search_text in 0001, and maintained
-- by Postgres rather than by a trigger because everything in it lives on the
-- row itself.
--
-- customer.search_text in 0001 stores `lower(unaccent(...))` — it can, because
-- a trigger body has no immutability requirement. This column now matches it,
-- via the wrapper above. A generated column is the stronger of the two: it
-- cannot be skipped by an UPDATE that forgets, and it needs no backfill, so
-- rows the ETL loads are folded whether or not anything remembered to fold
-- them.
ALTER TABLE item
  ADD COLUMN IF NOT EXISTS search_text text
  GENERATED ALWAYS AS (
    lower(immutable_unaccent(
      COALESCE(sku,'')          || ' ' ||
      COALESCE(description,'')  || ' ' ||
      COALESCE(manufacturer,'') || ' ' ||
      COALESCE(model,'')        || ' ' ||
      COALESCE(category,'')
    ))
  ) STORED;
--> statement-breakpoint

-- GIN + trigram on the STORED column, so LIKE '%...%' and the <% operator are
-- both index-visible. That only pays off if the query touches search_text
-- directly — a predicate over any derived expression (say
-- search_text || codes) cannot use this index and degrades to
-- a full scan. search_items() below is written around that constraint: it
-- narrows against these columns first and derives the merged haystack only for
-- the rows that survive.
CREATE INDEX item_search_trgm_idx ON item USING gin (search_text gin_trgm_ops);
--> statement-breakpoint

-- Barcodes get their own trigram index. A partial scan or a hand-typed code
-- with a transposed digit is a real counter event, and the code lives on the
-- child row, so it cannot ride along on item.search_text.
--
-- Over lower(code), not raw code. CODE_128 is arbitrary alphanumeric and
-- vendor part codes are usually shouted in capitals; the query is lowercased
-- before it gets here, so an index on the raw column would be consulted with a
-- pattern that can never match it. Accents are left alone deliberately — a
-- barcode is digits or ASCII by every symbology this table accepts, and
-- folding them would only widen what counts as the same physical label.
CREATE INDEX item_barcode_code_trgm_idx ON item_barcode USING gin (lower(code) gin_trgm_ops);
--> statement-breakpoint

-- Fitment text is searchable too, so "raypak 406" finds the parts that fit one
-- even when the item's own manufacturer is a third-party maker. Expression
-- index, and search_items() must spell the expression the SAME way for the
-- planner to match it — folding included. Folded like item.search_text, for
-- the same reason: the query arrives lowercased and unaccented, so an index
-- over the raw columns would be probed with a pattern that cannot match a
-- capitalised manufacturer. This is the join the fitment table exists for, so
-- getting it silently wrong would cost the whole feature.
CREATE INDEX item_fitment_trgm_idx ON item_fitment
  USING gin (lower(immutable_unaccent(
    COALESCE(manufacturer,'') || ' ' || COALESCE(model,''))) gin_trgm_ops);
--> statement-breakpoint

-- ── LIKE-safe query text ────────────────────────────────────────────────────
--
-- search_customers() strips '%' and '_' from the query. That is harmless for
-- names, which contain neither. It is wrong for a parts catalogue: SKUs
-- contain underscores. Deleting the '_' from 'SP_16_00' searches for
-- 'SP1600' — which does not find the item that was asked for, and DOES find a
-- different part, at 0.96, looking like a confident answer.
--
-- So nothing is deleted from the query. The wildcards are escaped instead, and
-- the escaped form is used only where the text is a LIKE pattern; equality and
-- word_similarity comparisons use the raw text. Backslash is the escape
-- character LIKE uses by default in Postgres, and it must be escaped first or
-- it would double-escape whatever follows.
CREATE FUNCTION like_escape(s text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_')
$$;
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
-- ── Narrow first, derive second ─────────────────────────────────────────────
--
-- The shape below is not stylistic. The first version of this function built
-- lower(immutable_unaccent(search_text || codes || fitment)) for every row in a `hay`
-- CTE and then filtered that, which meant every LIKE and every <% ran against
-- a derived expression no index can serve. All three trigram indexes above
-- were dead: measured at 20,004 items, search_items('hayward seal') took 887ms
-- and EXPLAIN showed a full scan with 20,003 rows removed by filter.
--
-- So `cand` collects candidate ids using ONLY predicates the indexes can
-- serve — bare i.search_text, bare item_barcode.code, and the item_fitment
-- expression spelled exactly as its index spells it — and the merged haystack
-- is built afterwards, for the handful of rows that survived.
--
-- Three UNION branches rather than one pass with OR EXISTS(...): an OR across
-- tables forces the planner to walk `item` and evaluate the subqueries per
-- row, which is the full scan again wearing a different shape. Separate
-- branches each get their own bitmap index scan.
--
-- The branches match ANY token; the strict every-token rule is applied
-- afterwards on the survivors. That is deliberate — a candidate set has to be
-- a superset of the answer, and "matches all tokens" implies "matches at
-- least one", so narrowing on ANY is both index-friendly and correct.
--
-- That superset argument is exact for the LIKE branches and only best-effort
-- for the fuzzy one, and the difference is worth stating rather than glossing.
-- No token can span the ' ' separators, so a substring of the merged haystack
-- is a substring of one of the regions that were concatenated to build it, and
-- checking the regions separately loses nothing. word_similarity does not
-- decompose that way: a token can clear the threshold against the whole
-- concatenation while clearing it against no single region, because trigrams
-- straddle the joins. Measured, on the query 'sp1_6_00' (pg_trgm splits on
-- '_', giving a three-word probe): 0.333 against search_text, 0.111 against
-- the closest of the item's fitment rows, 0.222 against the barcode — and
-- 0.353 against the merged haystack, which the final filter therefore keeps
-- and the narrowing does not offer. Roughly 0.06% of fuzzed queries. It is a
-- rare miss on the
-- weakest ranking tier, accepted knowingly in exchange for the scan, and it is
-- the reason this says "superset" rather than "identical".
--
-- ── Ranking ─────────────────────────────────────────────────────────────────
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
  WITH t AS (
    SELECT
      qtext,
      qdigits,
      like_escape(qtext) AS qlike,
      ARRAY(SELECT tok FROM unnest(string_to_array(qtext, ' ')) AS tok
             WHERE tok <> '') AS tokens,
      ARRAY(SELECT like_escape(tok) FROM unnest(string_to_array(qtext, ' ')) AS tok
             WHERE tok <> '') AS tokens_like,
      -- The token the candidate scan is driven from: the longest one, and
      -- reasoning for that is at `cand` below.
      --
      -- Kept as a one-element ARRAY rather than a scalar, which looks
      -- pointless and is not. `t` is referenced several times, so Postgres
      -- materializes it, and a column read off a materialized CTE is opaque to
      -- the planner: joining `item` against a scalar `t.lead_like` produced a
      -- nested loop with a full Index Scan on item_pkey and 20,003 rows
      -- removed by join filter — the very full scan this rewrite exists to
      -- kill. Driving the join from a LATERAL unnest() instead lets the
      -- planner parameterize the inner scan, which is what turns it into the
      -- Bitmap Index Scan on item_search_trgm_idx.
      ARRAY[(ARRAY(SELECT tok FROM unnest(string_to_array(qtext, ' ')) AS tok
              WHERE tok <> '' ORDER BY length(tok) DESC, tok))[1]] AS lead_toks,
      ARRAY[like_escape((ARRAY(SELECT tok FROM unnest(string_to_array(qtext, ' ')) AS tok
              WHERE tok <> '' ORDER BY length(tok) DESC, tok))[1])] AS lead_likes
    FROM (
      SELECT
        -- Nothing is stripped: '%' and '_' are escaped where they are used as
        -- a LIKE pattern (qlike / tokens_like) and left alone everywhere else,
        -- so an underscore SKU is findable rather than silently rewritten.
        lower(immutable_unaccent(btrim(q))) AS qtext,
        regexp_replace(q, '\D', '', 'g') AS qdigits
    ) raw
  ),
  -- ── Candidates. Index-visible predicates only. ────────────────────────────
  --
  -- Driven from ONE token, not all of them, and that is the whole trick.
  --
  -- Every token has to match for a row to qualify, so the set of rows matching
  -- any single token is already a superset of the answer — and scanning one
  -- token costs one bitmap scan instead of one per word. Which token matters
  -- enormously, because `<%` selectivity collapses on short words:
  -- word_similarity('seal', 'series') is 0.400, over the 0.35 threshold, so
  -- 'seal' fuzzy-matches every row whose description contains "series", and a
  -- parts catalogue is nothing but series. Measured on 20,004 items: the token
  -- 'seal' matches 20,002 rows, 'hayward' matches 1,668. Union-of-all-tokens
  -- therefore pays for the WORST token every time — it measured SLOWER than
  -- the full scan it replaced, 1242ms against 980ms.
  --
  -- The longest token is the most selective one available without asking the
  -- planner for statistics it does not have about a text column.
  --
  -- It is a heuristic, and ALMOST always a pure speed one — but not entirely,
  -- and the earlier version of this comment claimed otherwise. It said picking
  -- badly costs speed and never correctness, because every candidate is
  -- re-checked against the merged haystack below. That is wrong twice over: a
  -- re-check cannot rescue a row that never became a candidate, and it
  -- contradicts the qualification made ~90 lines above, that narrowing on any
  -- single token is a superset for the LIKE branches and only best-effort for
  -- the fuzzy one. Which token leads decides which side of that gap a row
  -- falls on, so the choice is observable in results.
  --
  -- Measured on the smoke fixture, DESC (what this does) against ASC:
  --
  --   '905-r hayward'     DESC -> SP1600Z2   ASC -> nothing    truth SP1600Z2
  --   'sp1_6_00 hayward'  DESC -> 1 row      ASC -> 2 rows     truth 2 rows
  --
  -- The first says the choice changes results. The second says THIS choice is
  -- the one that loses a row: '905-r' scores 0.5 against SP1600Z2's merged
  -- haystack and 0.0 against its search_text, so leading with it finds
  -- nothing, while leading with 'hayward' reaches the row through branch 1.
  --
  -- Kept anyway, knowingly. Over 3,339 randomly fuzzed queries the two
  -- orderings gave identical results every single time; both counterexamples
  -- had to be constructed by searching ~1,345 tokens for one that clears the
  -- threshold against a concatenation and against no single region, and both
  -- lost rows land on the weakest ranking tier (0.40 and 0.28). Against that,
  -- leading with the longest token is what makes 'hayward seal' 8x faster.
  -- Trading a pathological miss on the bottom tier for that is the right
  -- trade; pretending the miss does not exist is not.
  --
  -- Branch 1 is now the ONLY lead-token-only branch — barcodes and fitment
  -- below scan every token — so the exposure is confined to rows whose sole
  -- claim is their own text.
  --
  -- Barcodes and fitment stay per-token — EVERY token, not the lead one: a row
  -- can match through a barcode or a fitment entry rather than through its own
  -- text, and dropping those branches would lose it. Both tables are far
  -- smaller than `item`, so any-token is affordable there. The barcode branch
  -- said this in a comment while doing lead-token-only for one review cycle,
  -- which is part of why the missing `<%` below read as safe on inspection.
  --
  -- One honest limit on the win. Picking the longest token helps only when
  -- there is a choice to make. A single-word query has no better token
  -- available, and if that word is short and common the narrowing buys almost
  -- nothing: measured at 20,010 items, 'hayward seal' goes 2296ms -> 262ms,
  -- but bare 'seal' goes 2308ms -> 2221ms, because 'seal' <% search_text is
  -- true for 20,005 of 20,010 rows. 'seal' is a word the counter types. The
  -- fix for that is a smaller threshold or a different index, not a different
  -- token, and it is not attempted here.
  cand AS (
    -- item.search_text, bare, so item_search_trgm_idx can serve it.
    --
    -- "Bare" is load-bearing in both directions: wrap this column in anything
    -- and the index is dead, but the column also has to ALREADY be folded the
    -- way the query is folded, or the narrowing silently drops rows the final
    -- filter would have kept. It is — lower(immutable_unaccent(...)), which is
    -- exactly what qtext is.
    SELECT i.id AS iid
    FROM t
    CROSS JOIN LATERAL unnest(t.lead_toks, t.lead_likes) AS u(tok, tok_like)
    JOIN item i
      ON i.search_text LIKE '%' || u.tok_like || '%'
      OR u.tok <% i.search_text
    WHERE t.qtext <> ''

    UNION

    -- item_barcode.code: the exact normalized lookup (barcode_norm index), the
    -- partial typed code, and the FUZZY code (both on the code trigram index).
    --
    -- The `<%` is not decoration and leaving it out was a real bug. The final
    -- filter accepts a row when a token is merely word_similar to the merged
    -- haystack, and the barcodes are part of that haystack — so a row whose
    -- only claim is a fuzzy barcode match passes the filter and must therefore
    -- survive the narrowing. Without this line it did not. Measured: a scan of
    -- '0087654312098' against a stored '0087654321098' — one transposed
    -- digit — returned nothing, though word_similarity of the two is 0.571,
    -- comfortably over the 0.35 threshold, while the same query scores only
    -- 0.143 against that item's search_text — well under it. Fuzzing several
    -- thousand generated
    -- queries against an un-narrowed reference implementation found ~4%
    -- divergent and every single one was this. With the line, ~0.06%, and
    -- those are the merged-vs-region gap described above rather than this.
    --
    -- Counts are given as proportions on purpose: the corpus is synthetic and
    -- generated fresh each run, so raw numbers do not reproduce and a comment
    -- quoting them would rot into a false claim.
    --
    -- A transposed digit is the case line 350 says this index exists for.
    --
    -- COST, because it is not free and nothing else will point at this line.
    -- The `<%` makes a SCAN — the fastest and most common thing that happens
    -- at a counter — pay a fuzzy trigram scan over every stored barcode, and
    -- stored barcodes are near-identical digit strings by construction. How
    -- much that hurts depends entirely on how clustered the catalogue's GTINs
    -- are, measured at ~20,000 barcodes:
    --
    --   200 vendor prefixes x ~100 items   171 fuzzy matches    53ms ->  104ms
    --   all sharing a 9-digit prefix     20,000 fuzzy matches   129ms -> 2731ms
    --
    -- Real GS1 allocation sits between those, and a store buying deep from a
    -- few vendors drifts toward the bad end. So the symptom to watch for is
    -- "scanning got slow as the catalogue grew", and this is the line.
    --
    -- The obvious fix is wrong and was measured: gating the fuzzy predicate on
    -- the exact lookup having missed recovers the speed and reintroduces the
    -- superset violation, returning a different set on a clean scan than the
    -- un-narrowed reference does. Do not add that guard.
    SELECT b.item_id
    FROM t
    CROSS JOIN LATERAL unnest(t.tokens, t.tokens_like) AS u(tok, tok_like)
    JOIN item_barcode b
      ON (length(t.qdigits) >= 8 AND barcode_norm(b.code) = barcode_norm(t.qdigits))
      OR lower(b.code) LIKE '%' || u.tok_like || '%'
      OR u.tok <% lower(b.code)
    WHERE t.qtext <> ''

    UNION

    -- item_fitment, spelled exactly as item_fitment_trgm_idx spells it
    SELECT f.item_id
    FROM t
    CROSS JOIN LATERAL unnest(t.tokens, t.tokens_like) AS u(tok, tok_like)
    JOIN item_fitment f
      ON lower(immutable_unaccent(
           COALESCE(f.manufacturer,'') || ' ' || COALESCE(f.model,'')))
           LIKE '%' || u.tok_like || '%'
      OR u.tok <% lower(immutable_unaccent(
           COALESCE(f.manufacturer,'') || ' ' || COALESCE(f.model,'')))
    WHERE t.qtext <> ''
  ),
  -- ── Only now build the merged haystack, for survivors only. ───────────────
  --
  -- One spelling of the fold, everywhere: lower(immutable_unaccent(...)), the
  -- same as search_text, the same as the fitment index, the same as qtext.
  -- i.search_text arrives already folded and folding it again is a no-op; the
  -- barcode and fitment text joined onto it are raw, so the wrapper still has
  -- work to do here. Every rule about this function that has been got wrong so
  -- far has been got wrong by folding two things differently.
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
      lower(immutable_unaccent(
        i.search_text
        || ' ' || COALESCE(bc.codes, '')
        || ' ' || COALESCE(fit.txt, '')
      )) AS haystack
    FROM cand
    JOIN item i ON i.id = cand.iid
    LEFT JOIN LATERAL (
      SELECT string_agg(b.code, ' ') AS codes
      FROM item_barcode b WHERE b.item_id = i.id
    ) bc ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(COALESCE(f.manufacturer,'') || ' ' || COALESCE(f.model,''), ' ') AS txt
      FROM item_fitment f WHERE f.item_id = i.id
    ) fit ON true
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
      CASE WHEN lower(h.i_sku) LIKE t.qlike || '%'         THEN 0.96 ELSE 0 END,
      -- predictive typing against the whole haystack
      CASE WHEN h.haystack LIKE t.qlike || '%'             THEN 0.94 ELSE 0 END,
      CASE WHEN h.haystack LIKE '%' || t.qlike || '%'      THEN 0.88 ELSE 0 END,
      -- every token present, any order: "seal hayward" = "hayward seal"
      CASE WHEN cardinality(t.tokens) > 1
            AND (SELECT bool_and(h.haystack LIKE '%' || tl || '%')
                 FROM unnest(t.tokens_like) AS tl)         THEN 0.85 ELSE 0 END,
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
  -- never approximate, and matched through barcode_norm so a 12-digit UPC-A
  -- off a US box finds the 13-digit EAN stored off the Canadian one. length
  -- >= 8 (EAN-8 is the shortest real symbology) so the "1.5" in "1.5 hp motor"
  -- cannot be mistaken for a scan.
  LEFT JOIN LATERAL (
    SELECT b.code
    FROM item_barcode b
    WHERE b.item_id = h.iid
      AND length(t.qdigits) >= 8
      AND barcode_norm(b.code) = barcode_norm(t.qdigits)
    LIMIT 1
  ) mb ON true
  WHERE t.qtext <> ''
    AND (
         mb.code IS NOT NULL
      OR lower(h.i_sku) = t.qtext
      OR h.haystack LIKE '%' || t.qlike || '%'
      -- EVERY token must match somewhere. AND rather than OR: a second word
      -- should narrow the list, never widen it. Same rule as 0004/0005.
      OR (SELECT bool_and(h.haystack LIKE '%' || u.tl || '%' OR u.tk <% h.haystack)
          FROM unnest(t.tokens, t.tokens_like) AS u(tk, tl))
    )
  -- A scan breaks a tie against a typed match, and a stocked item breaks a tie
  -- against a discontinued one, before anything falls back to alphabetical.
  ORDER BY score DESC, (mb.code IS NOT NULL) DESC, h.i_active DESC, h.i_sku
  LIMIT lim;
$$;
