/**
 * Behavioural checks for the write path. Sprint 2.
 *
 *   npx tsx src/smoke-writes.ts
 *
 * Companion to smoke.ts, which covers the read and migration side. This one
 * asserts the things that only became possible when staff could type into the
 * database: that a hand-entered customer is as findable as a migrated one, that
 * a gate code typed at the counter is ciphertext by the time it lands, that the
 * append-only feed holds against a UI, and that nothing gets written without a
 * name attached to it.
 *
 * Like smoke.ts, this truncates and rebuilds. Point PGLITE_DIR somewhere
 * scratch if you do not want it touching your dev data.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { createDb } from './index.js';
import {
  createUser, signIn, signOut, verifySession, setPin, revokeAllSessions, validatePin,
} from './auth.js';
import { decryptField } from './crypto.js';
import {
  createCustomer, updateCustomer,
  addContact, updateContact, removeContact,
  addProperty, updateProperty, setPropertyActive,
  addNote, setEventPinned, redactEvent, unredactEvent,
  recordWaterTest, flagReadings,
  createWorkOrder, rescheduleWorkOrder, cancelWorkOrder, TASK_TEMPLATES,
  listItemOnChannel, pushAvailabilityToChannel, pullChannelOrders,
  batchError,
  WriteError,
} from './write/index.js';
// Imported by path rather than from the package root, and deliberately so: the
// fake is a test double and index.ts does not re-export it. See the comment
// there.
import { InMemoryChannel } from './channels/fake.js';
import type { ChannelItem, ChannelListingRef } from './channels/port.js';

// Gate-code encryption needs a key. A throwaway one is correct here: this suite
// asserts that the value is unreadable without the key, not which key it is.
process.env.LCP_FIELD_KEY ??= randomBytes(32).toString('base64');

const { db, close } = await createDb();
const rows = <T,>(r: any): T[] => (r?.rows ?? r) as T[];

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

/**
 * Run something that must be refused, and hand back the message.
 *
 * The whole cause chain is joined, not just the top error. Drizzle reports a
 * failed statement as "Failed query: UPDATE ..." and hangs the message Postgres
 * actually raised - the one naming the rule that was broken - on .cause. An
 * assertion that reads only err.message tests nothing, and passes whether the
 * trigger fired or the statement matched no rows at all.
 */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err: unknown) {
    const parts: string[] = [];
    for (let e = err as any; e; e = e.cause) {
      if (e.message) parts.push(String(e.message));
    }
    return parts.join(' | ') || String(err);
  }
}

