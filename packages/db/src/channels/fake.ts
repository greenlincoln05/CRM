import type {
  ChannelItem, ChannelListingRef, ChannelOrder,
  SellingChannelName, SellingChannelPort,
} from './port.js';

/**
 * An in-memory selling channel.
 *
 * The only implementation of SellingChannelPort that exists this session, and
 * that is deliberate — see the header of port.ts. It is not a stub standing in
 * for the real thing until the real thing arrives; it is the thing that lets
 * the rules in write/channels.ts be tested at all, and it stays useful
 * afterwards as the fixture those tests run against.
 *
 * It behaves like a channel that is doing its job correctly: it keys on SKU,
 * so a second push of the same item updates rather than duplicating and hands
 * back the id it handed back the first time. Every call is counted and every
 * value retained, so a test can assert not only what came back but what the
 * channel was actually asked to do — including, importantly, that it was NOT
 * asked (the availability refusal below must happen before the port is ever
 * reached, or a real adapter would be making a network call on a request our
 * own rules say is invalid).
 *
 * No price anywhere, because the port has none. See port.ts.
 */
export class InMemoryChannel implements SellingChannelPort {
  readonly channel: SellingChannelName;

  /** Their catalogue, keyed by their id. */
  readonly listings = new Map<string, ChannelItem & { externalId: string; handle: string }>();

  /** Their stock display, keyed by their id. Absent until someone pushes one. */
  readonly availability = new Map<string, number>();

  /** Call counters, so a test can assert idempotency and non-invocation. */
  pushItemCalls = 0;
  pushAvailabilityCalls = 0;
  pullOrdersCalls = 0;

  /** Orders waiting on the channel, in the order they were placed. */
  private readonly orders: ChannelOrder[] = [];

  private nextId = 55510001;

  constructor(channel: SellingChannelName = 'shopify') {
    this.channel = channel;
  }

  /** Put an order on the channel for the next pull. Test fixture only. */
  seedOrder(order: ChannelOrder): this {
    this.orders.push(order);
    return this;
  }

  /** Their id for our SKU, or null if we have never pushed it. */
  externalIdForSku(sku: string): string | null {
    for (const listing of this.listings.values()) {
      if (listing.sku === sku) return listing.externalId;
    }
    return null;
  }

  async pushItem(item: ChannelItem): Promise<ChannelListingRef> {
    this.pushItemCalls++;

    // Keyed on SKU, exactly as a real storefront is. The second push of the
    // same part is an edit of one listing, not a second listing.
    const existing = this.externalIdForSku(item.sku);
    const externalId = existing ?? String(this.nextId++);
    const handle = slug(item.sku);

    this.listings.set(externalId, { ...item, externalId, handle });
    return { externalId, externalHandle: handle };
  }

  async pushAvailability(externalId: string, available: number): Promise<void> {
    this.pushAvailabilityCalls++;

    // A real channel refuses an id it does not know, so this one does too. Our
    // write layer must never get this far for an unlisted item — if it does,
    // this error is how the smoke suite finds out.
    if (!this.listings.has(externalId)) {
      throw new Error(`channel ${this.channel} has no listing ${externalId}`);
    }
    this.availability.set(externalId, available);
  }

  async pullOrders(since: Date | null): Promise<readonly ChannelOrder[]> {
    this.pullOrdersCalls++;
    if (!since) return [...this.orders];
    return this.orders.filter((o) => o.placedAt > since);
  }
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
