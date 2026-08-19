/**
 * API-level checks for the technician endpoints.
 *
 * The database smoke tests prove the schema holds. These prove the HTTP surface
 * holds, which is a different question: who is allowed to call it, what happens
 * when a session expires mid-day, and whether a retry lands twice.
 *
 * Needs the dev server running:
 *   npm run dev -w @lcp/web
 *   npx tsx scripts/smoke-tech-api.ts
 *
 * Sessions are minted directly rather than driven through the login form: this
 * is testing the API, not the form, and a browserless script has no business
 * replaying a server action.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, loadRepoEnv, signIn, SESSION_COOKIE } from '@lcp/db';

loadRepoEnv();

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3100';
const rows = (r: any) => (r?.rows ?? r) as any[];

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

const { db, close } = await createDb();

// ── fixtures ───────────────────────────────────────────────────────────────

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
  WHERE w.assigned_user_id = ${mike.id}::uuid AND w.scheduled_date = CURRENT_DATE
  ORDER BY w.sequence LIMIT 1`))[0];

if (!mikeJob) {
  console.error('No jobs today. Run: npm run etl -- seed:jobs');
  process.exit(1);
}

async function session(email: string, pin: string): Promise<string> {
  const r = await signIn(db, { email, pin });
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${r.error}`);
  return `${SESSION_COOKIE}=${r.token}`;
}

const asMike = await session(mike.email, '246810');
const asJess = await session(jess.email, '135791');

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
check('gate codes are never in the day payload',
  !JSON.stringify(day).includes('gate_code_enc') && !JSON.stringify(day).includes('4417'));

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

const ping = rows(await db.execute(sql`
  SELECT user_id, reason, lat FROM work_order_ping
  WHERE work_order_id = ${mikeJob.id}::uuid ORDER BY occurred_at DESC LIMIT 1`))[0];
check('a location ping records who sent it', ping?.user_id === mike.id);
check('the coordinates are stored', Number(ping?.lat) > 44 && Number(ping?.lat) < 45);

const action = rows(await db.execute(sql`
  SELECT user_id FROM synced_action WHERE client_action_id = ${pingId}::uuid`))[0];
check('every applied action records who sent it', action?.user_id === mike.id);

// ── gate codes ─────────────────────────────────────────────────────────────

const prop = rows(await db.execute(sql`
  SELECT id FROM property WHERE gate_code_enc IS NOT NULL LIMIT 1`))[0];

if (prop) {
  check('a gate code is refused without a session',
    (await post('/api/gate-code', { propertyId: prop.id })).status === 401);

  const revealed = await post('/api/gate-code', { propertyId: prop.id }, asMike);
  check('a signed-in technician can reveal a gate code', revealed.ok);
  check('the revealed code is correct', (await revealed.json()).code === '4417');

  const logged = rows(await db.execute(sql`
    SELECT user_id, field FROM sensitive_access_log
    WHERE entity_id = ${prop.id}::uuid ORDER BY occurred_at DESC LIMIT 1`))[0];
  check('the reveal is logged against a real user, not a placeholder',
    logged?.user_id === mike.id && logged?.field === 'gate_code');
}

console.log(`\n${failures === 0 ? 'ALL TECH API CHECKS PASSED' : `${failures} TECH API CHECK(S) FAILED`}`);
await close();
process.exit(failures === 0 ? 0 : 1);