// ── Clean slate ───────────────────────────────────────────────────────────
for (const t of ['timeline_event', 'water_test']) {
  await db.execute(sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER USER`));
}
await db.execute(sql`TRUNCATE customer, address, contact, property, property_equipment,
  app_user, app_session, sensitive_access_log, water_test, timeline_event,
  work_order, work_order_task, item, item_barcode, item_fitment, channel_listing,
  import_batch, import_issue, legacy_row
  RESTART IDENTITY CASCADE`);
for (const t of ['timeline_event', 'water_test']) {
  await db.execute(sql.raw(`ALTER TABLE ${t} ENABLE TRIGGER USER`));
}

console.log('\n── Authentication ─────────────────────────────────────────\n');

await createUser(db, {
  email: 'Dana@example.com', displayName: 'Dana Whitcomb', role: 'manager', pin: '4417',
});
// Behind the counter, not in a truck. This fixture used to be "Marcus Tech" at
// mtech@example.com while carrying role 'staff', which made every assertion
// written against it read as a statement about technicians and prove nothing of
// the sort - the office-write checks below would have passed vacuously. The
// name follows the role now, and the technician is a separate account.
await createUser(db, {
  email: 'mpoulin@example.com', displayName: 'Marcus Poulin', role: 'staff', pin: '9082',
});
await createUser(db, {
  email: 'wfortin@example.com', displayName: 'Wendy Fortin', role: 'tech', pin: '6624',
});

const stored = rows<{ pin_hash: string; email: string }>(await db.execute(sql`
  SELECT pin_hash, email FROM app_user WHERE lower(email) = 'dana@example.com'
`))[0]!;

check('PIN is hashed, never stored as typed',
  stored.pin_hash.startsWith('scrypt$') && !stored.pin_hash.includes('4417'),
  `stored as "${stored.pin_hash.slice(0, 16)}..."`);

check('email is folded to lower case on the way in',
  stored.email === 'dana@example.com', `got "${stored.email}"`);

check('a second account cannot claim the same email in different case',
  (await refused(() => createUser(db, {
    email: 'DANA@example.com', displayName: 'Impostor', pin: '5566',
  }))) !== null);

check('a guessable PIN is refused', validatePin('1111') !== null && validatePin('1234') !== null);
check('a short PIN is refused', validatePin('123') !== null);
check('a workable PIN is accepted', validatePin('4417') === null);

const good = await signIn(db, { email: 'dana@example.com', pin: '4417' });
check('correct PIN signs in', good.ok === true);

const badPin = await signIn(db, { email: 'dana@example.com', pin: '0000' });
const unknownEmail = await signIn(db, { email: 'nobody@example.com', pin: '0000' });
check('wrong PIN is refused', badPin.ok === false);
check('an unknown email gives the same answer as a wrong PIN, not a hint',
  !badPin.ok && !unknownEmail.ok && badPin.error === unknownEmail.error);

if (!good.ok) throw new Error('cannot continue without a session');
const managerToken = good.token;
const manager = good.user;

const resolved = await verifySession(db, managerToken);
check('a session token resolves to the person holding it',
  resolved?.userId === manager.userId && resolved?.role === 'manager');

check('a made-up token resolves to nobody',
  (await verifySession(db, 'not-a-real-token')) === null);

// Five wrong attempts, then the correct PIN, which must still be refused.
for (let i = 0; i < 5; i++) {
  await signIn(db, { email: 'mpoulin@example.com', pin: '0000' });
}
const lockedOut = await signIn(db, { email: 'mpoulin@example.com', pin: '9082' });
check('five wrong attempts locks the account even against the right PIN',
  lockedOut.ok === false && /Too many attempts/i.test(lockedOut.ok ? '' : lockedOut.error));

// Regression: the lockout counter was only reset by a successful sign-in, so
// once an account had been locked, the first typo after waiting out the fifteen
// minutes pushed the count to 6 and locked it again. The account was recoverable
// only by getting the PIN right on the very first attempt, indefinitely.
await db.execute(sql`UPDATE app_user SET locked_until = now() - interval '1 minute'
  WHERE lower(email) = 'mpoulin@example.com'`);
const typoAfterLockout = await signIn(db, { email: 'mpoulin@example.com', pin: '0001' });
check('one typo after serving a lockout does not re-lock the account',
  !typoAfterLockout.ok && !/Too many attempts/i.test(typoAfterLockout.error),
  typoAfterLockout.ok ? '' : `-> "${typoAfterLockout.error}"`);
check('and the counter restarted rather than resuming at the threshold',
  Number(rows<{ failed_attempts: number }>(await db.execute(sql`
    SELECT failed_attempts FROM app_user WHERE lower(email) = 'mpoulin@example.com'
  `))[0]!.failed_attempts) === 1);

await db.execute(sql`UPDATE app_user SET failed_attempts = 0, locked_until = NULL
  WHERE lower(email) = 'mpoulin@example.com'`);
const staffSignIn = await signIn(db, { email: 'mpoulin@example.com', pin: '9082' });
check('clearing the lockout lets the right PIN back in', staffSignIn.ok === true);
if (!staffSignIn.ok) throw new Error('cannot continue without the staff session');
const staff = staffSignIn.user;

check('a successful sign-in resets the failed-attempt counter',
  Number(rows<{ failed_attempts: number }>(await db.execute(sql`
    SELECT failed_attempts FROM app_user WHERE lower(email) = 'mpoulin@example.com'
  `))[0]!.failed_attempts) === 0);

// An expired session is not a valid one, however good the token looks.
const secondSignIn = await signIn(db, { email: 'dana@example.com', pin: '4417' });
if (!secondSignIn.ok) throw new Error('expected a second session');
await db.execute(sql`UPDATE app_session SET expires_at = now() - interval '1 minute'
  WHERE id = ${secondSignIn.user.sessionId}::uuid`);
check('an expired session stops working',
  (await verifySession(db, secondSignIn.token)) === null);

const thirdSignIn = await signIn(db, { email: 'dana@example.com', pin: '4417' });
if (!thirdSignIn.ok) throw new Error('expected a third session');
await signOut(db, thirdSignIn.token);
check('signing out revokes that session immediately',
  (await verifySession(db, thirdSignIn.token)) === null);
check('signing out one session leaves the others alone',
  (await verifySession(db, managerToken))?.userId === manager.userId);

const fourth = await signIn(db, { email: 'mpoulin@example.com', pin: '9082' });
if (!fourth.ok) throw new Error('expected a fourth session');
await setPin(db, staff.userId, '7731');
check('changing a PIN signs out every session opened with the old one',
  (await verifySession(db, fourth.token)) === null);
check('the new PIN works', (await signIn(db, { email: 'mpoulin@example.com', pin: '7731' })).ok === true);

await db.execute(sql`UPDATE app_user SET active = false WHERE id = ${staff.userId}::uuid`);
const deactivated = await signIn(db, { email: 'mpoulin@example.com', pin: '7731' });
check('a deactivated account cannot sign in', deactivated.ok === false);
await revokeAllSessions(db, staff.userId);
await db.execute(sql`UPDATE app_user SET active = true WHERE id = ${staff.userId}::uuid`);

// A real one. 'tech' is the string app_user.role actually holds - never
// 'technician' - and the office-write checks further down are only worth
// anything if this actor genuinely carries it.
const techSignIn = await signIn(db, { email: 'wfortin@example.com', pin: '6624' });
check('a technician signs in carrying the field role, not the office default',
  techSignIn.ok && techSignIn.user.role === 'tech');
if (!techSignIn.ok) throw new Error('cannot continue without the technician session');
const tech = techSignIn.user;

console.log('\n── Creating and editing customers ─────────────────────────\n');

const created = await createCustomer(db, manager, {
  kind: 'residential',
  firstName: 'Robert',
  lastName: 'Beauchamp',
  accountNumber: '14032',
  phone: '8025550142',
  email: 'Bob.Beauchamp@Example.com',
  customerSince: '2006-03-14',
  billing: { line1: '42 Lakeview Rd', city: 'Colchester', state: 'Vermont', postalCode: '5446' },
});

check('a customer typed at the counter gets a display name from the trigger',
  created.displayName === 'Robert Beauchamp', `got "${created.displayName}"`);

const search = async (q: string) =>
  rows<{ display_name: string }>(await db.execute(sql`
    SELECT display_name FROM search_customers(${q}, 5)
  `));

check('a hand-entered customer is findable by the same fuzzy search as a migrated one',
  (await search('beuchamp'))[0]?.display_name === 'Robert Beauchamp');
check('a hand-entered customer is findable by phone digits',
  (await search('8025550142')).length === 1);
check('a hand-entered customer is findable by the town that was typed',
  (await search('colchester')).length >= 1);

const storedNew = rows<{
  primary_phone: string; primary_email: string; legacy_source: string;
  postal_code: string; state: string;
}>(await db.execute(sql`
  SELECT c.primary_phone, c.primary_email, c.legacy_source, a.postal_code, a.state
    FROM customer c JOIN address a ON a.id = c.billing_address_id
   WHERE c.id = ${created.id}::uuid
`))[0]!;

check('phone is stored in the same format the migration produces',
  storedNew.primary_phone === '(802) 555-0142', `got "${storedNew.primary_phone}"`);
check('email is folded to lower case', storedNew.primary_email === 'bob.beauchamp@example.com');
check('a 4-digit ZIP gets its New England leading zero back',
  storedNew.postal_code === '05446', `got "${storedNew.postal_code}"`);
check('"Vermont" is normalized to VT on the way in', storedNew.state === 'VT');
check('hand-entered records are marked as manual, not as Evosus',
  storedNew.legacy_source === 'manual');

const creationEvent = rows<{ kind: string; actor_label: string; actor_user_id: string; source: string }>(
  await db.execute(sql`
    SELECT kind, actor_label, actor_user_id, source FROM timeline_event
     WHERE customer_id = ${created.id}::uuid ORDER BY occurred_at
  `),
)[0]!;
check('creating a customer puts the reason it exists on the timeline',
  creationEvent.kind === 'system' && creationEvent.source === 'app');
check('the event names the person who did it, by id and by label',
  creationEvent.actor_user_id === manager.userId && creationEvent.actor_label === 'Dana Whitcomb');

// A counter is not a migration: bad input comes back as a question, not a null.
check('an unusable phone number is refused rather than silently dropped',
  (await refused(() => createCustomer(db, manager, {
    lastName: 'Test', phone: 'call after 5',
  })))?.includes('not a phone number') === true);

check('a duplicate account number is refused',
  (await refused(() => createCustomer(db, manager, {
    lastName: 'Other', accountNumber: '14032',
  })))?.includes('already belongs') === true);

// Regression: the pre-flight SELECT was the only thing stopping duplicates, so
// two terminals could both pass it and both insert. search_customers scores an
// exact account-number match at 1.0, which is how the wrong account gets pulled
// up at a counter. The index in migration 0009 is the actual guarantee.
check('the database refuses a duplicate account number even without the check',
  (await refused(() => db.execute(sql`
    INSERT INTO customer (last_name, account_number, legacy_source)
    VALUES ('Racer', '14032', 'manual')
  `)))?.includes('customer_account_number_unique_idx') === true);

check('a losing race still reads as a sentence, not a constraint violation',
  (await refused(() => createCustomer(db, manager, {
    lastName: 'Racer', accountNumber: '14032',
  })))?.includes('already belongs') === true);

check('customers without an account number are unconstrained',
  (await refused(async () => {
    await createCustomer(db, manager, { lastName: 'Walkin One' });
    await createCustomer(db, manager, { lastName: 'Walkin Two' });
  })) === null);

check('a commercial account without a company name is refused',
  (await refused(() => createCustomer(db, manager, {
    kind: 'commercial', lastName: 'Somebody',
  })))?.includes('company name') === true);

check('a customer with no name at all is refused',
  (await refused(() => createCustomer(db, manager, { phone: '8025551111' }))) !== null);

check('a tax-exempt account without its exemption ID is refused',
  (await refused(() => createCustomer(db, manager, {
    lastName: 'Club', kind: 'commercial', companyName: 'Basin Harbor Club', taxExempt: true,
  })))?.includes('exemption ID') === true);

const edited = await updateCustomer(db, manager, created.id, {
  kind: 'residential',
  firstName: 'Robert',
  lastName: 'Beauchamp',
  accountNumber: '14032',
  phone: '8025559987',
  email: 'bob.beauchamp@example.com',
  customerSince: '2006-03-14',
  billing: { line1: '42 Lakeview Rd', city: 'Colchester', state: 'VT', postalCode: '05446' },
});

check('an edit records what actually changed',
  edited.changes.length === 1 && edited.changes[0]!.includes('Phone changed from'),
  edited.changes.join(' | '));

check('search follows the edit',
  (await search('8025559987')).length === 1 && (await search('8025550142')).length === 0);

const unchanged = await updateCustomer(db, manager, created.id, {
  kind: 'residential',
  firstName: 'Robert',
  lastName: 'Beauchamp',
  accountNumber: '14032',
  phone: '8025559987',
  email: 'bob.beauchamp@example.com',
  customerSince: '2006-03-14',
  billing: { line1: '42 Lakeview Rd', city: 'Colchester', state: 'VT', postalCode: '05446' },
});
check('saving a form nobody changed does not litter the timeline',
  unchanged.changes.length === 0);

console.log('\n── Contacts ───────────────────────────────────────────────\n');

const linda = await addContact(db, manager, created.id, {
  firstName: 'Linda', lastName: 'Beauchamp', role: 'spouse',
  phone: '8025550143', isPrimary: true,
});

const promoted = await addContact(db, manager, created.id, {
  firstName: 'Robert', lastName: 'Beauchamp', role: 'owner',
  mobile: '8025550142', isPrimary: true,
});

const primaries = rows<{ id: string; first_name: string }>(await db.execute(sql`
  SELECT id, first_name FROM contact WHERE customer_id = ${created.id}::uuid AND is_primary
`));
check('promoting a new primary contact demotes the old one instead of failing',
  primaries.length === 1 && primaries[0]!.id === promoted.id,
  `${primaries.length} primary contact(s)`);

check('a contact with no name is refused',
  (await refused(() => addContact(db, manager, created.id, { phone: '8025550000' }))) !== null);

await updateContact(db, manager, linda.id, {
  firstName: 'Linda', lastName: 'Beauchamp', role: 'spouse',
  phone: '8025550143', email: 'linda@example.com',
});
check('editing a contact records the change on the timeline',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE customer_id = ${created.id}::uuid AND title LIKE 'Contact edited%'
  `)).length === 1);

await removeContact(db, manager, linda.id);
check('removing a contact keeps the fact that they existed',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE customer_id = ${created.id}::uuid AND title LIKE 'Contact removed: Linda%'
  `)).length === 1);

console.log('\n── Properties and gate codes ──────────────────────────────\n');

const mainHouse = await addProperty(db, manager, created.id, {
  label: 'Main house', propertyType: 'pool', isPrimary: true,
  accessNotes: 'Gate on the left side of the garage.',
  petNotes: 'Golden retriever, Moose',
  gateCode: '4417',
  address: { line1: '42 Lakeview Rd', city: 'Colchester', state: 'VT', postalCode: '05446' },
});

const propRow = rows<{ gate_code_enc: string; pet_notes: string }>(await db.execute(sql`
  SELECT gate_code_enc, pet_notes FROM property WHERE id = ${mainHouse.id}::uuid
`))[0]!;

check('a gate code typed at the counter is ciphertext by the time it lands',
  propRow.gate_code_enc.startsWith('v1:') && !propRow.gate_code_enc.includes('4417'),
  `stored as "${propRow.gate_code_enc.slice(0, 20)}..."`);
check('it decrypts back to what was typed', decryptField(propRow.gate_code_enc) === '4417');

check('setting a gate code is logged as a sensitive write',
  rows(await db.execute(sql`
    SELECT 1 FROM sensitive_access_log
     WHERE entity = 'property' AND entity_id = ${mainHouse.id}::uuid
       AND field = 'gate_code' AND user_id = ${manager.userId}::uuid
  `)).length === 1);

check('the gate code does not leak onto the timeline',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE customer_id = ${created.id}::uuid
       AND (COALESCE(body,'') LIKE '%4417%' OR COALESCE(title,'') LIKE '%4417%')
  `)).length === 0);

