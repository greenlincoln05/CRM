import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import type { ChannelItem, SellingChannelPort } from '../channels/port.js';
import { WriteError, clean } from './input.js';
import { type Db, MANUAL_SOURCE, assertUuid, isUniqueViolation, rows } from './shared.js';

/**
 * The selling-channel seam — Phase 3, unit 2.
 *
 * Three operations, one per direction the port allows: put an item on a
 * channel, tell that channel how many we have, and take orders back off it.
 * The port itself (../channels/port.ts) carries the reasoning for why it is an
 * interface rather than a Shopify client; this file is the half that touches
 * the database, and it is where the rules live.
 *
 * ── The constraint these functions exist to enforce ─────────────────────────
 *
 * THIS system owns the item master. THIS system owns stock. A channel is a
 * SALES CHANNEL, not the master. Read every function below and notice what
 * none of them does: nothing here writes to `item`, creates an `item`, or sets
 * a stock level from anything a channel said. An order for an external id we
 * do not recognise becomes a recorded problem, never a new part.
 *
 * A future implementer wiring up a real adapter must not invert that. The
 * pressure to will be real and will sound reasonable — "the Shopify title is
 * better", "their count is more current" — and giving in makes a web storefront
 * the system of record for the catalogue the counter and every technician
 * reads from.
 *
 * ── No price, no money ──────────────────────────────────────────────────────
 *
 * Nothing here reads, writes or accepts a price, a cost or an order total, and
 * the types in the port have nowhere to put one. ADR 0001 puts money in the
 * January–March window; it is August. A real storefront push needs a price and
 * a real order has a total — both are a later unit inside that window, reading
 * from a price list with an effective date rather than a scalar on a listing.
 */

/**
 * Who may publish the catalogue to a sales channel.
 *
 * An allow-list rather than `role !== 'tech'`, on the same reasoning as
 * DISPATCH_ROLES in workOrders.ts and REDACTION_ROLES in timeline.ts: a role
 * added to app_user next year — a 'contractor', a 'vendor', a read-only
 * 'viewer' — is refused until somebody decides otherwise, rather than being
 * handed the storefront by a predicate written before it existed.
 *
 * 'staff' is in here because the person who knows the catalogue is behind the
 * counter, and both auth.ts and user-cli.ts default a new account to 'staff'.
 * 'tech' is not: a phone in a truck putting parts on a web store, or changing
 * what the store says we have in stock, is not a thing anyone asked for.
 */
const CHANNEL_ROLES = new Set(['admin', 'manager', 'staff']);

export function canManageChannels(actor: { role: string }): boolean {
  return CHANNEL_ROLES.has(actor.role);
}

/**
 * Run first in every write below, ahead of any lookup, so that a refusal says
 * only "you may not do this" and never doubles as confirmation that a given
 * item id is real. Same placement as assertMayDispatch.
 */
function assertMayManageChannels(actor: Actor, field = 'itemId'): void {
  if (!canManageChannels(actor)) {
    throw new WriteError('You do not have permission to manage sales channels.', field);
  }
}

export type ListItemInput = { itemId: string };

export type PushAvailabilityInput = {
  itemId: string;
  /**
   * How many we have. Supplied by the caller because there is no stock ledger
   * yet — Phase 3 unit 1 shipped the catalogue only, and receipts, movements
   * and counts are later units. When that ledger lands, this argument goes
   * away and the number is read from it.
   *
   * What must never happen is the reverse: reading the number back off the
   * channel. See the port's constraint. A storefront's count is a copy that
   * goes stale the moment somebody buys one at the counter.
   */
  available: number;
};

export type PullOrdersInput = {
  /** Only orders placed after this. Omit for everything the channel has. */
  since?: Date | null;
};

type ListingRow = {
  id: string;
  item_id: string;
  external_id: string;
  listed: boolean;
};

