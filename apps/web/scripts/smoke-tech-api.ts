/**
 * API-level checks for the technician endpoints.
 *
 * The database smoke tests prove the schema holds. These prove the HTTP surface
 * holds, which is a different question: who is allowed to call it, what happens
 * when a session expires mid-day, and whether a retry lands twice.
 *
 * Needs a FRESHLY started dev server:
 *   npm run dev -w @lcp/web
 *   npx tsx apps/web/scripts/smoke-tech-api.ts
 *
 * Freshly started matters, and the reason shapes this whole file. PGlite is an
 * embedded single-writer database, and two processes reading one data directory
 * do not share a page cache: whatever a process has already read, it keeps
 * answering from. A server that has been serving requests for a while has
 * app_user and app_session cached and cannot see the sessions minted below, so
 * every check comes back 401. Restart it, and it reads them off disk.
 *
 * The same constraint is why the database is touched in exactly two phases -
 * once before any request goes out, once after the last one has come back - and
 * never in between. Opening PGlite repeatedly underneath a running server
 * aborts the WASM runtime mid-run; opening it once, at a quiet moment, is what
 * this can safely do. Anything checkable over HTTP is therefore checked over
 * HTTP, and the closing phase is kept to the effects no endpoint exposes.
 *
 * Sessions are minted directly rather than driven through the login form: this
 * is testing the API, not the form, and a browserless script has no business
 * replaying a server action.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, loadRepoEnv, signIn, createUser, setPin, SESSION_COOKIE } from '@lcp/db';

loadRepoEnv();

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3100';

/**
 * This suite CREATES a signed-in office account with a PIN written in this
 * file, and the office is deliberately unscoped for gate codes — so that
 * account can reveal the code for any property in the database. Against demo
 * data that is a fixture. Against a real database it is a live account with
 * published credentials and keys to several hundred houses.
 *
 * So it refuses to run anywhere but a local server on the embedded database. A
 * stray DATABASE_URL in the environment, or a SMOKE_BASE left exported in a
 * shell, is exactly how this would otherwise be pointed somewhere real without
 * anybody deciding to.
 */
{
  const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local || process.env.DATABASE_URL) {
    console.error(
      'Refusing to run: this suite creates a signed-in office account and is for\n' +
      'the local demo database only.\n' +
      `  target:       ${BASE}${local ? '' : '   <- not local'}\n` +
      `  DATABASE_URL: ${process.env.DATABASE_URL ? 'set   <- must be unset' : 'unset'}`,
    );
    process.exit(1);
  }
}
const rows = (r: any) => (r?.rows ?? r) as any[];

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

/** One connection, opened and given straight back. See the note above. */
async function withDb<T>(fn: (db: any) => Promise<T>): Promise<T> {
  const { db, close } = await createDb();
  try {
    return await fn(db);
  } finally {
    await close();
  }
}

// ── fixtures: the first and only database phase before the requests ────────

/**
 * Somebody behind the counter.
 *
 * Not seeded by the ETL, whose demo data is technicians and customers. The
 * office side needs its own fixture for one reason: gate-code scoping splits
 * field from office, and a regression that locks the counter out of a code they
 * are asked for on the phone should fail this suite loudly rather than turn up
 * as a call the shop cannot answer.
 *
 * Idempotent across runs - reuse the row if it is there, and reset the PIN
 * either way, which also clears any lockout a failed run left behind.
 */
const OFFICE_EMAIL = 'counter-smoke@lakechamplainpools.example';
const OFFICE_PIN = '507392';

async function ensureOfficeUser(db: any) {
  const existing = rows(await db.execute(sql`
    SELECT id FROM app_user WHERE lower(email) = ${OFFICE_EMAIL}`))[0];

  // `role` is deliberately NOT passed: the check below asserts that a new user
  // gets the office role by default, and passing it would only prove the insert
  // stored what it was handed. If that default ever changes to 'tech', the
  // counter silently becomes field-scoped and this suite must fail.
  const id: string = existing?.id ?? (await createUser(db, {
    email: OFFICE_EMAIL,
    displayName: 'Counter (smoke fixture)',
    pin: OFFICE_PIN,
  })).id;

  await setPin(db, id, OFFICE_PIN);
  await db.execute(sql`UPDATE app_user SET active = true WHERE id = ${id}::uuid`);

  return rows(await db.execute(sql`
    SELECT id, email, role FROM app_user WHERE id = ${id}::uuid`))[0];
}