const propEdit = await updateProperty(db, manager, mainHouse.id, {
  label: 'Main house', propertyType: 'pool', isPrimary: true,
  accessNotes: 'Gate on the left side of the garage.',
  petNotes: 'Golden retriever, Moose',
  gateCode: '8890',
  address: { line1: '42 Lakeview Rd', city: 'Colchester', state: 'VT', postalCode: '05446' },
});
check('changing a gate code says that it changed, not what it changed to',
  propEdit.changes.includes('Gate code changed')
  && !propEdit.changes.join(' ').includes('8890'),
  propEdit.changes.join(' | '));

// Leaving the field out of the payload must not wipe the code on file.
await updateProperty(db, manager, mainHouse.id, {
  label: 'Main house', propertyType: 'pool', isPrimary: true,
});
check('an edit that does not mention the gate code leaves it alone',
  decryptField(rows<{ gate_code_enc: string }>(await db.execute(sql`
    SELECT gate_code_enc FROM property WHERE id = ${mainHouse.id}::uuid
  `))[0]!.gate_code_enc) === '8890');

const camp = await addProperty(db, manager, created.id, {
  label: 'Camp', propertyType: 'spa', isPrimary: true,
  address: { line1: '1180 West Lakeshore Dr', city: 'Colchester', state: 'VT', postalCode: '05446' },
});
check('promoting a new primary property demotes the old one instead of failing',
  rows(await db.execute(sql`
    SELECT 1 FROM property WHERE customer_id = ${created.id}::uuid AND is_primary
  `)).length === 1);

check('a service property address reaches the customer search haystack',
  (await search('lakeshore')).length === 1);

await setPropertyActive(db, manager, camp.id, false);
const archived = rows<{ active: boolean; is_primary: boolean }>(await db.execute(sql`
  SELECT active, is_primary FROM property WHERE id = ${camp.id}::uuid
`))[0]!;
check('archiving a property also stops it being the primary one',
  archived.active === false && archived.is_primary === false);

console.log('\n── The timeline holds ─────────────────────────────────────\n');

const note = await addNote(db, staff, {
  customerId: created.id,
  propertyId: mainHouse.id,
  kind: 'call',
  direction: 'inbound',
  title: 'Called about the liner seam',
  body: 'Wants a quote before the season starts.',
});

check('a note lands with the author attached',
  rows<{ actor_user_id: string; actor_label: string }>(await db.execute(sql`
    SELECT actor_user_id, actor_label FROM timeline_event WHERE id = ${note.id}::uuid
  `))[0]!.actor_user_id === staff.userId);

check('an empty note is refused',
  (await refused(() => addNote(db, staff, { customerId: created.id, body: '   ' }))) !== null);

check('a note cannot be dated in the future',
  (await refused(() => addNote(db, staff, {
    customerId: created.id, body: 'next week',
    occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
  })))?.includes('future') === true);

check('a sale cannot be typed in by hand - that comes from the register',
  (await refused(() => addNote(db, staff, {
    customerId: created.id, kind: 'sale', body: '$400',
  }))) !== null);

check('a note cannot be attached to another customer’s property',
  (await refused(() => addNote(db, staff, {
    customerId: created.id, propertyId: '00000000-0000-4000-8000-000000000000',
    body: 'wrong property',
  }))) !== null);

await setEventPinned(db, manager, note.id, true);
check('pinning still works, because it is presentation rather than history',
  rows<{ pinned: boolean }>(await db.execute(sql`
    SELECT pinned FROM timeline_event WHERE id = ${note.id}::uuid
  `))[0]!.pinned === true);

check('an entry cannot be rewritten',
  (await refused(() => db.execute(sql`
    UPDATE timeline_event SET body = 'nothing to see here' WHERE id = ${note.id}::uuid
  `)))?.includes('append-only') === true);

// New in Sprint 2: with a UI in front of the table, everything that gives an
// event its meaning has to be frozen, not just its body.
check('an entry’s payload cannot be rewritten',
  (await refused(() => db.execute(sql`
    UPDATE timeline_event SET payload = '{"amount":1}'::jsonb WHERE id = ${note.id}::uuid
  `)))?.includes('append-only') === true);

check('an entry cannot be reassigned to a different author',
  (await refused(() => db.execute(sql`
    UPDATE timeline_event SET actor_label = 'Somebody Else' WHERE id = ${note.id}::uuid
  `)))?.includes('append-only') === true);

check('an entry cannot be deleted',
  (await refused(() => db.execute(sql`
    DELETE FROM timeline_event WHERE id = ${note.id}::uuid
  `)))?.includes('append-only') === true);

check('hiding an entry is not something everyone can do',
  (await refused(() => redactEvent(db, staff, note.id, 'wrong customer')))
    ?.includes('manager') === true);

await redactEvent(db, manager, note.id, 'Logged against the wrong account.');
const redacted = rows<{ redacted_at: string; redacted_reason: string; redacted_by_user_id: string }>(
  await db.execute(sql`
    SELECT redacted_at, redacted_reason, redacted_by_user_id
      FROM timeline_event WHERE id = ${note.id}::uuid
  `),
)[0]!;
check('a manager can hide an entry, with a reason and a name on it',
  redacted.redacted_at !== null
  && redacted.redacted_reason === 'Logged against the wrong account.'
  && redacted.redacted_by_user_id === manager.userId);

check('hiding an entry announces itself on the same feed',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE ref_type = 'timeline_event' AND ref_id = ${note.id}
       AND payload->>'action' = 'redact'
  `)).length === 1);

// Regression: the feed cannot delete the announcement that carries the restore
// control, so the control has to be gated on the target still being hidden AND
// on this being the hide announcement rather than the restore one - both point
// at the same event. Getting either wrong put a dead button on the screen.
const restorable = async () => Number(rows<{ n: number }>(await db.execute(sql`
  SELECT count(*)::int AS n
    FROM timeline_event a
    JOIN timeline_event target ON target.id::text = a.ref_id
   WHERE a.ref_type = 'timeline_event'
     AND a.payload->>'action' = 'redact'
     AND target.redacted_at IS NOT NULL
`))[0]!.n);

check('exactly one restore control while the entry is hidden', await restorable() === 1);

check('a redaction in force cannot have its reason quietly rewritten',
  (await refused(() => db.execute(sql`
    UPDATE timeline_event SET redacted_reason = 'no reason' WHERE id = ${note.id}::uuid
  `)))?.includes('rewritten') === true);

await unredactEvent(db, manager, note.id);
check('a mistaken redaction can be undone',
  rows<{ redacted_at: string | null }>(await db.execute(sql`
    SELECT redacted_at FROM timeline_event WHERE id = ${note.id}::uuid
  `))[0]!.redacted_at === null);

check('and the restore control goes away once it has been used',
  await restorable() === 0);

console.log('\n── Water tests ────────────────────────────────────────────\n');

const test = await recordWaterTest(db, manager, {
  customerId: created.id,
  propertyId: mainHouse.id,
  freeChlorine: 0.4,
  ph: 7.8,
  totalAlkalinity: 60,
  recommendation: 'Shock tonight, then alkalinity increaser in the morning.',
});

check('a water test flags what is out of range',
  test.flags.length === 2
  && test.flags.some((f) => f.key === 'freeChlorine' && f.direction === 'low')
  && test.flags.some((f) => f.key === 'totalAlkalinity' && f.direction === 'low'),
  test.flags.map((f) => `${f.key}:${f.direction}`).join(' '));

check('a reading inside the band is not flagged',
  !test.flags.some((f) => f.key === 'ph'));

const testEvent = rows<{ kind: string; ref_id: string; payload: any; body: string }>(
  await db.execute(sql`
    SELECT kind, ref_id, payload, body FROM timeline_event
     WHERE ref_type = 'water_test' AND ref_id = ${test.id}
  `),
)[0]!;
check('a water test also appears on the timeline, linked to the reading',
  testEvent.kind === 'water_test' && testEvent.ref_id === test.id);
check('the readings are in the payload as numbers, not only as prose',
  Number(testEvent.payload.readings.ph) === 7.8
  && Number(testEvent.payload.readings.freeChlorine) === 0.4);
check('what the customer was told is recorded with the numbers',
  testEvent.body.includes('Shock tonight'));

check('a pH of 78 is refused as the typo it is',
  (await refused(() => recordWaterTest(db, manager, {
    customerId: created.id, ph: 78,
  })))?.includes('outside the plausible range') === true);

check('a blank test form is refused',
  (await refused(() => recordWaterTest(db, manager, { customerId: created.id }))) !== null);

check('a reading cannot be edited after the fact',
  (await refused(() => db.execute(sql`
    UPDATE water_test SET ph = 7.4 WHERE id = ${test.id}::uuid
  `)))?.includes('immutable') === true);

check('a reading cannot be deleted',
  (await refused(() => db.execute(sql`
    DELETE FROM water_test WHERE id = ${test.id}::uuid
  `)))?.includes('append-only') === true);

check('the advice attached to a reading can still be corrected',
  (await refused(() => db.execute(sql`
    UPDATE water_test SET notes = 'Customer called back.' WHERE id = ${test.id}::uuid
  `))) === null);

check('flagging is a pure function of the readings',
  flagReadings({ ph: '7.5' }).length === 0 && flagReadings({ ph: '8.4' })[0]?.direction === 'high');

console.log('\n── Work orders ────────────────────────────────────────────\n');

// A second household, so "that property belongs to somebody else" can be
// asserted against a real property rather than a made-up uuid.
const otherCustomer = await createCustomer(db, manager, {
  lastName: 'Nadeau', firstName: 'Paul', phone: '8025557788',
});
const otherProperty = await addProperty(db, manager, otherCustomer.id, {
  label: 'Lakeside camp', propertyType: 'pool',
  address: { line1: '9 Marble Island Rd', city: 'Colchester', state: 'VT', postalCode: '05446' },
});

check('a job with an unknown status is refused',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, status: 'pencilled_in',
  })))?.includes('status must be one of') === true);

check('a job with an unknown type is refused',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, type: 'exorcism',
  })))?.includes('type must be one of') === true);

// Not a typo class of mistake: a truck rolling to a stranger's house, and a
// customer whose timeline shows work at an address they have never heard of.
check('a job cannot be booked at another customer’s property',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, propertyId: otherProperty.id, summary: 'Wrong house',
  })))?.includes('does not belong to this customer') === true);

check('a job cannot be assigned to a technician who does not exist',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, assignedUserId: '00000000-0000-4000-8000-000000000000',
  })))?.includes('technician could not be found') === true);

const jobOne = await createWorkOrder(db, manager, {
  customerId: created.id,
  propertyId: mainHouse.id,
  type: 'opening',
  priority: 'urgent',
  scheduledDate: '2026-05-04',
  scheduledWindow: '8:00 – 10:00',
  estimatedMinutes: 90,
  sequence: 1,
  assignedUserId: staff.userId,
  summary: 'Spring opening',
  instructions: 'Look at the liner seam on the north side.',
});

const jobTwo = await createWorkOrder(db, manager, {
  customerId: otherCustomer.id,
  propertyId: otherProperty.id,
  type: 'inspection',
  scheduledDate: '2026-05-04',
  summary: 'Cover fit check',
});

const numberOf = (n: string) => Number(n.replace(/^W-/, ''));
check('two jobs booked in a row get distinct, sequential numbers',
  /^W-\d+$/.test(jobOne.number) && /^W-\d+$/.test(jobTwo.number)
  && numberOf(jobTwo.number) === numberOf(jobOne.number) + 1,
  `${jobOne.number} then ${jobTwo.number}`);

// A job with no tasks renders an empty checklist on the technician's phone,
// which is how a step gets skipped in April by somebody hired in March.
const openingTasks = rows<{ label: string; sequence: number; done: boolean }>(
  await db.execute(sql`
    SELECT label, sequence, done FROM work_order_task
     WHERE work_order_id = ${jobOne.id}::uuid ORDER BY sequence
  `),
);
check('creating a job seeds the checklist its type always covers',
  openingTasks.length === TASK_TEMPLATES.opening.length
  && openingTasks[0]!.label === TASK_TEMPLATES.opening[0]
  && openingTasks.every((t) => t.done === false),
  `${openingTasks.length} task(s)`);

check('the checklist matches the job type, not the last job type',
  rows(await db.execute(sql`
    SELECT 1 FROM work_order_task WHERE work_order_id = ${jobTwo.id}::uuid
  `)).length === TASK_TEMPLATES.inspection.length);

check('booking a job says so on the customer’s timeline',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE ref_type = 'work_order' AND ref_id = ${jobOne.id}
       AND title LIKE ${`Job ${jobOne.number} scheduled%`}
  `)).length === 1);

