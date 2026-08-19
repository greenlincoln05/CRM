/**
 * End-to-end demo on synthetic legacy data.
 *
 * The point is to exercise the migration BEFORE anyone has credentials to the
 * on-prem server. Every row below is modelled on a real failure mode of
 * twenty-year-old retail data:
 *
 *   - names crammed into one field, sometimes two people, sometimes a business
 *   - 7-digit phone numbers from before area codes were always dialled
 *   - ZIP codes that lost their leading zero to a spreadsheet
 *   - 1900-01-01 as "blank"
 *   - two-digit years
 *   - activity rows pointing at customers that no longer exist
 *   - transaction types nobody documented
 *   - the same household entered three times over fifteen years
 *
 * If the pipeline handles this, it will handle the real extract, and the issue
 * report will tell you exactly where the real one differs.
 */
import { createHash } from 'node:crypto';
import { sql as dsql } from 'drizzle-orm';
import { createDb, decryptField, initFieldKey } from '@lcp/db';
import { config } from './config.js';
import { protectRow } from './sensitive.js';
import { transformCustomers, transformProperties, transformHistory } from './transform.js';
import { report } from './report.js';

const SOURCE = config.legacy.source;

const CUSTOMERS = [
  { CustomerID: '14032', CustomerNumber: '14032', CustomerName: 'Beauchamp, Robert & Linda', Phone: '(802) 555-0142', Email: 'bob.beauchamp@example.com', Address1: '42 Lakeview Rd', City: 'Colchester', State: 'VT', Zip: '5446', DateCreated: '3/14/06', Status: '1', Notes: 'Prefers Saturday service. Has an above-ground with a bad seam on the north side.' },
  { CustomerID: '14033', CustomerNumber: '14033', CustomerName: "O'Neill, Katherine", Phone: '555-9987', Email: 'koneill@example.com', Address1: '19 Shore Acres Dr', City: 'Burlington', State: 'Vermont', Zip: '05401', DateCreated: '2011-06-02', Status: '1', Notes: '' },
  { CustomerID: '14034', CustomerNumber: '14034', CustomerName: 'Lelièvre, Marie', Phone: '8025553311/8025554400', Email: 'marie@example.com; marie.l@work.example.com', Address1: '7 Rue Champlain', City: 'Plattsburgh', State: 'NY', Zip: '12901', DateCreated: '1900-01-01', Status: '1', Notes: 'Seasonal - closes camp in October.' },
  { CustomerID: '20881', CustomerNumber: '20881', CustomerName: 'Basin Harbor Club LLC', Phone: '802.555.7700', Email: 'facilities@example.com', Address1: '4800 Basin Harbor Rd', City: 'Vergennes', State: 'VT', Zip: '05491', DateCreated: '1/7/1998', Status: '1', TaxExempt: '1', TaxExemptID: 'VT-88213', Notes: 'Commercial pool. Weekly service April through October. Invoice to AP, not the property.' },
  { CustomerID: '20882', CustomerNumber: '20882', CustomerName: 'Beauchamp, Bob', Phone: '(802) 555-0142', Email: '', Address1: '42 Lakeview Road', City: 'Colchester', State: 'VT', Zip: '05446', DateCreated: '6/2/2014', Status: '1', Notes: 'Duplicate? Same phone as 14032.' },
  { CustomerID: '20883', CustomerNumber: '20883', CustomerName: '', Phone: 'call after 5', Email: 'nope', Address1: '', City: '', State: 'XX', Zip: '999', DateCreated: 'sometime in the 90s', Status: '0', Notes: 'Old account, no info.' },
  { CustomerID: '20884', CustomerNumber: '20884', CustomerName: 'Whitcomb, Dana', Phone: '802-555-2210', Email: 'dana.whitcomb@example.com', Address1: '221 Malletts Bay Ave', City: 'Colchester', State: 'VT', Zip: '05446', DateCreated: '2019-04-11', Status: '1', Notes: 'Stove customer. Pellet, not wood.' },
];