const fixtures = await withDb(async (db) => {
  const mike = rows(await db.execute(sql`
    SELECT id, email FROM app_user WHERE email = 'mtech@lakechamplainpools.example'`))[0];
  const jess = rows(await db.execute(sql`
    SELECT id, email FROM app_user WHERE email = 'jtech@lakechamplainpools.example'`))[0];

  if (!mike || !jess) {
    console.error('Seed first: npm run etl -- demo, then set PINs with user-cli.');
    process.exit(1);
  }

  const mikeJob = rows(await db.execute(sql`
    SELECT w.id, t.id AS task_id
    FROM work_order w
    LEFT JOIN work_order_task t ON t.work_order_id = w.id
    WHERE w.assigned_user_id = ${mike.id}::uuid AND w.scheduled_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
    ORDER BY w.sequence LIMIT 1`))[0];

  if (!mikeJob) {
    console.error('No jobs today. Run: npm run etl -- seed:jobs');
    process.exit(1);
  }

  const office = await ensureOfficeUser(db);

  // Pinned to the demo's coded property rather than whichever row comes back
  // first. Once the reveal is scoped to the caller's own jobs, "SELECT ... LIMIT
  // 1" decides whether the positive case is a positive case, and it decides it
  // by row order. S-001 is the demo property with a code (4417#), and seed-jobs
  // assigns its job to Mike - so Mike is the assigned technician here and Jess,
  // a technician with no jobs at all (the empty-day check below says so), is the
  // ready-made negative.
  const prop = rows(await db.execute(sql`
    SELECT id FROM property
    WHERE legacy_id = 'S-001' AND legacy_source = 'evosus' AND gate_code_enc IS NOT NULL`))[0];

  async function session(email: string, pin: string): Promise<string> {
    const r = await signIn(db, { email, pin });
    if (!r.ok) throw new Error(`sign-in failed for ${email}: ${r.error}`);
    return `${SESSION_COOKIE}=${r.token}`;
  }

  return {
    mike, jess, mikeJob, office, prop,
    asMike: await session(mike.email, '246810'),
    asJess: await session(jess.email, '135791'),
    asOffice: await session(office.email, OFFICE_PIN),
  };
});

const { mike, jess, mikeJob, office, prop, asMike, asJess, asOffice } = fixtures;

/**
 * When this run started. sensitive_access_log is append-only and never reset,
 * so counting all-time rows would pass forever after the first run that ever
 * logged a reveal - including if reveal logging were deleted outright. Every
 * assertion against that table is scoped to rows written after this moment.
 */
const runStart = new Date().toISOString();

const get = (path: string, cookie?: string) =>
  fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });

const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

// ── authentication ─────────────────────────────────────────────────────────

check('the day is refused without a session', (await get('/api/tech/day')).status === 401);
check('sync is refused without a session',
  (await post('/api/tech/sync', { clientActionId: randomUUID(), kind: 'ping', payload: {} })).status === 401);

const photoNoAuth = await fetch(`${BASE}/api/tech/photo`, { method: 'POST', body: new FormData() });
check('photo upload is refused without a session', photoNoAuth.status === 401);
check('photo download is refused without a session',
  (await get('/api/tech/photo?id=' + randomUUID())).status === 401);
check('customer search is refused without a session', (await get('/api/search?q=beauchamp')).status === 401);

// ── the signed-in happy path ───────────────────────────────────────────────

const dayRes = await get('/api/tech/day', asMike);
const day = await dayRes.json();
check('a signed-in technician gets their day', dayRes.ok && day.jobs?.length > 0,
  `${day.jobs?.length ?? 0} jobs`);