// ── Dispatch is office work ────────────────────────────────────────────────
//
// ADR 0009 named this gap by name: gate-code scoping is "an accident control,
// not a boundary" because the office pages were gated on having a session and
// nothing else. A technician could open /schedule, assign a job at any property
// to themselves, and the reveal check would then correctly hand over the code.
// These checks are the other half of that, and they sit here rather than in
// apps/web because the refusal has to hold for every caller, not just a form.

check('a technician cannot book a job',
  (await refused(() => createWorkOrder(db, tech, {
    customerId: created.id, propertyId: mainHouse.id, summary: 'Self-booked',
  })))?.includes('permission to schedule work') === true);

check('a technician cannot move a job',
  (await refused(() => rescheduleWorkOrder(db, tech, {
    workOrderId: jobOne.id, scheduledDate: '2026-05-09',
  })))?.includes('permission to schedule work') === true);

check('a technician cannot call a job off',
  (await refused(() => cancelWorkOrder(db, tech, {
    workOrderId: jobOne.id, reason: 'Not going.',
  })))?.includes('permission to schedule work') === true);

// The refusal must not double as a lookup: a made-up job id has to get exactly
// the same answer as a real one, or walking ids tells a technician which jobs
// exist. Same reasoning as the pre-lookup placement of the check in
// apps/web/app/api/gate-code/route.ts.
check('the refusal lands before the lookup, so it confirms nothing',
  (await refused(() => cancelWorkOrder(db, tech, {
    workOrderId: '00000000-0000-4000-8000-000000000000', reason: 'Not going.',
  })))?.includes('permission to schedule work') === true);

check('and it does not say who can, or how to become them',
  await (async () => {
    const msg = (await refused(() => cancelWorkOrder(db, tech, {
      workOrderId: jobOne.id, reason: 'Not going.',
    }))) ?? '';
    return !/manager|admin|assign|office|staff/i.test(msg);
  })());

// THE regression. Every counter account defaults to 'staff' - auth.ts and
// user-cli.ts both - so a predicate "tightened" to admin || manager would 403
// the entire office and nobody would find out until somebody tried to book a
// pool opening in April. These three checks are what make that fail here
// instead.
const counterBooking = await refused(() => createWorkOrder(db, staff, {
  customerId: created.id, propertyId: mainHouse.id,
  type: 'water_test', summary: 'Booked at the counter',
}));
check('somebody behind the counter can book a job - staff is the office default',
  counterBooking === null, counterBooking ?? '');

// Booked by the manager rather than reusing the row above, so that if the
// predicate is the thing that regressed these two still run and still name what
// broke, instead of the suite dying on an uncaught refusal.
const counterJob = await createWorkOrder(db, manager, {
  customerId: created.id, propertyId: mainHouse.id,
  type: 'water_test', summary: 'For the counter to move and call off',
});

check('and can move it',
  (await refused(() => rescheduleWorkOrder(db, staff, {
    workOrderId: counterJob.id, scheduledDate: '2026-05-11',
  }))) === null);

check('and can call it off',
  (await refused(() => cancelWorkOrder(db, staff, {
    workOrderId: counterJob.id, reason: 'Customer rebooked.',
  }))) === null);

// Self-assignment splits field from office, not senior from junior. In a
// ten-person shop the manager sometimes drives the delivery, which is why
// getTechnicians() deliberately returns every active user - so the office
// putting its own name on a job is ordinary. A technician doing it is the hole.
check('an office user may assign a job to themselves',
  (await refused(() => createWorkOrder(db, staff, {
    customerId: created.id, propertyId: mainHouse.id,
    type: 'service', summary: 'Running this one myself',
    assignedUserId: staff.userId,
  }))) === null);

check('a technician may not assign a job to themselves',
  (await refused(() => createWorkOrder(db, tech, {
    customerId: created.id, propertyId: mainHouse.id,
    type: 'service', summary: 'Self-assigned',
    assignedUserId: tech.userId,
  })))?.includes('permission to schedule work') === true);

check('nor hand themselves an existing one by rescheduling it',
  (await refused(() => rescheduleWorkOrder(db, tech, {
    workOrderId: jobOne.id, assignedUserId: tech.userId,
  })))?.includes('permission to schedule work') === true);

check('and none of that touched the job',
  rows<{ assigned_user_id: string | null }>(await db.execute(sql`
    SELECT assigned_user_id FROM work_order WHERE id = ${jobOne.id}::uuid
  `))[0]!.assigned_user_id === staff.userId);

const moved = await rescheduleWorkOrder(db, manager, {
  workOrderId: jobOne.id,
  scheduledDate: '2026-05-06',
  scheduledWindow: '1:00 – 3:00',
  assignedUserId: manager.userId,
  sequence: 2,
});

check('rescheduling records what actually moved',
  moved.changes.length === 4
  && moved.changes.some((c) => c.startsWith('Date changed from'))
  && moved.changes.some((c) => c.startsWith('Assigned to changed from')),
  moved.changes.join(' | '));

check('rescheduling appends a timeline event describing the change',
  rows<{ body: string }>(await db.execute(sql`
    SELECT body FROM timeline_event
     WHERE ref_type = 'work_order' AND ref_id = ${jobOne.id}
       AND title LIKE '%rescheduled%'
  `))[0]?.body.includes('2026-05-06') === true);

check('the move actually landed on the job',
  rows<{ scheduled_date: string; sequence: number }>(await db.execute(sql`
    SELECT scheduled_date::text, sequence FROM work_order WHERE id = ${jobOne.id}::uuid
  `))[0]!.scheduled_date === '2026-05-06');

const restated = await rescheduleWorkOrder(db, manager, {
  workOrderId: jobOne.id,
  scheduledDate: '2026-05-06',
  scheduledWindow: '1:00 – 3:00',
  assignedUserId: manager.userId,
  sequence: 2,
});
check('re-saving the same schedule does not litter the timeline',
  restated.changes.length === 0);

