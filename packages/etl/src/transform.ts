/**
 * Transform: staging.legacy_row -> the real domain model.
 *
 * Rules that make this safe to run over and over:
 *
 *   - Idempotent. Everything upserts on (legacy_source, legacy_id), so running
 *     it twice produces the same database, not two copies of the business.
 *   - Non-destructive. It never deletes and never touches Evosus.
 *   - Loud. Every value it could not make sense of becomes an import_issue
 *     row instead of an exception or a silent null.
 *
 * The practical consequence: you can run this against production data on a
 * Tuesday, read the issue report, fix the mapping, and run it again on
 * Wednesday. That loop is the whole migration strategy.
 */
import { sql as dsql } from 'drizzle-orm';
import { createDb } from '@lcp/db';
import { config } from './config.js';
import {
  cleanText, normalizePhone, normalizeEmail, normalizeZip, normalizeState,
  normalizeDate, splitName, looksLikeCompany, type Issue,
} from './normalize.js';
import {
  customerMapping, propertyMapping, historyMapping, historyKindMap, pick,
} from './mappings/evosus.js';

const SOURCE = config.legacy.source;

/**
 * Legacy dates carry a calendar day and no time. Storing them at UTC midnight
 * made every one of them render a day early in Eastern time - a 2018-10-14
 * delivery showed as Oct 13. Service history that is visibly off by a day is
 * exactly how staff stop trusting a new system.
 *
 * So date-only values are pinned to local noon, which no timezone offset or DST
 * transition can push onto a neighbouring day. Genuine timestamps (a text
 * message, a card swipe) keep their real instant and are unaffected.
 */
const BUSINESS_TZ = 'America/New_York';

type Ctx = { db: any; batchId: string; issues: number };

async function recordIssue(ctx: Ctx, entity: string, legacyId: string | null, issue: Issue, payload?: unknown) {
  ctx.issues++;
  await ctx.db.execute(dsql`
    INSERT INTO import_issue (batch_id, entity, legacy_id, severity, code, message, payload)
    VALUES (${ctx.batchId}, ${entity}, ${legacyId}, ${issue.severity}, ${issue.code}, ${issue.message},
            ${payload ? JSON.stringify(payload) : null}::jsonb)
  `);
}

async function openBatch(db: any, entity: string, notes: string) {
  const r = await db.execute(dsql`
    INSERT INTO import_batch (source, mode, entity, status, notes)
    VALUES (${SOURCE}, 'transform', ${entity}, 'running', ${notes})
    RETURNING id
  `);
  return ((r as any).rows ?? r)[0].id as string;
}

/** Read the newest landed rows for an entity - the latest extract wins. */
async function latestRows(db: any, entity: string, limit?: number) {
  const r = await db.execute(dsql`
    SELECT DISTINCT ON (legacy_id) legacy_id, payload
    FROM legacy_row
    WHERE source = ${SOURCE} AND entity = ${entity}
    ORDER BY legacy_id, extracted_at DESC
    ${limit ? dsql`LIMIT ${limit}` : dsql``}
  `);
  return ((r as any).rows ?? r) as Array<{ legacy_id: string; payload: Record<string, unknown> }>;
}

// ── Customers ──────────────────────────────────────────────────────────────