/** What a channel is told about an item. Never more than this. */
async function readChannelItem(db: Db, itemId: string): Promise<ChannelItem & { active: boolean; sku: string }> {
  const found = rows<{
    sku: string; description: string | null; manufacturer: string | null;
    model: string | null; uom: string; active: boolean;
  }>(await db.execute(sql`
    SELECT sku, description, manufacturer, model, uom, active
      FROM item WHERE id = ${itemId}::uuid
  `))[0];
  if (!found) throw new WriteError('That item could not be found.', 'itemId');

  const barcodes = rows<{ code: string }>(await db.execute(sql`
    SELECT code FROM item_barcode WHERE item_id = ${itemId}::uuid ORDER BY code
  `)).map((b) => b.code);

  return { ...found, barcodes };
}

async function loadListing(
  db: Db, channel: string, itemId: string,
): Promise<ListingRow | null> {
  return rows<ListingRow>(await db.execute(sql`
    SELECT id, item_id, external_id, listed
      FROM channel_listing
     WHERE channel = ${channel} AND item_id = ${itemId}::uuid
  `))[0] ?? null;
}

/**
 * Offer an item on a channel, and record who it is over there.
 *
 * Idempotent by construction. Called twice for the same item it pushes again —
 * which is the point, since the push is how an edited description reaches the
 * storefront — and updates the one mapping row rather than creating a second.
 * The unique index on (channel, item_id) is the guarantee; this is the code
 * path that keeps it from ever being tested in anger.
 *
 * The claim check on the external id happens after the push rather than
 * before, because the id is what the push returns — we cannot know it sooner.
 * That ordering is honest about a real failure: a badly behaved adapter that
 * mints a fresh id per call, or hands back an id already mapped to a different
 * item, has already changed something on its own side by the time we find out.
 * What we control is our mapping, and the refusal keeps that correct — one
 * external id, one item, always — instead of letting an inbound order line
 * resolve to whichever of two rows the planner returned first.
 */
export async function listItemOnChannel(
  db: Db, actor: Actor, port: SellingChannelPort, input: ListItemInput,
): Promise<{ listingId: string; externalId: string; created: boolean }> {
  assertMayManageChannels(actor);

  const itemId = assertUuid(input.itemId, 'itemId');
  const item = await readChannelItem(db, itemId);

  // A discontinued part on a storefront is a customer buying something we
  // stopped stocking in 2019. Delisting is `listed = false`, which keeps the
  // mapping so that an order placed last week still resolves; this refuses to
  // put it back up.
  if (!item.active) {
    throw new WriteError(
      `${item.sku} is discontinued and cannot be offered on a sales channel.`,
      'itemId',
    );
  }

  const ref = await port.pushItem({
    sku: item.sku,
    description: item.description,
    manufacturer: item.manufacturer,
    model: item.model,
    uom: item.uom,
    barcodes: item.barcodes,
  });

  const externalId = clean(ref.externalId);
  if (!externalId) {
    // Not a user error — an adapter returning no id is a bug in the adapter,
    // but it must not land as a NOT NULL violation three lines later.
    throw new WriteError(
      `The ${port.channel} listing came back without an id, so nothing was recorded.`,
      'itemId',
    );
  }
  const externalHandle = clean(ref.externalHandle);

  const existing = await loadListing(db, port.channel, itemId);

  // Checked BEFORE the branch, not inside the insert path.
  //
  // A re-list can collide too: an adapter that starts handing back an external
  // id another item already holds hits the same unique index on the UPDATE.
  // That branch used to have neither this pre-flight nor the catch below, so
  // the promise one paragraph up — one external id, one item, always — held
  // only for new listings, and a re-list surfaced a raw driver error with the
  // failing statement in it instead of a sentence somebody could act on.
  //
  // Friendly message first; the index is still the guarantee, since two
  // terminals can both pass this SELECT before either commits.
  const claimedBy = rows<{ item_id: string }>(await db.execute(sql`
    SELECT item_id FROM channel_listing
     WHERE channel = ${port.channel} AND external_id = ${externalId}
  `))[0];
  if (claimedBy && claimedBy.item_id !== itemId) {
    throw alreadyClaimed(port.channel, externalId);
  }

  if (existing) {
    try {
      await db.execute(sql`
        UPDATE channel_listing
           SET external_id = ${externalId},
               external_handle = ${externalHandle},
               listed = true,
               last_pushed_at = now()
         WHERE id = ${existing.id}::uuid
      `);
    } catch (err) {
      if (isUniqueViolation(err, 'channel_listing_external_unique_idx')) {
        throw alreadyClaimed(port.channel, externalId);
      }
      throw err;
    }
    return { listingId: existing.id, externalId, created: false };
  }

  try {
    const created = rows<{ id: string }>(await db.execute(sql`
      INSERT INTO channel_listing (
        item_id, channel, external_id, external_handle, listed,
        last_pushed_at, legacy_source
      ) VALUES (
        ${itemId}::uuid, ${port.channel}, ${externalId}, ${externalHandle}, true,
        now(), ${MANUAL_SOURCE}
      )
      RETURNING id
    `))[0]!;
    return { listingId: created.id, externalId, created: true };
  } catch (err) {
    if (isUniqueViolation(err, 'channel_listing_external_unique_idx')) {
      throw alreadyClaimed(port.channel, externalId);
    }
    throw err;
  }
}