check('cancelling without a reason is refused',
  (await refused(() => cancelWorkOrder(db, manager, {
    workOrderId: jobTwo.id, reason: '   ',
  })))?.includes('reason for cancelling') === true);

await cancelWorkOrder(db, manager, {
  workOrderId: jobTwo.id, reason: 'Customer sold the house.',
});
check('cancelling sets the status and says why on the timeline',
  rows<{ status: string }>(await db.execute(sql`
    SELECT status FROM work_order WHERE id = ${jobTwo.id}::uuid
  `))[0]!.status === 'cancelled'
  && rows<{ body: string }>(await db.execute(sql`
    SELECT body FROM timeline_event
     WHERE ref_type = 'work_order' AND ref_id = ${jobTwo.id} AND title LIKE '%cancelled%'
  `))[0]?.body.includes('Customer sold the house.') === true);

check('a cancelled job cannot be quietly rescheduled back onto the board',
  (await refused(() => rescheduleWorkOrder(db, manager, {
    workOrderId: jobTwo.id, scheduledDate: '2026-05-07',
  })))?.includes('cancelled and cannot be rescheduled') === true);

check('the database refuses two jobs claiming the same number',
  (await refused(() => db.execute(sql`
    INSERT INTO work_order (number, customer_id, legacy_source)
    VALUES (${jobOne.number}, ${created.id}::uuid, 'manual')
  `)))?.includes('work_order_number_unique_idx') === true);

console.log(`\n── The selling-channel seam ${'─'.repeat(34)}\n`);

/**
 * Everything below runs against an in-memory channel, and that is the point
 * rather than a shortcut. There is no Shopify account, no credential and no
 * webhook endpoint for this business, so a live sync would be untested code
 * from its first line and would stay untested until somebody buys the account.
 * The rules — one listing per item, one item per external id, a bad order line
 * becomes a row — are the expensive part to get wrong, and they test perfectly
 * against nothing.
 */
const shopify = new InMemoryChannel('shopify');

const [seal, hose] = rows<{ id: string; sku: string }>(await db.execute(sql`
  INSERT INTO item (sku, description, manufacturer, model, uom, category, legacy_source)
  VALUES
    ('SP1600Z2', 'Shaft seal, Super Pump', 'Hayward', 'SP1600', 'each', 'part', 'manual'),
    ('HOSE-BW-15', 'Backwash hose, 1.5in', 'Generic', NULL, 'foot', 'accessory', 'manual')
  RETURNING id, sku
`));
await db.execute(sql`
  INSERT INTO item_barcode (item_id, code, symbology, legacy_source)
  VALUES (${seal!.id}::uuid, '0012345678905', 'ean_13', 'manual')
`);
const discontinued = rows<{ id: string }>(await db.execute(sql`
  INSERT INTO item (sku, description, uom, active, legacy_source)
  VALUES ('SP1600Z2-OLD', 'Shaft seal, superseded', 'each', false, 'manual')
  RETURNING id
`))[0]!;

// ── Pushing an item outward ────────────────────────────────────────────────

const listed = await listItemOnChannel(db, manager, shopify, { itemId: seal!.id });
check('pushing an item to a channel creates a listing',
  listed.created === true && listed.externalId !== '',
  `external id ${listed.externalId}`);

check('and the channel was told the SKU and the barcodes, and nothing else',
  shopify.listings.get(listed.externalId)?.sku === 'SP1600Z2'
  && shopify.listings.get(listed.externalId)?.barcodes.join() === '0012345678905'
  && !('price' in (shopify.listings.get(listed.externalId) ?? {})));

check('the listing records when we last spoke to the channel',
  rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM channel_listing
     WHERE item_id = ${seal!.id}::uuid AND channel = 'shopify'
       AND listed AND last_pushed_at IS NOT NULL
  `))[0]!.n === 1);

// Re-pushing is how an edited description reaches the storefront, so it has to
// be an ordinary thing to do repeatedly — a second listing for the same item
// would mean two availability numbers for one pile of stock.
const rePushed = await listItemOnChannel(db, manager, shopify, { itemId: seal!.id });
check('re-pushing the same item is idempotent: one listing, same external id',
  rePushed.created === false
  && rePushed.listingId === listed.listingId
  && rePushed.externalId === listed.externalId
  && shopify.pushItemCalls === 2
  && shopify.listings.size === 1,
  `${shopify.pushItemCalls} pushes -> ${shopify.listings.size} listing(s)`);

check('and the item still has exactly one row on that channel',
  rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM channel_listing
     WHERE item_id = ${seal!.id}::uuid AND channel = 'shopify'
  `))[0]!.n === 1);

check('a discontinued item is not put on a storefront',
  (await refused(() => listItemOnChannel(db, manager, shopify, { itemId: discontinued.id })))
    ?.includes('discontinued and cannot be offered') === true);

check('a technician may not publish the catalogue to a sales channel',
  (await refused(() => listItemOnChannel(db, tech, shopify, { itemId: hose!.id })))
    ?.includes('permission to manage sales channels') === true);

// ── One external id, one item ──────────────────────────────────────────────

/**
 * A channel that hands back the same id for everything.
 *
 * Not a straw man: an adapter that echoes a request id, a sandbox account that
 * stubs its responses, or a paginated push whose second page silently repeats
 * the first all produce exactly this. Whatever the cause, the consequence is
 * the one that matters — an inbound order line for that id resolving to
 * whichever of two items came back first, which is somebody picking the wrong
 * part off the shelf.
 */
class StuckIdChannel extends InMemoryChannel {
  override async pushItem(item: ChannelItem): Promise<ChannelListingRef> {
    await super.pushItem(item);
    return { externalId: 'STUCK-1', externalHandle: null };
  }
}
const stuck = new StuckIdChannel('other');

check('the first item through a stuck channel maps fine',
  (await listItemOnChannel(db, manager, stuck, { itemId: seal!.id })).created === true);

check('a second item cannot claim an external id another item already holds',
  (await refused(() => listItemOnChannel(db, manager, stuck, { itemId: hose!.id })))
    ?.includes('already mapped to a different item') === true);

check('and the refusal left no second row behind',
  rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM channel_listing WHERE channel = 'other'
  `))[0]!.n === 1);

// The friendly message above is a pre-flight check, and two terminals can both
// pass it before either commits. The index is the guarantee.
check('the database refuses two items claiming one external id',
  (await refused(() => db.execute(sql`
    INSERT INTO channel_listing (item_id, channel, external_id, legacy_source)
    VALUES (${hose!.id}::uuid, 'shopify', ${listed.externalId}, 'manual')
  `)))?.includes('channel_listing_external_unique_idx') === true);

check('and refuses one item holding two listings on one channel',
  (await refused(() => db.execute(sql`
    INSERT INTO channel_listing (item_id, channel, external_id, legacy_source)
    VALUES (${seal!.id}::uuid, 'shopify', 'SOME-OTHER-ID', 'manual')
  `)))?.includes('channel_listing_item_unique_idx') === true);

// ── Pushing availability ───────────────────────────────────────────────────

const callsBefore = shopify.pushAvailabilityCalls;
check('availability is refused for an item that is not listed',
  (await refused(() => pushAvailabilityToChannel(db, manager, shopify, {
    itemId: hose!.id, available: 240,
  })))?.includes('not listed on shopify') === true);

// It has to be refused HERE, not by the adapter. A real one would be spending a
// network call and a rate-limit slot on a request our own rules call invalid.
check('and the channel was never called',
  shopify.pushAvailabilityCalls === callsBefore);

check('availability pushes for a listed item',
  (await pushAvailabilityToChannel(db, manager, shopify, {
    itemId: seal!.id, available: 12,
  })).available === 12
  && shopify.availability.get(listed.externalId) === 12);

// uom is not always countable: 73.5 feet off a 100ft coil is a real number.
check('a fractional availability is allowed, because uom is not always countable',
  (await refused(() => pushAvailabilityToChannel(db, manager, shopify, {
    itemId: seal!.id, available: 73.5,
  }))) === null);

check('a negative availability is refused',
  (await refused(() => pushAvailabilityToChannel(db, manager, shopify, {
    itemId: seal!.id, available: -1,
  })))?.includes('cannot be negative') === true);

await db.execute(sql`
  UPDATE channel_listing SET listed = false WHERE id = ${listed.listingId}::uuid
`);
check('a delisted item is refused too, and the mapping is kept rather than deleted',
  (await refused(() => pushAvailabilityToChannel(db, manager, shopify, {
    itemId: seal!.id, available: 12,
  })))?.includes('delisted on shopify') === true);
await db.execute(sql`
  UPDATE channel_listing SET listed = true WHERE id = ${listed.listingId}::uuid
`);

// ── Pulling orders inward ──────────────────────────────────────────────────

shopify.seedOrder({
  externalOrderId: 'SHOP-1001',
  placedAt: new Date('2026-08-14T15:00:00Z'),
  customerEmail: 'bob.beauchamp@example.com',
  customerName: 'Bob Beauchamp',
  lines: [
    { externalId: listed.externalId, quantity: 2, description: 'Shaft seal' },
    // Added in the Shopify admin instead of here, so it maps to nothing. This
    // is the ordinary case, not the exotic one.
    { externalId: 'SHOPIFY-ONLY-99', quantity: 1, description: 'Pool noodle, blue' },
  ],
});
shopify.seedOrder({
  externalOrderId: 'SHOP-1002',
  placedAt: new Date('2026-08-15T12:30:00Z'),
  customerEmail: 'someone@example.com',
  customerName: null,
  lines: [{ externalId: listed.externalId, quantity: 1, description: 'Shaft seal' }],
});

const itemsBefore = rows<{ n: number }>(await db.execute(sql`
  SELECT count(*)::int AS n FROM item
`))[0]!.n;

const pull = await pullChannelOrders(db, manager, shopify, { since: null });

check('a pull that meets bad data still completes',
  pull.orders === 2 && pull.lines === 3,
  `${pull.orders} order(s), ${pull.lines} line(s)`);

check('the line naming an unknown external id is counted as a problem',
  pull.problems === 1 && pull.resolved === 2);

// Non-negotiable #3: bad data becomes a row, never an exception and never a
// silent null. A dropped order line is a customer who paid for something
// nobody is picking, discovered when they phone up asking where it is.
const issue = rows<{ code: string; legacy_id: string; message: string; severity: string }>(
  await db.execute(sql`
    SELECT code, legacy_id, message, severity FROM import_issue
     WHERE batch_id = ${pull.batchId}::uuid
  `));
check('and it is recorded as an import_issue rather than silently dropped',
  issue.length === 1
  && issue[0]!.code === 'UNKNOWN_CHANNEL_LISTING'
  && issue[0]!.legacy_id === 'SHOPIFY-ONLY-99'
  && issue[0]!.severity === 'error',
  issue[0]?.message);

check('the issue names the order, so it can be looked up in their admin',
  issue[0]!.message.includes('SHOP-1001') && issue[0]!.message.includes('Pool noodle'));

check('the pull run is a batch that can be reported on and re-read',
  rows<{ status: string }>(await db.execute(sql`
    SELECT status FROM import_batch WHERE id = ${pull.batchId}::uuid
  `))[0]?.status === 'succeeded');

check('and it carries a watermark, so the next pull can resume',
  (rows<{ watermark: string | null }>(await db.execute(sql`
    SELECT watermark FROM import_batch WHERE id = ${pull.batchId}::uuid
  `))[0]!.watermark ?? '').startsWith('2026-08-15'));

// THE constraint. An order for something we do not sell does not get to invent
// a part; that is the channel becoming the item master through the back door.
check('an unknown external id did NOT create an item',
  rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM item
  `))[0]!.n === itemsBefore);

