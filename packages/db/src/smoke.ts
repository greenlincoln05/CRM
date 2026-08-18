/**
 * Behavioural smoke test. Asserts the things the business actually cares about:
 * fuzzy search finds misspelled names, the timeline cannot be rewritten, and
 * re-running an import does not duplicate customers.
 *
 *   npx tsx src/smoke.ts
 */
import { sql } from 'drizzle-orm';
import { createDb } from './index.js';

const { db, close } = await createDb();

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

// Clean slate for repeat runs.
await db.execute(sql`TRUNCATE customer, address, contact, property, app_user,
  import_batch, import_issue, legacy_row RESTART IDENTITY CASCADE`);
await db.execute(sql`ALTER TABLE timeline_event DISABLE TRIGGER timeline_event_append_only_trg`);
await db.execute(sql`TRUNCATE timeline_event CASCADE`);
await db.execute(sql`ALTER TABLE timeline_event ENABLE TRIGGER timeline_event_append_only_trg`);

// ── Seed a handful of customers shaped like real Vermont ones ─────────────
await db.execute(sql`
  INSERT INTO customer (account_number, kind, first_name, last_name, primary_phone, primary_email, legacy_source, legacy_id)
  VALUES
    ('14032','residential','Robert','Beauchamp','(802) 555-0142','bob.beauchamp@example.com','evosus','C-14032'),
    ('14033','residential','Katherine',E'O\\'Neill','802-555-9987','koneill@example.com','evosus','C-14033'),
    ('14034','residential','Marie',E'Leli\\u00E8vre','8025553311',NULL,'evosus','C-14034')
`);
await db.execute(sql`
  INSERT INTO customer (account_number, kind, company_name, first_name, last_name, primary_phone, legacy_source, legacy_id)
  VALUES ('20881','commercial','Basin Harbor Club','Dana','Whitcomb','802-555-7700','evosus','C-20881')
`);

// ── 1. display_name is derived, never blank ───────────────────────────────
const names = await db.execute(sql`SELECT account_number, display_name FROM customer ORDER BY account_number`);
const rows = (names as any).rows ?? names;
check('display_name derived for person', rows[0].display_name === 'Robert Beauchamp', `got "${rows[0].display_name}"`);
check('display_name shows company + contact',
  rows[3].display_name === 'Basin Harbor Club (Dana Whitcomb)', `got "${rows[3].display_name}"`);

// ── 2. Fuzzy search: the doc's #1 complaint ───────────────────────────────
async function search(q: string) {
  const r = await db.execute(sql`SELECT display_name, score FROM search_customers(${q}, 5)`);
  return ((r as any).rows ?? r) as Array<{ display_name: string; score: number }>;
}

const misspelled = await search('beuchamp');
check('misspelled surname finds customer',
  misspelled[0]?.display_name === 'Robert Beauchamp', `top hit "${misspelled[0]?.display_name}"`);

const noApostrophe = await search('oneill');
check('missing apostrophe finds customer',
  noApostrophe.some(r => r.display_name.includes('Neill')), `hits ${noApostrophe.length}`);

const accentless = await search('lelievre');
check('accent-insensitive match',
  accentless.some(r => r.display_name.includes('Leli')), `hits ${accentless.length}`);

const byAccount = await search('14032');
check('legacy Evosus account number still finds customer',
  byAccount[0]?.display_name === 'Robert Beauchamp', `top hit "${byAccount[0]?.display_name}"`);

const byPhoneDigits = await search('8025550142');
check('phone digits match regardless of formatting',
  byPhoneDigits[0]?.display_name === 'Robert Beauchamp', `top hit "${byPhoneDigits[0]?.display_name}"`);

// ── 3. Import idempotency ─────────────────────────────────────────────────
let dupeBlocked = false;
try {
  await db.execute(sql`
    INSERT INTO customer (account_number, first_name, last_name, legacy_source, legacy_id)
    VALUES ('14032','Robert','Beauchamp','evosus','C-14032')`);
} catch { dupeBlocked = true; }
check('re-importing the same Evosus row is rejected', dupeBlocked);

// ── 4. Timeline is append-only ────────────────────────────────────────────
const cust = ((await db.execute(sql`SELECT id FROM customer WHERE account_number='14032'`) as any).rows)[0];
await db.execute(sql`
  INSERT INTO timeline_event (customer_id, occurred_at, kind, source, title, body)
  VALUES (${cust.id}, now() - interval '3 years', 'service_call', 'evosus',
          'Heater no-heat call', 'Replaced pressure switch. Customer mentioned liner seam.')
`);

let editBlocked = false;
try {
  await db.execute(sql`UPDATE timeline_event SET body = 'nothing to see here'`);
} catch { editBlocked = true; }
check('timeline body cannot be rewritten', editBlocked);

let deleteBlocked = false;
try {
  await db.execute(sql`DELETE FROM timeline_event`);
} catch { deleteBlocked = true; }
check('timeline rows cannot be deleted', deleteBlocked);

let pinAllowed = true;
try {
  await db.execute(sql`UPDATE timeline_event SET pinned = true`);
} catch { pinAllowed = false; }
check('pinning is still allowed', pinAllowed);

// ── 5. One primary property per customer ──────────────────────────────────
await db.execute(sql`INSERT INTO address (line1, city, state, postal_code) VALUES ('42 Lakeview Rd','Colchester','VT','05446')`);
const addr = ((await db.execute(sql`SELECT id FROM address LIMIT 1`) as any).rows)[0];
await db.execute(sql`INSERT INTO property (customer_id, address_id, label, is_primary) VALUES (${cust.id}, ${addr.id}, 'Main house', true)`);
let secondPrimaryBlocked = false;
try {
  await db.execute(sql`INSERT INTO property (customer_id, address_id, label, is_primary) VALUES (${cust.id}, ${addr.id}, 'Camp', true)`);
} catch { secondPrimaryBlocked = true; }
check('a customer cannot have two primary properties', secondPrimaryBlocked);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await close();
process.exitCode = failures === 0 ? 0 : 1;
