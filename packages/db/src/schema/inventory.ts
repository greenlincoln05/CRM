import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, boolean, numeric, timestamp,
  index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { provenance, timestamps } from './_shared.js';

/**
 * The item master — Phase 3, unit 1.
 *
 * This is the catalogue only: what a thing IS. Stock levels, movements,
 * receipts and parts-consumed-on-a-job are later units and deliberately absent.
 * A table that knows what a Hayward shaft seal is has value on its own — the
 * counter can look one up, a job can name one — long before anything counts
 * them.
 *
 * ── No cost. No price. Not this phase. ──────────────────────────────────────
 *
 * There is no `cost`, `avg_cost`, `last_cost`, `list_price` or `retail_price`
 * column here, and that is a decision rather than an oversight.
 *
 * The moment a cost column exists, somebody sums `qty * cost` and calls it a
 * valuation report. Inventory has then quietly become the general ledger's
 * inventory asset account, staff start trusting a number nobody reconciled,
 * and an inventory phase has turned into a money phase without anyone
 * deciding to do that. ADR 0001 is explicit: Evosus stays the system of record
 * for money, and anything touching money cuts over January–March, outside pool
 * season (April–September) and stove season (September–December). This is
 * August.
 *
 * When money does cut over, cost belongs on the receipt line (what we actually
 * paid, on a date, from a vendor) and price belongs on a price list with an
 * effective date — not as two mutable scalars on the item that silently
 * rewrite history every time a distributor raises a price.
 */
export const item = pgTable('item', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  /**
   * Our number, the one printed on the shelf label and said out loud at the
   * counter. Internal and stable: a manufacturer changing their part number
   * does not change ours. Unique because it is the human primary key — two
   * items sharing a SKU is somebody picking the wrong part off the shelf.
   */
  sku: text('sku').notNull(),

  description: text('description'),

  category: text('category'),
  // chemical | part | equipment | accessory | media | hardware | fuel | consumable

  /**
   * Unit of measure. This carries more weight here than in normal retail,
   * because a real chunk of the catalogue is not countable in pieces:
   * backwash hose is sold by the foot off a coil, salt by the bag, chemicals
   * by weight, parts each. Receive a 100ft coil, sell 27ft, 73 remain — that
   * is not "each", and a later unit's movement maths will be wrong in a way
   * nobody notices until a physical count if this is not right from the start.
   *
   * Text with the known set in a comment rather than a Postgres enum, matching
   * how this repo already handles customer.kind, contact.role, work_order.type
   * and every status column: adding a value must be a code change, never a
   * migration that locks the table.
   */
  uom: text('uom').notNull().default('each'),
  // each | foot | pound | ounce | gallon | bag | case | box | roll | pair | hour

  manufacturer: text('manufacturer'),
  model: text('model'),

  /**
   * Discontinued rather than deleted. Twenty years of service history names
   * parts we no longer stock, and "what did we put in that heater in 2011"
   * has to keep resolving. Inactive items stay searchable — see search_items().
   */
  active: boolean('active').notNull().default(true),

  notes: text('notes'),

  ...provenance,
  ...timestamps,
}, (t) => [
  // The human primary key. Not partial: every item has one.
  uniqueIndex('item_sku_unique_idx').on(t.sku),

  // Non-negotiable #2: the ETL upserts on (legacy_source, legacy_id), and an
  // upsert needs an inferable ON CONFLICT target. Partial because manually
  // created items have no legacy id. Same shape as work_order in 0010.
  uniqueIndex('item_legacy_key_idx')
    .on(t.legacySource, t.legacyId)
    .where(sql`legacy_id IS NOT NULL`),

  index('item_category_idx').on(t.category),
  index('item_manufacturer_model_idx').on(t.manufacturer, t.model),
]);

/**
 * Barcodes are a CHILD table, never a column on item.
 *
 * One item genuinely has many barcodes. A case of chlorine tabs carries a
 * different UPC than the single bucket inside it; the same bucket scans
 * differently depending on whether the distributor relabelled it; and the
 * Canadian-packaged version of a product carries a different code again, which
 * matters here rather than in theory — Vermont and northern New York get
 * Canadian-packaged goods routinely.
 *
 * That is why the row carries `pack_qty`: scanning the case barcode means four
 * buckets, not one, and the movement layer in a later unit multiplies by this
 * rather than guessing from the description.
 */
