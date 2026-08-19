/**
 * The selling-channel port — Phase 3, unit 2.
 *
 * ── Why this is an interface and not a Shopify client ───────────────────────
 *
 * There is no Shopify account for this business, no API credential, and no
 * webhook endpoint. "Connect to Shopify" today would mean writing an HTTP
 * client against an API nobody here can call, which is untested code from the
 * first line. It then sits for five months until somebody buys the account,
 * and gets debugged for the first time against a live storefront, in season.
 *
 * A seam and a domain model, by contrast, test perfectly against nothing. The
 * in-memory fake next door exercises every rule in write/channels.ts without a
 * network, and the rules are the expensive part to get wrong. When credentials
 * do exist, the adapter that carries them implements this interface and
 * inherits the tests that already stand behind it.
 *
 * So: no fetch, no host name, no token, no API types in this package. Ever. An
 * adapter that speaks HTTP belongs in its own package — it will want retries,
 * rate-limit handling and secrets, none of which @lcp/db should learn about —
 * and it can implement this interface from outside, because this file is types
 * and one interface and nothing else.
 *
 * ── THE CONSTRAINT. A future implementer must not invert it. ────────────────
 *
 * THIS system owns the item master. THIS system owns stock. A channel is a
 * SALES CHANNEL, not the master.
 *
 *   outward   a subset of the catalogue, and an availability number
 *   inward    orders, as events against the unified customer record
 *
 * Read the method list with that in mind and it is deliberately lopsided:
 * there is no `pullItems`, no `pullInventory`, and no `pullPrice`, and their
 * absence is the design.
 *
 * The temptation, six months from now, will be a "two-way sync": the store
 * shows a title someone edited in the Shopify admin, or a quantity a Shopify
 * app decremented, and the obvious-looking fix is to copy it back. Do not. The
 * moment a channel can write to `item` or to a stock level, a web storefront
 * is the system of record for a parts catalogue that the counter, the
 * technician's job sheet and twenty years of service history all read from —
 * and the first sign of it is somebody being handed the wrong part because a
 * marketing string overwrote a SKU description.
 *
 * If a channel's data really is better than ours, the correction is a person
 * editing the item master, in this system, with their name on the change. Not
 * a sync job doing it at 3am with nobody's.
 *
 * ── No price and no money, anywhere in these types ──────────────────────────
 *
 * ChannelItem has no price. ChannelOrderLine has no unit price and
 * ChannelOrder has no total. ADR 0001 puts money in the January–March window,
 * outside pool season (April–September) and stove season (September–December).
 * It is August.
 *
 * A real push to a live storefront genuinely does need a price, and a pulled
 * order genuinely does have a total. Both are a later unit inside that money
 * window: the price will come from a price list with an effective date, and
 * the order total will land wherever POS revenue lands when POS exists (ADR
 * 0001 sequences it last, on purpose). Adding either field here now would make
 * this an inventory phase that silently became a money phase, which is the one
 * thing the phase boundary exists to prevent.
 */

/**
 * The channels this system knows how to speak to.
 *
 * A frozen list in code rather than a Postgres enum, matching item.uom,
 * work_order.type and every status column in the schema: adding one is a code
 * change, never a migration that locks a table.
 */
export const SELLING_CHANNELS = ['shopify', 'vendor_edi', 'other'] as const;
export type SellingChannelName = typeof SELLING_CHANNELS[number];

/**
 * What we are willing to tell a channel about an item.
 *
 * A subset of the catalogue row, chosen so that nothing here is a fact the
 * channel could contradict usefully. There is no stock level and no price.
 */
export type ChannelItem = {
  /** Our SKU. The one on the shelf label — it is what makes a channel order
   *  traceable back to a real part when their id changes under a re-platform. */
  sku: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  /** each | foot | pound | ... — a channel that sells hose by the foot needs it. */
  uom: string;
  /** GTINs. A storefront wants these; they are ours, from item_barcode. */
  barcodes: readonly string[];
};

/** Who the item is, over there. Opaque to us: we store it, we never parse it. */
export type ChannelListingRef = {
  externalId: string;
  externalHandle?: string | null;
};

/**
 * One line of an order that arrived from a channel.
 *
 * Identified by the channel's own id, not by our SKU: their id is what their
 * order actually carries, and resolving it through channel_listing is the
 * whole reason that table exists. A line whose externalId we do not recognise
 * is a problem to be recorded, never a line to be quietly dropped — see
 * pullChannelOrders in write/channels.ts.
 */
export type ChannelOrderLine = {
  externalId: string;
  quantity: number;
  /** What the channel called it. Kept for the issue report when it does not
   *  resolve, so a human reading the row can tell what was ordered. */
  description?: string | null;
};

export type ChannelOrder = {
  externalOrderId: string;
  placedAt: Date;
  /** For matching to the unified customer record. Best-effort; a channel is
   *  under no obligation to give us either, and often gives us neither. */
  customerEmail?: string | null;
  customerName?: string | null;
  lines: readonly ChannelOrderLine[];
};

/**
 * The port. Three methods, and it is meant to stay this small.
 *
 * Everything an adapter must be able to do, and nothing it is permitted to do
 * beyond that. Each method is one direction of the constraint above.
 */
export interface SellingChannelPort {
  /** Which channel this adapter is. Written to channel_listing.channel. */
  readonly channel: SellingChannelName;

  /**
   * Offer this item on the channel, and tell us their id for it.
   *
   * Must be idempotent: called twice with the same SKU it updates rather than
   * creating a second listing, and returns the same external id both times.
   * Real channels behave this way (Shopify keys on the variant SKU) and our
   * side depends on it — channel_listing has a unique index on
   * (channel, item_id) and another on (channel, external_id), so an adapter
   * that minted a fresh id per call would collide on the first re-push.
   */
  pushItem(item: ChannelItem): Promise<ChannelListingRef>;

  /**
   * Tell the channel how many we have.
   *
   * One number, outward only. There is no matching `pullAvailability`, and
   * that omission is the constraint at the top of this file: stock is counted
   * here, by receipts and movements and physical counts, and a storefront's
   * idea of it is a copy that goes stale the moment somebody buys one at the
   * counter.
   */
  pushAvailability(externalId: string, available: number): Promise<void>;

  /**
   * Fetch orders placed since a point in time; null means "everything".
   *
   * The only inbound direction there is. Orders are events that happened to
   * us, which is exactly what this system is for — the unified customer record
   * and one timeline. They do not carry authority over the catalogue, and an
   * order referencing an unknown item does not create one.
   */
  pullOrders(since: Date | null): Promise<readonly ChannelOrder[]>;
}