function alreadyClaimed(channel: string, externalId: string): WriteError {
  return new WriteError(
    `${channel} listing ${externalId} is already mapped to a different item.`,
    'itemId',
  );
}

/**
 * Push an availability number outward.
 *
 * Refuses an item that is not listed, rather than listing it as a side effect.
 * Putting a part on a public storefront is a decision somebody makes on
 * purpose; it is not something that should happen because a nightly job
 * recalculated a stock number. The refusal also has to come from here rather
 * than from the adapter: a real one would otherwise be making a network call —
 * with a credential, against a rate limit — on a request our own rules already
 * say is invalid.
 */
export async function pushAvailabilityToChannel(
  db: Db, actor: Actor, port: SellingChannelPort, input: PushAvailabilityInput,
): Promise<{ listingId: string; externalId: string; available: number }> {
  assertMayManageChannels(actor);

  const itemId = assertUuid(input.itemId, 'itemId');

  // Not an integer check: uom is not always countable. 73.5 feet of backwash
  // hose off a 100ft coil is a real availability, and item.uom exists because
  // of it. Negative is not — a channel showing "-3 in stock" is a bug on
  // display, and a stock ledger that can go negative is a later unit's problem
  // to refuse at source.
  const available = Number(input.available);
  if (!Number.isFinite(available) || available < 0) {
    throw new WriteError('Availability must be a number of units, and cannot be negative.', 'available');
  }

  const listing = await loadListing(db, port.channel, itemId);
  if (!listing) {
    throw new WriteError(
      `That item is not listed on ${port.channel}. List it before pushing availability.`,
      'itemId',
    );
  }
  if (!listing.listed) {
    throw new WriteError(
      `That item is delisted on ${port.channel}. Re-list it before pushing availability.`,
      'itemId',
    );
  }

  await port.pushAvailability(listing.external_id, available);

  await db.execute(sql`
    UPDATE channel_listing SET last_pushed_at = now() WHERE id = ${listing.id}::uuid
  `);

  return { listingId: listing.id, externalId: listing.external_id, available };
}

export type PulledOrderLine = {
  externalId: string;
  itemId: string;
  sku: string;
  quantity: number;
};

export type PulledOrder = {
  externalOrderId: string;
  placedAt: Date;
  customerEmail: string | null;
  customerName: string | null;
  lines: PulledOrderLine[];
};

export type PullResult = {
  batchId: string;
  orders: number;
  lines: number;
  resolved: number;
  problems: number;
  /** The orders whose every line resolved to an item we own. */
  pulled: PulledOrder[];
};