check('nor edit the item master to match what the channel says',
  rows<{ description: string }>(await db.execute(sql`
    SELECT description FROM item WHERE id = ${seal!.id}::uuid
  `))[0]!.description === 'Shaft seal, Super Pump');

check('the half-resolved order is held back, and the clean one comes through',
  pull.pulled.length === 1
  && pull.pulled[0]!.externalOrderId === 'SHOP-1002'
  && pull.pulled[0]!.lines[0]!.sku === 'SP1600Z2');

check('a resolved line records that the listing was heard from',
  rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM channel_listing
     WHERE id = ${listed.listingId}::uuid AND last_pulled_at IS NOT NULL
  `))[0]!.n === 1);

check('a technician may not pull orders either',
  (await refused(() => pullChannelOrders(db, tech, shopify, {})))
    ?.includes('permission to manage sales channels') === true);

// ── A triage report is a place customer data must not reach ───────────────
//
// recordIssue() rebuilds its payload from an allow-list of keys. An allow-list
// of KEYS constrains which properties are copied and says nothing about what
// hangs off them, and `description: string | null` in the port is a
// compile-time claim a real adapter deserialising vendor JSON is not bound by.
//
// This is the exact shape a Shopify line item takes when an app writes
// note_attributes or a personalisation field into it, so it is the expected
// case rather than a hostile one. Every one of these values reached
// import_issue.payload through an allow-listed key before the values were
// coerced as well as the keys.
class HostileChannel extends InMemoryChannel {
  async pullOrders() {
    return [{
      externalOrderId: 'SHOP-9001',
      placedAt: new Date('2026-08-15T12:00:00Z'),
      customerName: 'Bob Beauchamp',
      customerEmail: 'bob.beauchamp@example.com',
      lines: [{
        externalId: 'NOPE-1',
        quantity: 1,
        description: {
          title: 'Pool noodle',
          customer: { name: 'Bob Beauchamp', email: 'bob.beauchamp@example.com' },
          note_attributes: [{ name: 'Gate code', value: '8890' }],
          shipping_address: { line1: '42 Lakeview Rd', city: 'Colchester', zip: '05446' },
        },
      }],
    }] as any;
  }
}
const hostile = new HostileChannel('other');
const hostilePull = await pullChannelOrders(db, manager, hostile, {});
const hostileIssue = rows<{ payload: any; message: string }>(await db.execute(sql`
  SELECT payload, message FROM import_issue WHERE batch_id = ${hostilePull.batchId}::uuid
`));
const hostileText = JSON.stringify(hostileIssue);

for (const [what, needle] of [
  ['a customer name', 'Beauchamp'],
  ['an email address', 'bob.beauchamp@example.com'],
  ['a street address', 'Lakeview'],
  ['a gate code', '8890'],
] as const) {
  check(`${what} nested under an allow-listed key never reaches a triage report`,
    !hostileText.includes(needle));
}

check('and the issue is still useful - it names the listing that was unmapped',
  hostileIssue.length === 1 && hostileIssue[0]!.message.includes('NOPE-1'),
  hostileIssue[0]?.message);


// ── ADR 0001: this is not a money phase ────────────────────────────────────
//
// A price column on a storefront-facing table is the shortest path there is to
// an inventory phase quietly becoming a money phase, and it would arrive as a
// one-line "we need it for the Shopify push". Money cuts over January–March;
// it is August. Assert the absence rather than trusting the comment.
const MONEY_WORDS = /(price|cost|amount|total|charge|tax|discount)/i;
for (const table of ['item', 'item_barcode', 'item_fitment', 'channel_listing']) {
  const money = rows<{ column_name: string }>(await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
  `)).map((c) => c.column_name).filter((c) => MONEY_WORDS.test(c));
  check(`${table} carries no money column`,
    money.length === 0, money.length ? `found: ${money.join(', ')}` : '');
}


console.log('\n── Finding an item at the counter ─────────────────────────\n');

/**
 * search_items() is what somebody behind the counter actually touches, and it
 * had no executable coverage at all — the tiering it depends on ("a scan
 * outranks a typed match") was verified once by hand and then rested on a
 * comment. These checks are the parts that break quietly: ranking order,
 * barcode identity across US and Canadian packaging, and two invariants that
 * an index either enforces or does not.
 */
type Hit = { sku: string; score: number; matched_barcode: string | null };
const findItems = async (q: string): Promise<Hit[]> =>
  rows<Hit>(await db.execute(sql`SELECT sku, score, matched_barcode FROM search_items(${q}, 10)`));

// A SKU with an underscore in it. SKUs have these; names do not, which is why
// search_customers can afford to strip the character and this cannot.
const underscored = rows<{ id: string }>(await db.execute(sql`
  INSERT INTO item (sku, description, manufacturer, uom, legacy_source)
  VALUES ('SP_16_00', 'Seal plate, underscore SKU', 'Hayward', 'each', 'manual')
  RETURNING id
`))[0]!;

// The decoy: an item whose SKU is, literally, the barcode printed on another
// item's box. Not contrived — a supplier's part number and a GTIN are both
// digit strings, and staff paste both into the SKU field.
await db.execute(sql`
  INSERT INTO item (sku, description, uom, legacy_source)
  VALUES ('0012345678905', 'Decoy: SKU that is another item''s barcode', 'each', 'manual')
`);

const underscoreHits = await findItems('SP_16_00');
check('an underscore SKU is findable, and is the top hit',
  underscoreHits[0]?.sku === 'SP_16_00',
  `top hit ${underscoreHits[0]?.sku ?? '(none)'} of ${underscoreHits.length}`);
check('and it is an exact-SKU match, not a fuzzy near-miss',
  Number(underscoreHits[0]?.score) === 1,
  `score ${underscoreHits[0]?.score}`);

// The tier that the whole ranking rests on: an exact SKU is an identifier, a
// description word is a guess, and they must not arrive at the same score.
const exactSku = await findItems('SP1600Z2');
const fuzzyWord = await findItems('seal');
check('an exact SKU outranks any fuzzy text match',
  Number(exactSku[0]?.score) === 1
  && Number(fuzzyWord[0]?.score) < 1
  && exactSku[0]?.sku === 'SP1600Z2',
  `exact ${exactSku[0]?.score} vs fuzzy ${fuzzyWord[0]?.score}`);

// A scan is unambiguous and must win. Both rows below score 1.0 — the seal on
// its barcode, the decoy on its SKU — so this is the tiebreak, not the score.
const scanned = await findItems('0012345678905');
check('a barcode scan outranks a text match that scores the same',
  scanned[0]?.sku === 'SP1600Z2' && scanned[0]?.matched_barcode === '0012345678905',
  `top hit ${scanned[0]?.sku} (barcode ${scanned[0]?.matched_barcode ?? 'none'}), ` +
  `then ${scanned[1]?.sku ?? '(nothing)'}`);