const SITES = [
  { SiteID: 'S-001', CustomerID: '14032', SiteName: 'Main house', Address1: '42 Lakeview Rd', City: 'Colchester', State: 'VT', Zip: '05446', AccessNotes: 'Gate on the left side of the garage. Dog is friendly but loud.', GateCode: '4417', PetNotes: 'Golden retriever, Moose', SiteType: 'pool', Active: '1' },
  { SiteID: 'S-002', CustomerID: '14032', SiteName: 'Camp', Address1: '1180 West Lakeshore Dr', City: 'Colchester', State: 'VT', Zip: '5446', AccessNotes: 'Steep driveway, do not bring the big truck in mud season.', SiteType: 'spa', Active: '1' },
  { SiteID: 'S-003', CustomerID: '20881', SiteName: 'Main pool', Address1: '4800 Basin Harbor Rd', City: 'Vergennes', State: 'VT', Zip: '05491', AccessNotes: 'Check in at the front desk before going to the pump house.', SiteType: 'pool', Active: '1' },
  { SiteID: 'S-004', CustomerID: '99999', SiteName: 'Orphaned site', Address1: '1 Nowhere Rd', City: 'Essex', State: 'VT', Zip: '05452', Active: '1' },
  { SiteID: 'S-005', CustomerID: '20884', SiteName: 'Residence', Address1: '221 Malletts Bay Ave', City: 'Colchester', State: 'VT', Zip: '05446', AccessNotes: 'Stove is in the finished basement. Use the bulkhead.', SiteType: 'stove', Active: '1' },
];

const HISTORY = [
  { ID: 'H-1001', CustomerID: '14032', SiteID: 'S-001', TransactionDate: '5/12/2007', Type: 'Invoice', Description: 'Opening service', Notes: 'Standard spring opening. Replaced 2 skimmer baskets.', Total: '385.00', CreatedBy: 'DGREEN' },
  { ID: 'H-1002', CustomerID: '14032', SiteID: 'S-001', TransactionDate: '2012-08-03', Type: 'ServiceOrder', Description: 'Heater no-heat call', Notes: 'Pressure switch failed. Replaced under warranty. Customer mentioned liner seam again.', Total: '0.00', CreatedBy: 'MTECH' },
  { ID: 'H-1003', CustomerID: '14032', SiteID: 'S-002', TransactionDate: '2018-10-14', Type: 'Delivery', Description: 'Spa cover', Notes: 'Delivered and installed. Old cover hauled away.', Total: '512.75', CreatedBy: 'DGREEN' },
  { ID: 'H-1004', CustomerID: '20881', SiteID: 'S-003', TransactionDate: '6/1/16', Type: 'ServiceCall', Description: 'Weekly commercial service', Notes: 'Chlorine feeder adjusted. TA low, added 8 lbs.', Total: '145.00', CreatedBy: 'JTECH' },
  { ID: 'H-1005', CustomerID: '20881', TransactionDate: '2021-03-19', Type: 'Quote', Description: 'Pump replacement quote', Notes: 'Quoted VS pump plus install. Waiting on board approval.', Total: '4280.00', CreatedBy: 'DGREEN' },
  { ID: 'H-1006', CustomerID: '14033', TransactionDate: '2015-07-22', Type: 'WaterTest', Description: 'Water test', Notes: 'FC 0.4, pH 7.8, TA 60. Sold shock and alkalinity increaser.', Total: '38.50', CreatedBy: 'COUNTER' },
  { ID: 'H-1007', CustomerID: '14033', TransactionDate: '2016-05-30', Type: 'Layaway', Description: 'Layaway payment', Notes: 'Third payment on the spa steps.', Total: '150.00', CreatedBy: 'COUNTER' },
  { ID: 'H-1008', CustomerID: '88888', TransactionDate: '2009-04-04', Type: 'Invoice', Description: 'Orphan activity', Notes: 'Customer record was purged at some point.', Total: '75.00', CreatedBy: 'UNKNOWN' },
  { ID: 'H-1009', CustomerID: '20884', SiteID: 'S-005', TransactionDate: '2019-11-02', Type: 'Install', Description: 'Pellet stove install', Notes: 'Installed Harman P43. Ran new venting through the rim joist. Customer trained on operation.', Total: '4995.00', CreatedBy: 'MTECH' },
  { ID: 'H-1010', CustomerID: '20884', SiteID: 'S-005', TransactionDate: '', Type: 'ServiceOrder', Description: 'Annual cleaning', Notes: 'No date on this record.', Total: '189.00', CreatedBy: 'MTECH' },
  { ID: 'H-1011', CustomerID: '14034', TransactionDate: '2020-09-15', Type: 'Invoice', Description: 'Closing service', Notes: 'Camp closed for the season. Winter cover on.', Total: '425.00', CreatedBy: 'JTECH' },
];