check('the day belongs to the signed-in technician', day.technician?.id === mike.id);
// The needle carries a '#', which is the point rather than a detail.
//
// This check used to match a bare four-digit code against the serialized
// payload, which carries four uuids per job (id, customer_id, property_id,
// assigned_user_id). Every decimal digit is also a hex digit, so a 4-digit
// code collides with a random v4 uuid about once in 2,000 - the check failed
// spuriously roughly one run in 200, on nothing but a coincidental id.
//
// Two bad fixes preceded this one, both caught by review, and both worth
// recording because they are the failure modes of fixing a test:
//
//   1. I wrote a comment claiming a word-boundary match and shipped a regex
//      that was not one. The flake was unchanged and now MIS-DOCUMENTED,
//      which is worse than leaving it - the next reader believes it is
//      handled. (Worse still, the literal reached the file with stray
//      backspace bytes in it, so it matched nothing at all.)
//   2. In the sibling suite I swapped the needle for the live gate code and
//      called the flake fixed. It was not: the live code was also four
//      digits, so the collision rate barely moved.
//
// The real fix is upstream in the fixture. Keypad codes take '#', so the demo
// code is '4417#' and cannot occur inside a hex run at all - the collision
// probability is not reduced, it is zero. The regex is belt-and-braces on top,
// and the check below asserts it has teeth so it cannot rot back into a
// substring test the way (1) did.
const CODE_IN_TEXT = /(^|[^0-9a-f])4417#/;
check('the gate-code needle cannot match inside a hex id, and still catches a leak',
  !CODE_IN_TEXT.test('ebe98bae-b8dc-4bdc-9e01-d604417c6273')
  && CODE_IN_TEXT.test('{"instructions":"gate code 4417#, side gate"}'));
check('gate codes are never in the day payload',
  !JSON.stringify(day).includes('gate_code_enc') && !CODE_IN_TEXT.test(JSON.stringify(day)));

// ── authorization ──────────────────────────────────────────────────────────

// The hole that mattered: ?tech= used to accept any id, with no session at all.
check('a technician cannot request another technician\'s day',
  (await get(`/api/tech/day?tech=${jess.id}`, asMike)).status === 403);

check('asking for your own id explicitly is fine',
  (await get(`/api/tech/day?tech=${mike.id}`, asMike)).ok);

const jessDay = await (await get('/api/tech/day', asJess)).json();
check('a technician with no work today sees an empty day, not an error',
  Array.isArray(jessDay.jobs) && jessDay.jobs.length === 0);

check('a technician cannot change the status of a job assigned to someone else',
  (await post('/api/tech/sync', {
    clientActionId: randomUUID(), kind: 'job_status',
    payload: { workOrderId: mikeJob.id, status: 'complete' },
  }, asJess)).status === 403);

check('a technician cannot tick off someone else\'s checklist',
  (await post('/api/tech/sync', {
    clientActionId: randomUUID(), kind: 'task_toggle',
    payload: { taskId: mikeJob.task_id, done: true },
  }, asJess)).status === 403);

check('a technician cannot write notes on someone else\'s job',
  (await post('/api/tech/sync', {
    clientActionId: randomUUID(), kind: 'job_notes',
    payload: { workOrderId: mikeJob.id, workPerformed: 'not mine to write' },
  }, asJess)).status === 403);

// ── idempotency ────────────────────────────────────────────────────────────

const replayId = randomUUID();
const first = await post('/api/tech/sync', {
  clientActionId: replayId, kind: 'job_status',
  payload: { workOrderId: mikeJob.id, status: 'en_route' },
  occurredAt: new Date().toISOString(),
}, asMike);
const second = await post('/api/tech/sync', {
  clientActionId: replayId, kind: 'job_status',
  payload: { workOrderId: mikeJob.id, status: 'en_route' },
}, asMike);

check('an action applies once', first.ok);
check('the same action replayed is recognised, not reapplied',
  (await second.json()).duplicate === true);

// ── the reason travels with the status ─────────────────────────────────────

// Marking a job incomplete writes it onto the customer's timeline, and that
// event is built by re-reading the work order. A reason arriving as a second
// action arrives too late: the event is already on the feed, and the feed is
// append-only by trigger, so that row can never be corrected. Hence the reason
// rides on the status change itself, in the same UPDATE.
const reason = `Customer not home and the gate was chained — smoke ${randomUUID().slice(0, 8)}`;
const incompleteId = randomUUID();