export async function transformCustomers(opts: { limit?: number } = {}) {
  const { db, close } = await createDb();
  const batchId = await openBatch(db, 'customer', 'legacy_row -> customer/contact/address');
  const ctx: Ctx = { db, batchId, issues: 0 };

  let read = 0, written = 0, skipped = 0;

  try {
    const rows = await latestRows(db, 'customer', opts.limit);
    read = rows.length;

    for (const { legacy_id, payload } of rows) {
      const m = customerMapping.fields;

      // -- names -------------------------------------------------------------
      let first = cleanText(pick(payload, m.firstName!));
      let last = cleanText(pick(payload, m.lastName!));
      let company = cleanText(pick(payload, m.companyName!));
      const full = cleanText(pick(payload, m.fullName!));

      if (!first && !last && full) {
        // A business name sitting in the person-name field is extremely common
        // in twenty-year-old retail data. Test the WHOLE string before splitting -
        // splitting "Basin Harbor Club LLC" first would leave "LLC" as a surname.
        if (!company && looksLikeCompany(full)) {
          company = full;
        } else {
          const s = splitName(full);
          first = s.value.first;
          last = s.value.last;
          for (const i of s.issues) await recordIssue(ctx, 'customer', legacy_id, i, { full });
        }
      }

      // Same problem, arriving via separate first/last columns.
      if (!company && !first && looksLikeCompany(last)) {
        company = last;
        last = null;
      }

      if (!first && !last && !company) {
        await recordIssue(ctx, 'customer', legacy_id,
          { code: 'CUSTOMER_NO_NAME', severity: 'warn', message: 'Customer has no usable name; imported under account number' },
          payload);
      }

      // -- contact details ---------------------------------------------------
      const phone = normalizePhone(pick(payload, m.primaryPhone!));
      for (const i of phone.issues) await recordIssue(ctx, 'customer', legacy_id, i);

      const mobile = normalizePhone(pick(payload, m.mobilePhone!));
      for (const i of mobile.issues) await recordIssue(ctx, 'customer', legacy_id, i);

      const email = normalizeEmail(pick(payload, m.primaryEmail!));
      for (const i of email.issues) await recordIssue(ctx, 'customer', legacy_id, i);

      // -- billing address ---------------------------------------------------
      const line1 = cleanText(pick(payload, m.line1!));
      const city = cleanText(pick(payload, m.city!));
      const st = normalizeState(pick(payload, m.state!));
      const zip = normalizeZip(pick(payload, m.postalCode!));
      for (const i of [...st.issues, ...zip.issues]) await recordIssue(ctx, 'customer', legacy_id, i);

      let addressId: string | null = null;
      if (line1 || city || zip.value) {
        const ar = await db.execute(dsql`
          INSERT INTO address (line1, line2, city, state, postal_code, raw_input,
                               legacy_source, legacy_id, import_batch_id)
          VALUES (${line1}, ${cleanText(pick(payload, m.line2!))}, ${city}, ${st.value}, ${zip.value},
                  ${[line1, city, st.value, zip.value].filter(Boolean).join(', ')},
                  ${SOURCE}, ${`ADDR-${legacy_id}`}, ${batchId})
          ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL
          DO UPDATE SET line1 = EXCLUDED.line1, city = EXCLUDED.city,
                        state = EXCLUDED.state, postal_code = EXCLUDED.postal_code
          RETURNING id
        `);
        addressId = ((ar as any).rows ?? ar)[0].id;
      } else {
        await recordIssue(ctx, 'customer', legacy_id,
          { code: 'CUSTOMER_NO_ADDRESS', severity: 'info', message: 'No billing address on file' });
      }

      // -- status / dates ----------------------------------------------------
      const since = normalizeDate(pick(payload, m.customerSince!));
      for (const i of since.issues) await recordIssue(ctx, 'customer', legacy_id, i);

      const rawStatus = String(pick(payload, m.status!) ?? '').toLowerCase();
      const status = ['0', 'false', 'n', 'no', 'inactive'].includes(rawStatus) ? 'inactive' : 'active';

      const rawExempt = String(pick(payload, m.taxExempt!) ?? '').toLowerCase();
      const taxExempt = ['1', 'true', 'y', 'yes'].includes(rawExempt);

      const accountNumber = cleanText(pick(payload, m.accountNumber!)) ?? legacy_id;

      // -- upsert ------------------------------------------------------------
      const cr = await db.execute(dsql`
        INSERT INTO customer (account_number, kind, company_name, first_name, last_name,
                              primary_phone, primary_email, billing_address_id, status,
                              customer_since, tax_exempt, tax_exempt_id,
                              legacy_source, legacy_id, import_batch_id)
        VALUES (${accountNumber}, ${company ? 'commercial' : 'residential'}, ${company},
                ${first}, ${last}, ${phone.value}, ${email.value}, ${addressId}, ${status},
                ${since.value}, ${taxExempt}, ${cleanText(pick(payload, m.taxExemptId!))},
                ${SOURCE}, ${legacy_id}, ${batchId})
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          account_number     = EXCLUDED.account_number,
          kind               = EXCLUDED.kind,
          company_name       = EXCLUDED.company_name,
          first_name         = EXCLUDED.first_name,
          last_name          = EXCLUDED.last_name,
          primary_phone      = EXCLUDED.primary_phone,
          primary_email      = EXCLUDED.primary_email,
          billing_address_id = EXCLUDED.billing_address_id,
          status             = EXCLUDED.status,
          customer_since     = EXCLUDED.customer_since,
          tax_exempt         = EXCLUDED.tax_exempt,
          import_batch_id    = EXCLUDED.import_batch_id
        RETURNING id
      `);
      const customerId = ((cr as any).rows ?? cr)[0].id as string;

      // -- primary contact ---------------------------------------------------
      if (first || last || phone.value || email.value) {
        await db.execute(dsql`
          INSERT INTO contact (customer_id, first_name, last_name, role, phone, mobile, email,
                               is_primary, legacy_source, legacy_id, import_batch_id)
          VALUES (${customerId}, ${first}, ${last}, 'owner', ${phone.value}, ${mobile.value},
                  ${email.value}, true, ${SOURCE}, ${`CONT-${legacy_id}`}, ${batchId})
          ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL
          DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
                        phone = EXCLUDED.phone, mobile = EXCLUDED.mobile, email = EXCLUDED.email
        `);
      }

      // -- carry legacy notes onto the timeline ------------------------------
      const notes = cleanText(pick(payload, m.notes!));
      if (notes) {
        await db.execute(dsql`
          INSERT INTO timeline_event (customer_id, occurred_at, kind, source, title, body,
                                      legacy_source, legacy_id, import_batch_id)
          VALUES (${customerId},
                  ${(since.value ?? '2006-01-01') + ' 12:00:00'}::timestamp AT TIME ZONE ${BUSINESS_TZ},
                  'note', ${SOURCE},
                  'Account note (migrated from Evosus)', ${notes},
                  ${SOURCE}, ${`CNOTE-${legacy_id}`}, ${batchId})
          ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
        `);
      }

      written++;
      if (written % 500 === 0) process.stdout.write(`\r[transform] customers: ${written.toLocaleString()}`);
    }

    await db.execute(dsql`
      UPDATE import_batch SET status='succeeded', finished_at=now(),
        rows_read=${read}, rows_written=${written}, rows_skipped=${skipped}, issue_count=${ctx.issues}
      WHERE id = ${batchId}`);

    console.log(`\n[transform] customers: ${written.toLocaleString()} written, ${ctx.issues} issues logged (batch ${batchId})`);
  } catch (err: any) {
    await db.execute(dsql`
      UPDATE import_batch SET status='failed', finished_at=now(), error=${String(err?.message ?? err)}
      WHERE id = ${batchId}`);
    throw err;
  } finally {
    await close();
  }

  return { batchId, read, written, issues: ctx.issues };
}