// US box scans 12 digits, Canadian box of the same product scans 13. Vermont
// and northern New York get both.
const upcA = await findItems('012345678905');
check('a 12-digit UPC-A finds the 13-digit EAN stored off the Canadian box',
  upcA.some((h) => h.sku === 'SP1600Z2' && h.matched_barcode === '0012345678905'),
  `hits ${upcA.map((h) => h.sku).join(', ') || '(none)'}`);

// ── Invariants an index either holds or does not ───────────────────────────

check('the same barcode cannot be claimed by a second item',
  (await refused(() => db.execute(sql`
    INSERT INTO item_barcode (item_id, code, symbology)
    VALUES (${hose!.id}::uuid, '0012345678905', 'ean_13')
  `))) !== null);

// The finding that made this a normalized index rather than a raw one: the
// unpadded spelling of a code that is already stored padded.
check('nor its unpadded spelling, which is the same GTIN',
  (await refused(() => db.execute(sql`
    INSERT INTO item_barcode (item_id, code, symbology)
    VALUES (${hose!.id}::uuid, '012345678905', 'upc_a')
  `))) !== null);

// ...while a genuinely different code that merely looks similar is still fine.
check('but a different code that is not a zero-padded variant is accepted',
  (await refused(() => db.execute(sql`
    INSERT INTO item_barcode (item_id, code, symbology)
    VALUES (${hose!.id}::uuid, '912345678905', 'upc_a')
  `))) === null);

check('a barcode cannot mean zero of something',
  (await refused(() => db.execute(sql`
    INSERT INTO item_barcode (item_id, code, pack_qty)
    VALUES (${hose!.id}::uuid, '5550000000001', 0)
  `))) !== null);

check('nor a negative quantity, which would make a sale add stock',
  (await refused(() => db.execute(sql`
    INSERT INTO item_barcode (item_id, code, pack_qty)
    VALUES (${hose!.id}::uuid, '5550000000002', -5)
  `))) !== null);

await db.execute(sql`
  INSERT INTO item_fitment (item_id, manufacturer, model)
  VALUES (${seal!.id}::uuid, 'Raypak', '406A')
`);
check('the same fitment cannot be recorded twice in different casing or padding',
  (await refused(() => db.execute(sql`
    INSERT INTO item_fitment (item_id, manufacturer, model)
    VALUES (${seal!.id}::uuid, ' raypak ', '406a')
  `))) !== null);

check('a discontinued item is still findable - service history names old parts',
  (await findItems('SP1600Z2-OLD')).some((h) => h.sku === 'SP1600Z2-OLD'));

// ── The stored haystack and the query must be folded the same way ──────────
//
// search_items() narrows to candidates against indexed columns and only then
// filters against a merged haystack. If those two are folded differently, the
// narrowing throws away rows the filter would have kept, and the search simply
// does not return an item that exists. There is no error and no empty-result
// signal — a different, wrong part comes back instead.
//
// That is not hypothetical: item.search_text was `lower()` only while the
// haystack was `lower(unaccent())`, and a search for 'trevi' returned nothing
// for an item stored as 'Trévi'. Both spellings must work, in both directions.
//
// Note the shape of the near-miss that hid it. word_similarity('trevi','trévi')
// is 0.333, just under the 0.35 threshold, so the fuzzy branch nearly rescued
// it — while word_similarity('clementine','clémentine') is 0.571 and did
// rescue it. The bug was therefore invisible on long words and fatal on short
// ones, which is the opposite of what anyone would guess, and why this asserts
// on a five-letter name.
const accented = rows<{ id: string }>(await db.execute(sql`
  INSERT INTO item (sku, description, manufacturer, uom, legacy_source)
  VALUES ('TRV-001', 'Skimmer basket, Clémentine series', 'Trévi', 'each', 'manual')
  RETURNING id
`))[0]!;
for (const spelling of ['trevi', 'trévi', 'Trévi', 'TREVI']) {
  check(`an accented manufacturer is findable typed as ${JSON.stringify(spelling)}`,
    (await findItems(spelling)).some((h) => h.sku === 'TRV-001'));
}

// Fitment is a second haystack with a second index over a second expression,
// and it was folded differently again. "which parts fit a Trévi" is the join
// this table exists for.
await db.execute(sql`
  INSERT INTO item_fitment (item_id, manufacturer, model)
  VALUES (${seal!.id}::uuid, 'Trévi', 'Sirène 2000')
`);
check('a part is findable by the accented equipment it fits, typed unaccented',
  (await findItems('sirene')).some((h) => h.sku === 'SP1600Z2'));

// Case, not accents, and a different column again: CODE_128 is arbitrary
// alphanumeric and vendors write it in capitals. The query is lowercased
// before it reaches the candidate scan, so an index over the raw column is
// probed with a pattern that cannot match it. Nobody types a barcode in the
// case it was printed in.
await db.execute(sql`
  INSERT INTO item_barcode (item_id, code, symbology)
  VALUES (${accented.id}::uuid, 'VND-AB12-XY', 'code_128')
`);
for (const spelling of ['VND-AB12', 'vnd-ab12']) {
  check(`a partial CODE_128 is findable typed as ${JSON.stringify(spelling)}`,
    (await findItems(spelling)).some((h) => h.sku === 'TRV-001'));
}

// ── Multi-token queries, which exercise a different code path entirely ─────
//
// Every check above passes ONE token, so the all-tokens ranking tier and the
// bool_and disjunct in the final filter were never reached by anything.
//
// The two tokens here differ in length AND live in different tables: 'raypak'
// is fitment text, 'seal' is the item's own description. Whichever one drives
// the candidate scan, the other has to be reachable through a different
// branch, so this fails if a non-lead branch is dropped.
//
// `ORDER BY length(tok) DESC` in the candidate scan decides which token drives
// it. I claimed in an earlier version of this comment that no assertion on
// results could ever catch that line, because every token must match for a row
// to qualify and narrowing on any single token therefore yields a superset.
// That was wrong: it is a superset for the LIKE branches only. The fuzzy
// branch compares a token against ONE region while the final filter compares
// it against the merged concatenation, so which token leads decides which side
// of that gap a row falls on.
//
// Hence the check below, which is the counterexample. '905-r' scores 0.5
// against SP1600Z2's merged haystack and 0.0 against its own search_text, so a
// scan led by '905-r' finds nothing and one led by 'hayward' finds the row.
// Flip that ORDER BY to ASC and this check fails; nothing else here does.
//
// It is a deliberately pathological input and it is worth being clear about
// why it is in a suite that otherwise tests real counter behaviour. It is not
// here because someone will type it. It is here because the line it covers has
// been mis-described in a comment twice, and a failing check is harder to talk
// past than a paragraph.
check('the candidate scan is driven by the longest token, which is observable',
  (await findItems('905-r hayward')).some((h) => h.sku === 'SP1600Z2'),
  'fails if the lead token is picked from the wrong end');
check('a fitment word and a description word together find the part',
  (await findItems('raypak seal')).some((h) => h.sku === 'SP1600Z2'),
  'fitment Raypak 406A + description "Shaft seal"');

// Order must not matter - "seal raypak" is the same question asked backwards,
// and it swaps which token is longest only if length is not what decides.
check('and the same two words in the other order',
  (await findItems('seal raypak')).some((h) => h.sku === 'SP1600Z2'));

// A second word must NARROW, never widen. This is the rule 0004 and 0005 set
// for customer search and the one users actually rely on when a first guess
// returns too much.
const oneWord = await findItems('seal');
const twoWords = await findItems('raypak seal');
check('a second word narrows the result rather than widening it',
  twoWords.length <= oneWord.length && twoWords.length > 0,
  `"seal" ${oneWord.length} hits, "raypak seal" ${twoWords.length}`);

// A transposed digit in a scanned code. Line 350 of migration 0011 says the
// barcode trigram index exists for exactly this, and for one review cycle it
// did not work: the candidate scan matched barcodes by LIKE only, so a code
// that no longer matches literally was dropped before the fuzzy filter that
// would have kept it ever ran. word_similarity of the two codes is 0.571; the
// query scores only 0.143 against the item's text, well under the 0.35
// threshold, so the barcode branch is the only
// way this row can be reached.
await db.execute(sql`
  INSERT INTO item_barcode (item_id, code, symbology)
  VALUES (${accented.id}::uuid, '0087654321098', 'ean_13')
`);
check('a barcode typed with two digits transposed still finds the item',
  (await findItems('0087654312098')).some((h) => h.sku === 'TRV-001'),
  'stored 0087654321098, typed 0087654312098');


// ── What a failed batch is allowed to record ───────────────────────────────
//
// `import_batch.error` is read in the same triage report as an import_issue
// payload, and that payload is rebuilt from an allow-list precisely so a
// customer's name or email cannot reach it. The error column had no such
// bound, on either the channel path or the three ETL call sites that run
// against real Evosus data today.
//
// A length bound is what is enforced here, not a redaction pass: guessing
// which substrings are personal works until the day it doesn't. Be clear that
// this caps blast radius rather than excluding PII — a short well-formed API
// error carrying an email still arrives whole, and that is a known limit
// rather than an oversight.
console.log('\n── What a failed batch records ───────────────────────────\n');

const longBody = `400 Bad Request: ${'x'.repeat(4000)}`;
check('a response body pasted onto an error cannot arrive whole',
  batchError(new Error(longBody)).length < 260,
  `${batchError(new Error(longBody)).length} chars`);

