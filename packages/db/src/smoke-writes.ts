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
  WriteError,
} from './write/index.js';

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
  work_order, work_order_task, import_batch, import_issue, legacy_row
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
// work order carries the demo gate code in any column.
const jobRows = rows<Record<string, unknown>>(await db.execute(sql`
  SELECT w.*, p.label AS property_label
    FROM work_order w LEFT JOIN property p ON p.id = w.property_id`));
check('no work order row carries a gate code in any field',
  !JSON.stringify(jobRows).includes('4417'),
  `${jobRows.length} job row(s) scanned`);

console.log(`\n${failures === 0 ? 'ALL WRITE CHECKS PASSED' : `${failures} WRITE CHECK(S) FAILED`}`);
await close();
process.exitCode = failures === 0 ? 0 : 1;