// ── Properties ─────────────────────────────────────────────────────────────

export async function transformProperties(opts: { limit?: number } = {}) {
  const { db, close } = await createDb();
  const batchId = await openBatch(db, 'property', 'legacy_row -> property');
  const ctx: Ctx = { db, batchId, issues: 0 };
  let read = 0, written = 0, skipped = 0;

  try {
    const rows = await latestRows(db, 'property', opts.limit);
    read = rows.length;
    const m = propertyMapping.fields;

    for (const { legacy_id, payload } of rows) {
      const custLegacyId = cleanText(pick(payload, m.customerLegacyId!));
      if (!custLegacyId) {
        skipped++;
        await recordIssue(ctx, 'property', legacy_id,
          { code: 'PROPERTY_NO_CUSTOMER', severity: 'error', message: 'Service site has no customer reference; cannot import' }, payload);
        continue;
      }

      const cr = await db.execute(dsql`
        SELECT id FROM customer WHERE legacy_source = ${SOURCE} AND legacy_id = ${custLegacyId}`);
      const customer = ((cr as any).rows ?? cr)[0];
      if (!customer) {
        skipped++;
        await recordIssue(ctx, 'property', legacy_id,
          { code: 'ORPHAN_PROPERTY', severity: 'error', message: `Site references customer ${custLegacyId}, which was not imported` }, payload);
        continue;
      }

      const st = normalizeState(pick(payload, m.state!));
      const zip = normalizeZip(pick(payload, m.postalCode!));
      for (const i of [...st.issues, ...zip.issues]) await recordIssue(ctx, 'property', legacy_id, i);

      const line1 = cleanText(pick(payload, m.line1!));
      let addressId: string | null = null;
      if (line1 || zip.value) {
        const ar = await db.execute(dsql`
          INSERT INTO address (line1, line2, city, state, postal_code, raw_input,
                               legacy_source, legacy_id, import_batch_id)
          VALUES (${line1}, ${cleanText(pick(payload, m.line2!))}, ${cleanText(pick(payload, m.city!))},
                  ${st.value}, ${zip.value},
                  ${[line1, cleanText(pick(payload, m.city!)), st.value, zip.value].filter(Boolean).join(', ')},
                  ${SOURCE}, ${`SADDR-${legacy_id}`}, ${batchId})
          ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL
          DO UPDATE SET line1 = EXCLUDED.line1, city = EXCLUDED.city,
                        state = EXCLUDED.state, postal_code = EXCLUDED.postal_code
          RETURNING id`);
        addressId = ((ar as any).rows ?? ar)[0].id;
      }

      const rawActive = String(pick(payload, m.active!) ?? '1').toLowerCase();
      const active = !['0', 'false', 'n', 'no', 'inactive'].includes(rawActive);

      await db.execute(dsql`
        INSERT INTO property (customer_id, address_id, label, property_type, active,
                              access_notes, gate_code, pet_notes,
                              legacy_source, legacy_id, import_batch_id)
        VALUES (${customer.id}, ${addressId}, ${cleanText(pick(payload, m.label!))},
                ${cleanText(pick(payload, m.propertyType!))}, ${active},
                ${cleanText(pick(payload, m.accessNotes!))}, ${cleanText(pick(payload, m.gateCode!))},
                ${cleanText(pick(payload, m.petNotes!))},
                ${SOURCE}, ${legacy_id}, ${batchId})
        ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL
        DO UPDATE SET address_id = EXCLUDED.address_id, label = EXCLUDED.label,
                      active = EXCLUDED.active, access_notes = EXCLUDED.access_notes,
                      gate_code = EXCLUDED.gate_code, pet_notes = EXCLUDED.pet_notes`);
      written++;
    }

    await db.execute(dsql`
      UPDATE import_batch SET status='succeeded', finished_at=now(),
        rows_read=${read}, rows_written=${written}, rows_skipped=${skipped}, issue_count=${ctx.issues}
      WHERE id = ${batchId}`);
    console.log(`[transform] properties: ${written} written, ${skipped} skipped, ${ctx.issues} issues (batch ${batchId})`);
  } catch (err: any) {
    await db.execute(dsql`UPDATE import_batch SET status='failed', finished_at=now(), error=${String(err?.message ?? err)} WHERE id = ${batchId}`);
    throw err;
  } finally {
    await close();
  }

  return { batchId, read, written, skipped, issues: ctx.issues };
}