async function land(db: any, batchId: string, entity: string, rows: Record<string, unknown>[], key: string) {
  const values = rows.map((r) => {
    const payload = JSON.stringify(protectRow(r));
    return dsql`(${batchId}::uuid, ${SOURCE}, ${entity}, ${String(r[key])}, ${payload}::jsonb,
                 ${createHash('md5').update(payload).digest('hex')})`;
  });
  await db.execute(dsql`
    INSERT INTO legacy_row (batch_id, source, entity, legacy_id, payload, row_hash)
    VALUES ${dsql.join(values, dsql`, `)}
    ON CONFLICT (batch_id, source, entity, legacy_id) DO NOTHING`);
}

export async function runDemo() {
  await initFieldKey(); // landing encrypts gate codes, so the key comes first
  const { db, close } = await createDb();

  console.log('[demo] clearing previous demo data');
  await db.execute(dsql`ALTER TABLE timeline_event DISABLE TRIGGER timeline_event_append_only_trg`);
  await db.execute(dsql`TRUNCATE timeline_event, contact, property, property_equipment,
    customer, address, legacy_row, import_issue, import_batch RESTART IDENTITY CASCADE`);
  await db.execute(dsql`ALTER TABLE timeline_event ENABLE TRIGGER timeline_event_append_only_trg`);

  const br = await db.execute(dsql`
    INSERT INTO import_batch (source, mode, entity, status, notes)
    VALUES (${SOURCE}, 'extract', NULL, 'succeeded', 'synthetic demo fixture') RETURNING id`);
  const batchId = ((br as any).rows ?? br)[0].id as string;

  console.log('[demo] landing synthetic legacy rows');
  await land(db, batchId, 'customer', CUSTOMERS, 'CustomerID');
  await land(db, batchId, 'property', SITES, 'SiteID');
  await land(db, batchId, 'history', HISTORY, 'ID');

  await db.execute(dsql`
    UPDATE import_batch SET rows_read = ${CUSTOMERS.length + SITES.length + HISTORY.length},
      rows_written = ${CUSTOMERS.length + SITES.length + HISTORY.length}, finished_at = now()
    WHERE id = ${batchId}`);
  await close();

  console.log('[demo] transforming\n');
  await transformCustomers();
  await transformProperties();
  await transformHistory();

  console.log('\n[demo] verifying the result\n');
  await verify();

  console.log('\n');
  await report({ write: false });
}