check('and the truncation is marked, so a clipped message is not read as complete',
  batchError(new Error(longBody)).includes('(truncated)'));

// The hole the bound had. `throw await res.json()` is an ordinary adapter
// mistake and hands us an object whose `.name` is whatever the vendor wrote
// there — which for an order endpoint is plausibly a person's name.
const namedErr = Object.assign(new Error('boom'), { name: 'N'.repeat(5000) });
check('a vendor-supplied error name cannot walk past the bound',
  batchError(namedErr).length < 260, `${batchError(namedErr).length} chars`);

// Bounding must not cost the diagnosis. An outage has to stay legible or the
// column is worthless and someone will widen it again.
check('an ordinary outage is still readable in full',
  batchError(new Error('getaddrinfo ENOTFOUND shopify.example'))
    === 'Error: getaddrinfo ENOTFOUND shopify.example');

check('and a thrown non-Error does not become "undefined"',
  batchError('connection reset') === 'Error: connection reset' && batchError(null).length > 0,
  JSON.stringify(batchError(null)));

// The bound was never what protected the ETL path. Drizzle's message is
// `Failed query: <SQL>\nparams: <bound values>`, and on that path the bound
// values are customer names, emails and addresses — so whether the 200-char
// clip removed them depended on how long the failing statement happened to be.
// For the import_issue INSERT the params begin at character 169, inside the
// window. The params section is now cut structurally, before any clipping.
const drizzleShaped = new Error(
  'Failed query: SELECT 1/0 FROM contact WHERE email = $1\nparams: bob.beauchamp@example.com');
check('bound query parameters never reach a failed batch, however short the SQL',
  !batchError(drizzleShaped).includes('bob.beauchamp@example.com'),
  JSON.stringify(batchError(drizzleShaped)));

check('and the SQL itself still survives, so the failure is still diagnosable',
  batchError(drizzleShaped).includes('SELECT 1/0 FROM contact'));



console.log('\n── Every write carries a name ─────────────────────────────\n');

const unattributed = rows<{ n: number }>(await db.execute(sql`
  SELECT count(*)::int AS n FROM timeline_event
   WHERE source = 'app' AND (actor_user_id IS NULL OR actor_label IS NULL)
`))[0]!;
check('no app-written timeline entry is missing its author',
  Number(unattributed.n) === 0, `${unattributed.n} unattributed`);

check('WriteError carries the field, so a message can land next to the input',
  await (async () => {
    try {
      await createCustomer(db, manager, { lastName: 'X', email: 'not-an-email' });
      return false;
    } catch (err) {
      return err instanceof WriteError && err.field === 'email';
    }
  })());

// ── ADR 0003: what a list view is allowed to carry ─────────────────────────
//
// The office day board and the customer's job list are reads over properties,
// and non-negotiable #4 says a gate code never appears in a list view. Today
// the only thing enforcing that is a hand-written SELECT list and a comment
// above it: add `p.access_notes` next sprint because "the tech needs it on the
// board" and every typecheck, both smoke suites, the demo and the production
// build still pass. So assert it.
//
// These queries live in apps/web and cannot be imported from here, but it is
// the SQL that matters and the SQL that would change.
console.log(`\n── Roles ${'─'.repeat(52)}\n`);

// A typo'd role does not fail closed. The dispatch gate is an allow-list, so an
// unknown role cannot schedule — but /api/gate-code scopes on `role === 'tech'`,
// so anything merely NOT 'tech' is treated as office and gets the unscoped
// reveal on every property. `--role technician` would have handed over several
// hundred houses to an account that looked correctly restricted.
check('an unknown role is refused at account creation',
  (await refused(() => createUser(db, {
    email: 'typo@example.com', displayName: 'Typo', role: 'technician' as any, pin: '8261',
  }))) !== null);

check('role matching is exact, not case-insensitive',
  (await refused(() => createUser(db, {
    email: 'typo2@example.com', displayName: 'Typo', role: 'Tech' as any, pin: '8262',
  }))) !== null);

check('and neither attempt left an account behind',
  Number(rows<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM app_user WHERE email LIKE 'typo%@example.com'
  `))[0]!.n) === 0);

console.log(`\n── ADR 0003: list views ${'─'.repeat(38)}\n`);

const SENSITIVE_COLUMNS = [
  'gate_code_enc', 'access_notes', 'pet_notes',
  'water_shutoff_notes', 'electrical_notes', 'parking_notes',
];

const queriesSrc = await readFile(
  new URL('../../../apps/web/lib/queries.ts', import.meta.url), 'utf8');

function queryBody(fnName: string): string {
  // The open paren matters: without it a longer name defined earlier (say a
  // `getDayScheduleCounts`) shadows the real one, and the check reads the
  // wrong body while printing PASS.
  const at = queriesSrc.indexOf(`export async function ${fnName}(`);
  if (at < 0) throw new Error(`${fnName} not found in queries.ts`);
  const end = queriesSrc.indexOf('\nexport ', at + 1);
  return queriesSrc.slice(at, end < 0 ? undefined : end);
}

for (const fn of ['getDaySchedule', 'getWorkOrders']) {
  // has_gate_code is the sanctioned boolean, so the column is allowed to be
  // named inside that one derivation and nowhere else.
  const body = queryBody(fn).replace(
    /\(\s*p\.gate_code_enc\s+IS\s+NOT\s+NULL\s*\)\s+AS\s+has_gate_code/gi, '');
  const leaked = SENSITIVE_COLUMNS.filter((col) => body.includes(col));
  // Guard against passing vacuously. If the SELECT is ever hoisted into a
  // shared fragment or a const, this body contains no columns at all and the
  // check below would pass while proving nothing.
  check(`${fn} still has an inline SELECT for this check to read`,
    /SELECT/i.test(body), `${body.length} chars`);
  check(`${fn} selects no sensitive property column`,
    leaked.length === 0, leaked.length ? `leaked: ${leaked.join(', ')}` : '');
}

check('getTechnicians never returns a PIN hash',
  !queryBody('getTechnicians').includes('pin_hash'));

// And at runtime rather than by reading source: nothing this suite wrote to a
// work order carries a gate code in any column.
//
// This check was rewritten after sensitive-data-guard demonstrated it passing
// while a real gate code sat in work_order.instructions. Two separate defects,
// both worth recording because both are easy to reintroduce:
//
//  1. It searched for a HARDCODED '4417'. The fixture above changes that
//     property's code to '8890' partway through the suite, so the guard was
//     looking for a value that no longer existed anywhere in the database.
//     Pasting the live code into instructions passed. So did pasting the
//     ciphertext, which is what a stray `p.gate_code_enc` in a list SELECT
//     would actually produce.
//  2. It matched a four-digit needle against whole serialized rows, uuid
//     columns included. A random v4 uuid contains any given four hex
//     characters about once in 2,100, and 17 uuid cells are scanned, so it
//     failed spuriously about one run in 200. It did, on customer_id
//     'ebe98bae-b8dc-4bdc-9e01-d604417c6273'.
//
// The uuid exclusion that fixed (2) was sound but became unnecessary once (1)
// is fixed properly, and framing it as a strength-versus-flakiness trade was
// wrong: reading the LIVE value is both stronger and has no flake surface, so
// there was no trade to make. Both plaintext and ciphertext are checked.
const jobRows = rows<Record<string, unknown>>(await db.execute(sql`
  SELECT w.*, p.label AS property_label
    FROM work_order w LEFT JOIN property p ON p.id = w.property_id`));
const serialized = JSON.stringify(jobRows);

// Every gate code any of these jobs could possibly expose, read back now
// rather than assumed from a literal written a thousand lines earlier.
const liveCodes = rows<{ enc: string }>(await db.execute(sql`
  SELECT DISTINCT p.gate_code_enc AS enc
    FROM work_order w JOIN property p ON p.id = w.property_id
   WHERE p.gate_code_enc IS NOT NULL`));

check('the gate-code check has at least one live code to look for',
  liveCodes.length > 0, `${liveCodes.length} propert(y/ies) with a code`);

const leaked: string[] = [];
for (const { enc } of liveCodes) {
  if (serialized.includes(enc)) leaked.push('ciphertext');
  const plain = decryptField(enc);
  if (plain && serialized.includes(plain)) leaked.push('plaintext');
}
check('no work order row carries a gate code in any field',
  leaked.length === 0,
  leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${jobRows.length} job row(s) scanned`);

// A real vacuity guard. The previous one asserted "some key exists", which
// cannot fail - the timestamps and numeric columns always survive, and none of
// them can carry a gate code. These are the columns a code would actually land
// in, and the check above is worthless if any of them stops being selected.
const FREE_TEXT = ['summary', 'instructions', 'work_performed', 'incomplete_reason', 'property_label'];
const missingText = FREE_TEXT.filter((c) => !(c in (jobRows[0] ?? {})));
check('and the free-text columns a code would land in are actually being scanned',
  jobRows.length > 0 && missingText.length === 0,
  missingText.length ? `not selected: ${missingText.join(', ')}` : FREE_TEXT.join(', '));


console.log(`\n${failures === 0 ? 'ALL WRITE CHECKS PASSED' : `${failures} WRITE CHECK(S) FAILED`}`);
await close();
process.exitCode = failures === 0 ? 0 : 1;