// ── History -> timeline ────────────────────────────────────────────────────

export async function transformHistory(opts: { limit?: number } = {}) {
  const { db, close } = await createDb();
  const batchId = await openBatch(db, 'history', 'legacy_row -> timeline_event');
  const ctx: Ctx = { db, batchId, issues: 0 };
  let read = 0, written = 0, skipped = 0;

  try {
    const rows = await latestRows(db, 'history', opts.limit);
    read = rows.length;
    const m = historyMapping.fields;

    // One lookup instead of a query per row - history is the big table.
    const cr = await db.execute(dsql`
      SELECT legacy_id, id FROM customer WHERE legacy_source = ${SOURCE} AND legacy_id IS NOT NULL`);
    const byLegacy = new Map<string, string>(
      (((cr as any).rows ?? cr) as Array<{ legacy_id: string; id: string }>).map((r) => [r.legacy_id, r.id]),
    );

    const pr = await db.execute(dsql`
      SELECT legacy_id, id FROM property WHERE legacy_source = ${SOURCE} AND legacy_id IS NOT NULL`);
    const propByLegacy = new Map<string, string>(
      (((pr as any).rows ?? pr) as Array<{ legacy_id: string; id: string }>).map((r) => [r.legacy_id, r.id]),
    );

    for (const { legacy_id, payload } of rows) {
      const custLegacyId = cleanText(pick(payload, m.customerLegacyId!));
      const customerId = custLegacyId ? byLegacy.get(custLegacyId) : undefined;
      if (!customerId) {
        skipped++;
        await recordIssue(ctx, 'history', legacy_id,
          { code: 'ORPHAN_HISTORY', severity: 'warn', message: `Activity references customer ${custLegacyId ?? '(none)'}, which was not imported` });
        continue;
      }

      const occurred = normalizeDate(pick(payload, m.occurredAt!));
      for (const i of occurred.issues) await recordIssue(ctx, 'history', legacy_id, i);
      if (!occurred.value) {
        skipped++;
        await recordIssue(ctx, 'history', legacy_id,
          { code: 'HISTORY_NO_DATE', severity: 'warn', message: 'Activity has no usable date; cannot place on timeline' }, payload);
        continue;
      }

      const rawKind = String(pick(payload, m.kind!) ?? '').toLowerCase().replace(/[^a-z]/g, '');
      const kind = historyKindMap[rawKind] ?? 'note';
      if (rawKind && !historyKindMap[rawKind]) {
        await recordIssue(ctx, 'history', legacy_id,
          { code: 'UNMAPPED_KIND', severity: 'info', message: `Unmapped activity type "${rawKind}", filed as note. Add it to historyKindMap.` });
      }

      const propLegacyId = cleanText(pick(payload, m.propertyLegacyId!));
      const amount = pick(payload, m.amount!);

      await db.execute(dsql`
        INSERT INTO timeline_event (customer_id, property_id, occurred_at, kind, source,
                                    title, body, ref_type, ref_id, actor_label, payload,
                                    legacy_source, legacy_id, import_batch_id)
        VALUES (${customerId},
                ${propLegacyId ? propByLegacy.get(propLegacyId) ?? null : null},
                ${occurred.value + ' 12:00:00'}::timestamp AT TIME ZONE ${BUSINESS_TZ},
                ${kind}, ${SOURCE},
                ${cleanText(pick(payload, m.title!))}, ${cleanText(pick(payload, m.body!))},
                ${rawKind || null}, ${legacy_id}, ${cleanText(pick(payload, m.actorLabel!))},
                ${JSON.stringify(amount !== null ? { amount } : {})}::jsonb,
                ${SOURCE}, ${legacy_id}, ${batchId})
        ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING`);
      written++;
      if (written % 1000 === 0) process.stdout.write(`\r[transform] history: ${written.toLocaleString()}`);
    }

    await db.execute(dsql`
      UPDATE import_batch SET status='succeeded', finished_at=now(),
        rows_read=${read}, rows_written=${written}, rows_skipped=${skipped}, issue_count=${ctx.issues}
      WHERE id = ${batchId}`);
    console.log(`\n[transform] history: ${written.toLocaleString()} events, ${skipped} skipped, ${ctx.issues} issues (batch ${batchId})`);
  } catch (err: any) {
    await db.execute(dsql`UPDATE import_batch SET status='failed', finished_at=now(), error=${String(err?.message ?? err)} WHERE id = ${batchId}`);
    throw err;
  } finally {
    await close();
  }

  return { batchId, read, written, skipped, issues: ctx.issues };
}