const incomplete = await post('/api/tech/sync', {
  clientActionId: incompleteId, kind: 'job_status',
  payload: { workOrderId: mikeJob.id, status: 'incomplete', incompleteReason: reason },
  occurredAt: new Date().toISOString(),
}, asMike);
check('an incomplete status carrying its reason is accepted', incomplete.ok);

const incompleteReplay = await post('/api/tech/sync', {
  clientActionId: incompleteId, kind: 'job_status',
  payload: { workOrderId: mikeJob.id, status: 'incomplete', incompleteReason: reason },
}, asMike);
check('an incomplete-with-reason replay is recognised, not reapplied',
  (await incompleteReplay.json()).duplicate === true);

// Read back through the day route, which is the server's own view of the row.
const dayAfter = await (await get('/api/tech/day', asMike)).json();
const jobAfter = dayAfter.jobs?.find((j: any) => j.id === mikeJob.id);
check('the status changed', jobAfter?.status === 'incomplete', String(jobAfter?.status));
check('the reason landed on the work order, in the same update',
  jobAfter?.incomplete_reason === reason, String(jobAfter?.incomplete_reason ?? 'null'));

// The field stays writable afterwards, so a reason typed later still edits.
const edited = `${reason} (edited)`;
check('job_notes still accepts a reason for a later edit',
  (await post('/api/tech/sync', {
    clientActionId: randomUUID(), kind: 'job_notes',
    payload: { workOrderId: mikeJob.id, incompleteReason: edited },
  }, asMike)).ok);

const dayEdited = await (await get('/api/tech/day', asMike)).json();
check('the later edit lands on the work order',
  dayEdited.jobs?.find((j: any) => j.id === mikeJob.id)?.incomplete_reason === edited);

// ── validation ─────────────────────────────────────────────────────────────

check('an unknown status is refused',
  (await post('/api/tech/sync', {
    clientActionId: randomUUID(), kind: 'job_status',
    payload: { workOrderId: mikeJob.id, status: 'teleported' },
  }, asMike)).status === 400);

check('an unknown action kind is refused',
  (await post('/api/tech/sync', { clientActionId: randomUUID(), kind: 'nonsense', payload: {} }, asMike)).status === 400);

check('a missing clientActionId is refused',
  (await post('/api/tech/sync', { kind: 'ping', payload: {} }, asMike)).status === 400);

// ── attribution ────────────────────────────────────────────────────────────

const pingId = randomUUID();
await post('/api/tech/sync', {
  clientActionId: pingId, kind: 'ping',
  payload: { workOrderId: mikeJob.id, reason: 'arrived', lat: 44.5442, lng: -73.1487, accuracy: 12 },
}, asMike);

// ── gate codes ─────────────────────────────────────────────────────────────

if (!prop) {
  check('the demo property with a gate code (S-001) is present', false,
    'run: npm run etl -- demo');
} else {
  check('a gate code is refused without a session',
    (await post('/api/gate-code', { propertyId: prop.id })).status === 401);

  const revealed = await post('/api/gate-code', { propertyId: prop.id }, asMike);
  check('a technician assigned to the job can reveal that property\'s gate code', revealed.ok);
  check('the revealed code is correct', (await revealed.json()).code === '4417#');

  // ADR 0003 point 1, the half deferred until there were jobs to scope to.
  const refused = await post('/api/gate-code', { propertyId: prop.id }, asJess);
  check('a technician with no job on that property is refused', refused.status === 403,
    `got ${refused.status}`);

  const refusedBody = await refused.json();
  // Same boundary match as the day payload above, and for the same reason.
  check('the refusal carries no code', !CODE_IN_TEXT.test(JSON.stringify(refusedBody)));
  check('the refusal sends them to the office, not to the instructions field',
    /office/i.test(refusedBody.error ?? '') && !/instruction/i.test(refusedBody.error ?? ''));

  // The counter. Staff is the role every new user gets by default in both
  // packages/db/src/auth.ts and user-cli.ts, and staff is never assigned a job -
  // so scoping this endpoint by rank rather than by field-versus-office would
  // lock the whole office out of a call they take every week.
  check('the office fixture has the role new users actually get', office.role === 'staff',
    String(office.role));

  const fromCounter = await post('/api/gate-code', { propertyId: prop.id }, asOffice);
  check('the office can still reveal a code for any property', fromCounter.status === 200,
    `got ${fromCounter.status}`);
  check('the office gets the right code', (await fromCounter.json()).code === '4417#');
}