/**
 * Pull orders inward and resolve every line to an item we own.
 *
 * ── Bad data becomes a row ──────────────────────────────────────────────────
 *
 * A line naming an external id with no listing is the interesting case, and it
 * happens for ordinary reasons: somebody added a product in the Shopify admin
 * instead of here, a listing was deleted on their side, an id changed under a
 * re-platform. Non-negotiable #3 in CLAUDE.md decides what to do about it —
 * bad data becomes an `import_issue` row, never an exception and never a
 * silent null.
 *
 * Never an exception, because one unrecognised line must not abandon the other
 * forty orders in the same pull. Never a silent null, because a dropped order
 * line is a customer who paid for something nobody is picking, discovered when
 * they phone up asking where it is. It goes in the issue report, the report is
 * read, the mapping is fixed, and the pull is re-run — that loop is how the ETL
 * already works and there is no reason for this to work differently.
 *
 * And emphatically NOT: creating an item to make the line resolve. That is the
 * inversion the port's header warns about, arriving through the back door.
 *
 * ── Where this deliberately stops ───────────────────────────────────────────
 *
 * It resolves and returns; it does not yet append a timeline event. The event
 * belongs against the unified customer record, and getting from
 * `customerEmail` to a customer is real work with real failure modes — no
 * match, several matches, an order placed by a name we know at an email we do
 * not. Guessing wrong files a stranger's purchase on a customer's history,
 * which is worse than not filing it yet. That matching is the next unit, and
 * an unmatched order must become an import_issue there for the same reason a
 * bad line does here.
 */
export async function pullChannelOrders(
  db: Db, actor: Actor, port: SellingChannelPort, input: PullOrdersInput = {},
): Promise<PullResult> {
  assertMayManageChannels(actor, 'channel');

  const since = input.since ?? null;

  // One batch per pull, so a run can be identified, reported on and re-read,
  // exactly as an ETL run is. mode 'pull' joins extract|transform|load|full in
  // the schema comment — a code change, not a migration, same as every other
  // known-value column here.
  const batchId = rows<{ id: string }>(await db.execute(sql`
    INSERT INTO import_batch (source, mode, entity, status, notes)
    VALUES (${port.channel}, 'pull', 'channel_order', 'running',
            ${`orders since ${since ? since.toISOString() : 'the beginning'}`})
    RETURNING id
  `))[0]!.id;

  try {
    const orders = await port.pullOrders(since);

    let lines = 0;
    let resolved = 0;
    let problems = 0;
    const pulled: PulledOrder[] = [];
    const touched = new Set<string>();
    let watermark: Date | null = null;

    for (const order of orders) {
      if (!watermark || order.placedAt > watermark) watermark = order.placedAt;

      const good: PulledOrderLine[] = [];
      let orderIsClean = true;

      for (const line of order.lines) {
        lines++;
        const match = rows<{ listing_id: string; item_id: string; sku: string }>(
          await db.execute(sql`
            SELECT cl.id AS listing_id, i.id AS item_id, i.sku
              FROM channel_listing cl
              JOIN item i ON i.id = cl.item_id
             WHERE cl.channel = ${port.channel} AND cl.external_id = ${line.externalId}
          `))[0];

        if (!match) {
          orderIsClean = false;
          problems++;
          await recordIssue(db, batchId, line.externalId,
            `Order ${order.externalOrderId} names ${port.channel} listing ` +
            `"${line.externalId}"${line.description ? ` (${line.description})` : ''}, ` +
            'which is not mapped to any item.',
            {
              externalOrderId: order.externalOrderId,
              externalId: line.externalId,
              description: line.description ?? null,
              quantity: line.quantity,
            });
          continue;
        }

        resolved++;
        touched.add(match.listing_id);
        good.push({
          externalId: line.externalId,
          itemId: match.item_id,
          sku: match.sku,
          quantity: line.quantity,
        });
      }

      // A partly-resolved order is held back rather than handed on half
      // complete: the issue rows above name exactly which lines are missing,
      // and shipping three of four lines because the fourth did not map is the
      // silent-drop failure wearing a different hat.
      if (orderIsClean) {
        pulled.push({
          externalOrderId: order.externalOrderId,
          placedAt: order.placedAt,
          customerEmail: clean(order.customerEmail),
          customerName: clean(order.customerName),
          lines: good,
        });
      }
    }

    if (touched.size > 0) {
      await db.execute(sql`
        UPDATE channel_listing SET last_pulled_at = now()
         WHERE id IN (${sql.join([...touched].map((id) => sql`${id}::uuid`), sql`, `)})
      `);
    }

    await db.execute(sql`
      UPDATE import_batch
         SET status = 'succeeded', finished_at = now(),
             rows_read = ${lines}, rows_written = ${resolved}, rows_skipped = ${problems},
             issue_count = ${problems}, watermark = ${watermark ? watermark.toISOString() : null}
       WHERE id = ${batchId}::uuid
    `);

    return { batchId, orders: orders.length, lines, resolved, problems, pulled };
  } catch (err) {
    // The channel being unreachable is an outage, not bad data, and it leaves
    // a failed batch behind rather than a silent no-op. A pull that "found no
    // orders" because the token expired is how a week of web orders goes
    // unnoticed.
    //
    // Bounded, for the same reason recordIssue() rebuilds its payload from an
    // allow-list. `import_batch.error` is read in a triage report next to that
    // payload, and a real HTTP adapter throws with the response body on the
    // message - an API that answers a bad request by echoing the order it
    // could not process would put a customer's email in here, past a filter
    // that only ever inspected the other column. The name and a short message
    // say which channel failed and roughly why, which is what this field is
    // for; the full error still propagates to the caller and the log.
    await db.execute(sql`
      UPDATE import_batch SET status = 'failed', finished_at = now(),
             error = ${batchError(err)}
       WHERE id = ${batchId}::uuid
    `);
    throw err;
  }
}