export const itemBarcode = pgTable('item_barcode', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  itemId: uuid('item_id').notNull().references(() => item.id, { onDelete: 'cascade' }),

  /**
   * The scanned code, as it arrived.
   *
   * A US box carries UPC-A (12 digits) and the Canadian box of the same
   * product carries EAN-13. They are the same number: UPC-A is EAN-13 with a
   * leading zero, which is GS1's own rule — every GTIN is the same value
   * right-aligned in a wider field.
   *
   * Uniqueness is therefore enforced on the NORMALIZED form, not on this raw
   * column: `item_barcode_code_unique_idx` in migration 0011 is a unique index
   * over `barcode_norm(code)`. A raw-column unique index does not hold for the
   * exact case this table exists for — with '0012345678905' already stored,
   * inserting '012345678905' against a different item would be accepted, and
   * one scan would then return two items. The normalized index refuses it.
   *
   * Formatting a code on the way IN still belongs in the write layer of a
   * later unit (it depends on symbology and must reject malformed input rather
   * than pad it silently). The database no longer depends on that happening:
   * search_items() matches through barcode_norm() as well, so a 12-digit scan
   * finds a 13-digit stored code and vice versa.
   */
  code: text('code').notNull(),

  symbology: text('symbology').notNull().default('other'),
  // upc_a | ean_13 | code_128 | other

  /**
   * How many of the item's `uom` this barcode represents. 1 for the bucket,
   * 4 for the case of four, 100 for a boxed 100ft coil. Numeric rather than
   * integer because uom is not always countable — a barcode can legitimately
   * mean 2.5 pounds.
   */
  packQty: numeric('pack_qty', { precision: 12, scale: 3 }).notNull().default('1'),

  ...provenance,
  ...timestamps,
}, (t) => [
  // One physical barcode, one item — but enforced on barcode_norm(code), so
  // the index lives in migration 0011 rather than here. Drizzle cannot express
  // an expression index, and a raw-column unique index would be a weaker rule
  // wearing the same name. See the comment on `code`.
  index('item_barcode_item_idx').on(t.itemId),
  uniqueIndex('item_barcode_legacy_key_idx')
    .on(t.legacySource, t.legacyId)
    .where(sql`legacy_id IS NOT NULL`),

  /**
   * A barcode that means zero of something is a scan that does nothing, and a
   * negative one is a sale that ADDS stock. Both are silent: the movement
   * layer in a later unit multiplies by this, so the wrong sign shows up as a
   * count that drifts, not as an error. One line now; a table lock later.
   */
  check('item_barcode_pack_qty_positive', sql`pack_qty > 0`),
]);

/**
 * Fitment: which equipment an item fits.
 *
 * Deliberately manufacturer + model TEXT and NOT a foreign key to
 * property_equipment. Fitment is a property of a MODEL of equipment, not of
 * one installed unit: a shaft seal fits every Hayward Super Pump in the
 * territory, not the specific pump at 12 Lakeshore Drive. Pointing at one
 * customer's row would mean re-entering the same fitment fact once per
 * customer, and losing it entirely when that equipment is replaced.
 *
 * property_equipment already carries manufacturer/model/serial_number per
 * property, so joining these two on manufacturer/model answers both directions
 * of the question that actually gets asked:
 *
 *   "what fits the heater at 12 Lakeshore Drive"
 *     property -> property_equipment -> item_fitment -> item
 *
 *   "which customers have the pump this recall covers"
 *     item -> item_fitment -> property_equipment -> property -> customer
 *
 * The join is on free text, which is loose. That is honest about the data:
 * twenty years of Evosus equipment records spell "Hayward" four ways.
 * `item_fitment_unique_idx` — in migration 0011, not in this file, because
 * Drizzle cannot express an expression index — normalizes case and surrounding
 * whitespace so the same fitment is not recorded twice. Matching across the
 * two tables is a query concern for the unit that builds those screens.
 */
export const itemFitment = pgTable('item_fitment', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  itemId: uuid('item_id').notNull().references(() => item.id, { onDelete: 'cascade' }),

  manufacturer: text('manufacturer').notNull(),
  /** NULL means "every model this manufacturer makes" — a universal fit. */
  model: text('model'),
  notes: text('notes'),

  ...provenance,
  ...timestamps,
}, (t) => [
  index('item_fitment_item_idx').on(t.itemId),
  // The recall direction: given a manufacturer and model, which items fit it.
  index('item_fitment_model_idx').on(t.manufacturer, t.model),
  uniqueIndex('item_fitment_legacy_key_idx')
    .on(t.legacySource, t.legacyId)
    .where(sql`legacy_id IS NOT NULL`),
]);