async function verify() {
  await initFieldKey();
  const { db, close } = await createDb();
  const rows = (r: any) => (r.rows ?? r) as any[];
  let failures = 0;
  const check = (label: string, pass: boolean, detail = '') => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
    if (!pass) failures++;
  };

  const hit = async (q: string) =>
    rows(await db.execute(dsql`SELECT display_name, score FROM search_customers(${q}, 5)`));

  // Assert against the specific record: 'beauchamp' legitimately matches both
  // the 2006 household and its 2014 duplicate, so a top-hit assertion is
  // ambiguous by construction.
  const beau = rows(await db.execute(dsql`SELECT display_name FROM customer WHERE legacy_id='14032'`))[0];
  check('two people in one legacy name field kept together',
    beau?.display_name === 'Robert & Linda Beauchamp', `-> "${beau?.display_name}"`);

  check('misspelled search still finds the customer',
    (await hit('beuchamp')).length > 0);

  check('business detected from name, not a person',
    rows(await db.execute(dsql`SELECT kind, company_name FROM customer WHERE legacy_id='20881'`))[0]?.kind === 'commercial');

  check('7-digit legacy phone got the area code',
    rows(await db.execute(dsql`SELECT primary_phone FROM customer WHERE legacy_id='14033'`))[0]?.primary_phone === '(802) 555-9987');

  check('ZIP leading zero restored',
    rows(await db.execute(dsql`
      SELECT a.postal_code FROM customer c JOIN address a ON a.id=c.billing_address_id
      WHERE c.legacy_id='14032'`))[0]?.postal_code === '05446');

  check('"Vermont" normalized to VT',
    rows(await db.execute(dsql`
      SELECT a.state FROM customer c JOIN address a ON a.id=c.billing_address_id
      WHERE c.legacy_id='14033'`))[0]?.state === 'VT');

  check('1900-01-01 treated as blank, not a real date',
    rows(await db.execute(dsql`SELECT customer_since FROM customer WHERE legacy_id='14034'`))[0]?.customer_since === null);

  check('two-digit year expanded correctly',
    String(rows(await db.execute(dsql`SELECT customer_since FROM customer WHERE legacy_id='14032'`))[0]?.customer_since).startsWith('2006'));

  check('customer with two properties kept both',
    Number(rows(await db.execute(dsql`
      SELECT count(*)::int n FROM property p JOIN customer c ON c.id=p.customer_id
      WHERE c.legacy_id='14032'`))[0]?.n) === 2);

  // ADR 0003: the code is stored as ciphertext and is unreadable without the
  // key, which the database does not hold.
  const gate = rows(await db.execute(dsql`
    SELECT gate_code_enc, pet_notes FROM property WHERE legacy_id='S-001'`))[0];
  check('pet notes carried to the property profile',
    gate?.pet_notes === 'Golden retriever, Moose');
  const staged = rows(await db.execute(dsql`
    SELECT payload FROM legacy_row WHERE entity='property' AND legacy_id='S-001'`))[0];
  const stagedRaw = JSON.stringify(staged?.payload ?? {});
  check('gate code is NOT in the staging table either',
    !stagedRaw.includes('4417') && /v1:/.test(stagedRaw),
    'legacy_row.payload holds ciphertext, not the code');

  check('gate code is NOT stored in plaintext',
    typeof gate?.gate_code_enc === 'string'
      && gate.gate_code_enc.startsWith('v1:')
      && !gate.gate_code_enc.includes('4417'),
    `stored as "${String(gate?.gate_code_enc).slice(0, 24)}..."`);
  check('gate code decrypts back to the original with the key',
    decryptField(gate?.gate_code_enc) === '4417');

  check('orphaned site rejected rather than silently attached',
    rows(await db.execute(dsql`SELECT id FROM property WHERE legacy_id='S-004'`)).length === 0);

  check('orphaned activity logged as an issue',
    Number(rows(await db.execute(dsql`
      SELECT count(*)::int n FROM import_issue WHERE code='ORPHAN_HISTORY'`))[0]?.n) >= 1);

  check('unmapped transaction type still reached the timeline',
    rows(await db.execute(dsql`SELECT kind FROM timeline_event WHERE legacy_id='H-1007'`))[0]?.kind === 'note');

  check('dateless activity skipped and reported',
    Number(rows(await db.execute(dsql`
      SELECT count(*)::int n FROM import_issue WHERE code='HISTORY_NO_DATE'`))[0]?.n) === 1);

  check('history landed on the right property',
    rows(await db.execute(dsql`
      SELECT p.label FROM timeline_event t JOIN property p ON p.id=t.property_id
      WHERE t.legacy_id='H-1003'`))[0]?.label === 'Camp');

  check('2007 invoice kept its original date, not the import date',
    String(rows(await db.execute(dsql`
      SELECT occurred_at FROM timeline_event WHERE legacy_id='H-1001'`))[0]?.occurred_at).includes('2007'));

  // Migrated account notes are backdated to when the customer was set up, so a
  // 1998 commercial account correctly sorts before a 2006 household. Assert the
  // specific record rather than "earliest overall".
  check('migrated account note is backdated to customer_since',
    String(rows(await db.execute(dsql`
      SELECT occurred_at FROM timeline_event WHERE legacy_id='CNOTE-14032'`))[0]?.occurred_at).includes('2006'));

  check('legacy account note preserved on the timeline',
    rows(await db.execute(dsql`
      SELECT body FROM timeline_event WHERE legacy_id='CNOTE-14032'`))[0]?.body?.includes('bad seam'));

  check('duplicate household surfaced for review',
    Number(rows(await db.execute(dsql`
      SELECT count(*)::int n FROM (
        SELECT primary_phone FROM customer WHERE primary_phone IS NOT NULL
        GROUP BY primary_phone HAVING count(*) > 1) x`))[0]?.n) === 1);

  check('nameless account still importable and findable by number',
    (await hit('20883')).length > 0);

  // Regression: trigram similarity treats all 802 numbers as alike, so fuzzy
  // matching on digits returned the entire customer list. A nearly-correct
  // phone number is a DIFFERENT customer, and showing it at a counter is how
  // the wrong account gets charged.
  const byPhone = await hit('8025557700');
  check('phone search returns only that phone, not every 802 number',
    byPhone.length === 1 && byPhone[0]?.display_name === 'Basin Harbor Club LLC',
    `${byPhone.length} hit(s)`);

  const sharedPhone = await hit('8025550142');
  check('a shared household phone returns exactly the accounts that share it',
    sharedPhone.length === 2, `${sharedPhone.length} hit(s)`);

  check('a phone number that belongs to nobody returns nothing',
    (await hit('8025559999')).length === 0);

  check('names still match fuzzily after the numeric fix',
    (await hit('whitcom')).length > 0);

  // Regression: date-only legacy values stored at UTC midnight rendered a day
  // early everywhere east of Greenwich-minus-nothing. Pinned to local noon.
  check('a 2018-10-14 delivery reads as Oct 14 in Vermont, not Oct 13',
    rows(await db.execute(dsql`
      SELECT to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
      FROM timeline_event WHERE legacy_id='H-1003'`))[0]?.d === '2018-10-14');

  // Regression: multi-word queries were matched as one literal phrase, so
  // "beauchamp robert" found nothing while "beauchamp" worked. Staff type names
  // in whatever order comes to mind.
  check('surname-first search works', (await hit('beauchamp robert')).length > 0);
  check('given-name-first search works', (await hit('robert beauchamp')).length > 0);
  check('name plus town narrows correctly',
    (await hit('whitcomb colchester')).length >= 1);
  check('a second word narrows rather than widens',
    (await hit('beauchamp zzzz')).length === 0);

  // Regression: addresses were absent from the haystack, so narrowing by town
  // - the thing staff do constantly, because half the county shares a surname -
  // returned nothing.
  check('street address finds the customer',
    (await hit('42 lakeview')).length > 0);
  check('a service-property address finds its owner',
    (await hit('malletts bay')).length > 0);
  check('town alone lists everyone in that town',
    (await hit('colchester')).length >= 2);

  check('a 5/12/2007 invoice reads as May 12',
    rows(await db.execute(dsql`
      SELECT to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
      FROM timeline_event WHERE legacy_id='H-1001'`))[0]?.d === '2007-05-12');

  // Idempotency: the whole point of the design.
  const before = rows(await db.execute(dsql`SELECT count(*)::int n FROM customer`))[0].n;
  await close();
  await transformCustomers();
  const { db: db2, close: close2 } = await createDb();
  const after = rows(await db2.execute(dsql`SELECT count(*)::int n FROM customer`))[0].n;
  check('re-running the transform does not duplicate anything', before === after, `${before} -> ${after}`);
  await close2();

  console.log(`\n${failures === 0 ? 'ALL DEMO CHECKS PASSED' : `${failures} DEMO CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}