// ── what only the database can answer ──────────────────────────────────────

// The second and last database phase: the timeline row, the ping, and the
// access log have no endpoint to read them back through. Everything above is
// already done, so this opens PGlite once with no request in flight.
await withDb(async (db) => {
  const event = rows(await db.execute(sql`
    SELECT body FROM timeline_event
    WHERE ref_type = 'work_order' AND ref_id = ${mikeJob.id}
    ORDER BY created_at DESC LIMIT 1`))[0];
  check('the timeline event written by that same action carries the reason',
    String(event?.body ?? '').includes(reason));

  const eventCount = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM timeline_event
    WHERE ref_type = 'work_order' AND ref_id = ${mikeJob.id} AND body LIKE ${`%${reason}%`}`))[0];
  check('the replay did not write a second timeline event', Number(eventCount?.n) === 1,
    `${eventCount?.n} event(s)`);

  const ping = rows(await db.execute(sql`
    SELECT user_id, reason, lat FROM work_order_ping
    WHERE work_order_id = ${mikeJob.id}::uuid ORDER BY occurred_at DESC LIMIT 1`))[0];
  check('a location ping records who sent it', ping?.user_id === mike.id);
  check('the coordinates are stored', Number(ping?.lat) > 44 && Number(ping?.lat) < 45);

  const action = rows(await db.execute(sql`
    SELECT user_id FROM synced_action WHERE client_action_id = ${pingId}::uuid`))[0];
  check('every applied action records who sent it', action?.user_id === mike.id);

  if (!prop) return;

  const byMike = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM sensitive_access_log
    WHERE entity_id = ${prop.id}::uuid AND user_id = ${mike.id}::uuid AND field = 'gate_code'
      AND occurred_at > ${runStart}::timestamptz`))[0];
  check('the reveal is logged against a real user, not a placeholder', Number(byMike?.n) >= 1);

  const byOffice = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM sensitive_access_log
    WHERE entity_id = ${prop.id}::uuid AND user_id = ${office.id}::uuid AND field = 'gate_code'
      AND occurred_at > ${runStart}::timestamptz`))[0];
  check('the office reveal is logged too', Number(byOffice?.n) >= 1);

  const byJess = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM sensitive_access_log
    WHERE entity_id = ${prop.id}::uuid AND user_id = ${jess.id}::uuid
      AND occurred_at > ${runStart}::timestamptz`))[0];
  check('a refused reveal is not recorded as a reveal', Number(byJess?.n) === 0);

  const noCode = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM sensitive_access_log
    WHERE entity_id = ${prop.id}::uuid AND reason LIKE '%4417#%'`))[0];
  check('the access log never quotes the code it recorded', Number(noCode?.n) === 0);

  // Leave the database as close to seeded as this suite can. The office
  // fixture is deactivated rather than deleted - sensitive_access_log rows
  // reference it, and the log is append-only - so a signed-in account with a
  // published PIN does not outlive the run. The demo job goes back to
  // scheduled, because both office views key "Left unfinished" off the reason
  // being present, and a smoke run should not leave phantom follow-up work on
  // a dispatch board.
  await db.execute(sql`
    UPDATE app_user SET active = false WHERE lower(email) = ${OFFICE_EMAIL}`);
  await db.execute(sql`
    UPDATE work_order SET status = 'scheduled', incomplete_reason = NULL,
                          completed_at = NULL, updated_at = now()
     WHERE id = ${mikeJob.id}::uuid`);
});

console.log(`\n${failures === 0 ? 'ALL TECH API CHECKS PASSED' : `${failures} TECH API CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