/**
 * A selling channel's identity for one of our items — Phase 3, unit 2.
 *
 * ── The direction of authority, which must not be inverted ──────────────────
 *
 * THIS system owns the item master. THIS system owns stock. A channel is a
 * SALES CHANNEL, never the master.
 *
 * That means the traffic across this table is asymmetric on purpose:
 *
 *   outward   a subset of the catalogue, and an availability number
 *   inward    orders, as events against the unified customer record
 *
 * Nothing pulled from a channel is allowed to edit `item`, create an `item`,
 * or set a stock level. If Shopify says the title is "Hayward Super Pump
 * Shaft Seal (NEW!)" and we say "SEAL, SHAFT, HAYWARD SP1600", we are right —
 * the channel is showing a marketing string we pushed to it and someone has
 * since edited in their admin. A future implementer who "fixes" that by
 * copying the channel's title back over ours has made a web store the system
 * of record for the parts catalogue, and the counter, the job and twenty years
 * of service history now disagree with it.
 *
 * This table is therefore a MAPPING and nothing more: our id on one side,
 * their id on the other, and the timestamps that say when we last spoke. It
 * holds no product data of its own, because any product data here would
 * immediately become a second, competing item master.
 *
 * ── No price. Not this phase. ───────────────────────────────────────────────
 *
 * There is no `price` column here for exactly the reason `item` has none: ADR
 * 0001 puts money in the January–March window, and a price column on a
 * Shopify-facing table is the shortest path there is to inventory quietly
 * becoming a money phase in August. A real push to a live storefront does need
 * a price eventually; that is a later unit inside the money window, and it
 * will read from a price list with an effective date rather than from a
 * mutable scalar stapled to a listing.
 */
export const channelListing = pgTable('channel_listing', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  itemId: uuid('item_id').notNull().references(() => item.id, { onDelete: 'cascade' }),

  /**
   * Which channel. Text with the known set in a comment rather than a Postgres
   * enum, matching customer.kind, contact.role, work_order.type, item.uom and
   * every status column in this schema: adding a channel must be a code
   * change, never a migration that locks the table.
   */
  channel: text('channel').notNull(),
  // shopify | vendor_edi | other

  /**
   * Their id for the thing. A Shopify variant id, an EDI partner's item
   * number. Opaque text: it is theirs, we never parse it, and the shape
   * differs per channel and changes when they re-platform.
   */
  externalId: text('external_id').notNull(),

  /** Their human-facing slug, when they have one. `/products/sp1600-shaft-seal`. */
  externalHandle: text('external_handle'),

  /**
   * Is this item currently offered on that channel?
   *
   * False rather than deleted, for the same reason item.active is: the mapping
   * is what lets an order that arrives next week still resolve to the right
   * part. Delisting stops us pushing; it does not forget who they are.
   */
  listed: boolean('listed').notNull().default(true),

  /** When we last sent this item outward, and last pulled anything about it in. */
  lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
  lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),

  ...provenance,
  ...timestamps,
}, (t) => [
  /**
   * One external id maps to at most one item. Without this, two items can both
   * claim variant 55512345 and an inbound order line resolves to whichever row
   * the planner happened to return — silently picking a part off the wrong
   * shelf, which is precisely the failure item.sku's unique index exists to
   * prevent.
   */
  uniqueIndex('channel_listing_external_unique_idx').on(t.channel, t.externalId),

  /**
   * And one item has at most one listing per channel. The other direction of
   * the same rule: two listings for one item means two availability numbers
   * pushed for one pile of stock, and the second one wins at random.
   */
  uniqueIndex('channel_listing_item_unique_idx').on(t.channel, t.itemId),

  // "Which channels is this item on" — the unique index above leads with
  // `channel`, so it cannot answer this one.
  index('channel_listing_item_idx').on(t.itemId),

  uniqueIndex('channel_listing_legacy_key_idx')
    .on(t.legacySource, t.legacyId)
    .where(sql`legacy_id IS NOT NULL`),
]);