/**
 * What is safe to store on a failed batch.
 *
 * 200 characters is enough for "fetch failed", "401 Unauthorized" or
 * "getaddrinfo ENOTFOUND" — which is the entire diagnostic value of this
 * field — and short enough that a response body pasted onto an error message
 * cannot arrive whole. The truncation is marked so nobody reads a clipped
 * message as the complete one.
 *
 * Deliberately NOT a redaction pass over the text. Guessing which substrings
 * are personal is the approach that works until the day it doesn't; a length
 * bound is a rule that holds regardless of what the channel decided to say.
 */
function batchError(err: unknown): string {
  const name = (err as any)?.name ?? 'Error';
  const message = String((err as any)?.message ?? err ?? '');
  const clipped = message.length > 200 ? `${message.slice(0, 200)}… (truncated)` : message;
  return clipped ? `${name}: ${clipped}` : name;
}

/**
 * `legacy_id` holds the channel's own id for the thing that could not be
 * resolved, matching how every other import_issue row keys back to its source:
 * it is the value a person pastes into the Shopify admin to see what it was.
 */
async function recordIssue(
  db: Db, batchId: string, legacyId: string,
  message: string, payload: unknown,
): Promise<void> {
  // Only the line, never the order. An import_issue payload is a triage
  // artefact - the report gets read and pasted around, which is why the ETL
  // strips gate codes from its own issue payloads. A pulled order carries
  // customerEmail and customerName, and the next unit is the one that matches
  // those to a customer, so the shape that must never reach here is the whole
  // order. What a person triaging an unmapped listing needs is the external id
  // and what the channel called it.
  const safe = payload && typeof payload === 'object'
    ? (({ externalId, description, quantity }: any) => ({ externalId, description, quantity }))(payload as any)
    : payload;

  await db.execute(sql`
    INSERT INTO import_issue (batch_id, entity, legacy_id, severity, code, message, payload)
    VALUES (${batchId}::uuid, 'channel_order', ${legacyId}, 'error',
            'UNKNOWN_CHANNEL_LISTING', ${message},
            ${JSON.stringify(safe)}::jsonb)
  `);
}
