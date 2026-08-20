# Finish the Service Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining service-story gaps: the office can no longer
overbook a technician's day without deciding to, and a technician's phone can
no longer read photos for houses they have no current job on.

**Architecture:** Capacity is a per-person minutes budget on `app_user`
(default 480), enforced in the work-order write layer in `@lcp/db` — never in
the form — with an explicit, timeline-recorded "book anyway" override. Photo
scoping reuses the exact ADR 0009 window predicate the gate-code reveal
already uses, extracted into a shared helper so the two checks cannot drift.

**Tech Stack:** Next.js 15 (App Router, server actions), Drizzle ORM +
PGlite/postgres-js dual drivers, drizzle-kit migrations, tsx smoke suites.

**Spec:** `CORE.md` (Service & Dispatch: "Cannot block overbooked service
days" → "Capacity management"), `DEMO.md` (feature-gap tables and "Known
security limits"), and the carried-open items in
`docs/adr/0009-gate-code-scoping.md` / `docs/adr/0010-who-may-dispatch.md`
("the photo GET is session-gated but not job-scoped and is cached `immutable`
for a year").

## Global Constraints

Copied from `CLAUDE.md` and the repo's own conventions — every task includes
these implicitly:

- **PGlite is single-writer.** Stop `npm run dev -w @lcp/web` before running
  `npm run smoke`, `npm run etl`, or `db:migrate`. The tech-API suite is the
  inverse: it needs a **freshly started** dev server.
- **An applied migration is immutable.** New column = new migration via
  `npm run db:generate`. Never edit an existing `.sql`.
- Hand-written migrations need `--> statement-breakpoint` between statements
  (not needed here — drizzle-kit generates Task 1's).
- Query results unwrap with `(r?.rows ?? r)` — two drivers, two shapes.
- **Gate codes / photos are ADR 0003 territory.** Never in a list response, a
  log line, an export, or an error message. Refusals must not confirm that a
  record exists.
- Authorization predicates split **field vs office, never rank**: every
  counter account defaults to `staff`, so `admin || manager` locks out the
  whole office. See the `DISPATCH_ROLES` comment in
  `packages/db/src/write/workOrders.ts:62-85`.
- `WriteError` messages are one sentence for the person who typed it.
- Comments explain *why* and cite the pain point; a change that contradicts a
  nearby comment must fix the comment (repo-reviewer check #10).
- Node 22+. Run commands from the repo root.
- Root `npm run` scripts eat `--flags` under npm 11 — call workspace scripts
  directly: `npm run <script> -w @lcp/db -- <args>`.
- Commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Nothing is pushed before the final review task.** The push is blocked by
  the review-gate hook until `mark-reviewed` runs.

---

### Task 1: The capacity column

**Files:**
- Modify: `packages/db/src/schema/timeline.ts:18-33` (the `appUser` table)
- Create (generated): `packages/db/migrations/0013_*.sql` + `meta/0013_snapshot.json` (via drizzle-kit; do not hand-write)
- Test: `npm run db:migrate` + `npm run etl -- demo` (schema-level; behaviour is Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: column `app_user.daily_capacity_minutes integer NOT NULL DEFAULT 480`,
  schema property `appUser.dailyCapacityMinutes`. Task 2 reads it in SQL as
  `u.daily_capacity_minutes`; Task 3 selects it as `assignee_capacity`.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/timeline.ts`, inside the `appUser` table, directly
after the `active` line
(`active: boolean('active').notNull().default(true),`):

```ts
  /**
   * Minutes of scheduled work this person's day holds before the board calls
   * it full — the write layer refuses past this unless the office explicitly
   * books anyway. 480 is a straight eight hours; a seasonal half-day person
   * gets their real number instead of a smaller role. Jobs with no estimate
   * count for DEFAULT_JOB_MINUTES (see write/workOrders.ts). CORE.md names
   * the pain point: "Cannot block overbooked service days."
   */
  dailyCapacityMinutes: integer('daily_capacity_minutes').notNull().default(480),
```

`integer` is already imported in that file.

- [ ] **Step 2: Generate the migration and read it before trusting it**

Run: `npm run db:generate`

Expected: a new `packages/db/migrations/0013_<name>.sql` containing exactly
one statement shaped like:

```sql
ALTER TABLE "app_user" ADD COLUMN "daily_capacity_minutes" integer DEFAULT 480 NOT NULL;
```

Open the file and confirm nothing else was generated (a second unexpected
statement means the schema edit touched more than intended — stop and fix).
Confirm `packages/db/migrations/meta/_journal.json` gained a matching `0013`
entry.

- [ ] **Step 3: Migrate and prove the pipeline still lands**

Stop the dev server if running, then:

Run: `npm run db:migrate`
Expected: `[migrate] ok`

Run: `npm run etl -- demo`
Expected: all checks PASS (currently 42/42-shaped output; the count may have
grown with Phase 3 — what matters is zero FAIL lines).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/timeline.ts packages/db/migrations
git commit -m "A day now knows how big it is: daily_capacity_minutes on app_user"
```

---

### Task 2: The write layer refuses an overbooked day

**Files:**
- Modify: `packages/db/src/write/workOrders.ts`
- Test: `packages/db/src/smoke-writes.ts` (append a Capacity section at the
  end of the Work orders section — after the reschedule/cancel checks that
  follow line 828, immediately **before** the
  `console.log('\n── Finding an item at the counter …')` banner at line 1252)

**Interfaces:**
- Consumes: `app_user.daily_capacity_minutes` (Task 1); existing
  `WriteError(message, field)` from `./input.js`; `rows`, `Db` from
  `./shared.js`.
- Produces (Task 3 relies on these exact names):
  - `export const DEFAULT_JOB_MINUTES = 60` (exported from `workOrders.ts`,
    reaches the web app through the `@lcp/db` package root, which re-exports
    `write/index.js`)
  - `WorkOrderInput.overrideCapacity?: boolean`
  - `RescheduleInput.overrideCapacity?: boolean`
  - Refusal message contains `"X of Y minutes on <date>"`; override writes a
    timeline body line starting `Booked over capacity:`.

- [ ] **Step 1: Write the failing checks**

In `packages/db/src/smoke-writes.ts`, `2026-06-01` appears nowhere in the file
(verified) — it is this section's private date, so no earlier booking pollutes
the sums. `created` (customer), `mainHouse` (their property), and the
`manager` / `staff` / `tech` actors are all in scope from earlier sections.
Append:

```ts
console.log('\n── Capacity ───────────────────────────────────────────────\n');

// CORE.md: "Cannot block overbooked service days." Parts gating waits for
// inventory; this is the overbooking half. A day is minutes, not job counts,
// because a spring opening and a filter rinse are not the same size of hole
// in a day. Jobs with no estimate count for DEFAULT_JOB_MINUTES.
const CAP_DAY = '2026-06-01';

for (let i = 1; i <= 4; i++) {
  await createWorkOrder(db, manager, {
    customerId: created.id, propertyId: mainHouse.id, type: 'service',
    scheduledDate: CAP_DAY, estimatedMinutes: 120,
    assignedUserId: tech.userId, summary: `Capacity filler ${i}`,
  });
}

check('a day filled to exactly its capacity accepts the last job',
  rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM work_order
     WHERE assigned_user_id = ${tech.userId}::uuid
       AND scheduled_date = ${CAP_DAY}::date
  `))[0]!.n === 4);

check('the job that does not fit is refused, and the refusal does the arithmetic',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, scheduledDate: CAP_DAY, estimatedMinutes: 30,
    assignedUserId: tech.userId, summary: 'One more',
  })))?.includes('480 of 480') === true);

check('a job with no estimate still occupies its default hour',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, scheduledDate: CAP_DAY,
    assignedUserId: tech.userId, summary: 'No estimate',
  })))?.includes('would make 540') === true);

// A full day belongs to one person, not to the date.
const differentTruck = await createWorkOrder(db, manager, {
  customerId: created.id, scheduledDate: CAP_DAY, estimatedMinutes: 450,
  assignedUserId: staff.userId, summary: 'Different truck',
});
check('someone else’s day is not consulted',
  /^W-\d+$/.test(differentTruck.number));

check('an unassigned job is never capacity-checked',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, scheduledDate: CAP_DAY, estimatedMinutes: 480,
    summary: 'Still needs a name',
  }))) === null);

const squeezed = await createWorkOrder(db, manager, {
  customerId: created.id, propertyId: mainHouse.id, type: 'service',
  scheduledDate: CAP_DAY, estimatedMinutes: 45,
  assignedUserId: tech.userId, summary: 'Squeezed in',
  overrideCapacity: true,
});
check('the office can knowingly book past a full day',
  /^W-\d+$/.test(squeezed.number));

check('and the timeline says so in plain arithmetic',
  rows(await db.execute(sql`
    SELECT 1 FROM timeline_event
     WHERE ref_type = 'work_order' AND ref_id = ${squeezed.id}
       AND body LIKE '%Booked over capacity%'
  `)).length === 1);

// Moving work onto a full day is the same booking decision from a different
// form, so it is guarded the same way.
const elsewhere = await createWorkOrder(db, manager, {
  customerId: created.id, propertyId: mainHouse.id, type: 'service',
  scheduledDate: '2026-06-02', estimatedMinutes: 60,
  assignedUserId: tech.userId, summary: 'On the day after',
});

check('rescheduling onto a full day is refused the same way',
  (await refused(() => rescheduleWorkOrder(db, manager, {
    workOrderId: elsewhere.id, scheduledDate: CAP_DAY,
    assignedUserId: tech.userId,
  })))?.includes(`minutes on ${CAP_DAY}`) === true);

check('and lands with the same explicit override',
  (await refused(() => rescheduleWorkOrder(db, manager, {
    workOrderId: elsewhere.id, scheduledDate: CAP_DAY,
    assignedUserId: tech.userId, overrideCapacity: true,
  }))) === null);

check('a window change on an already-full day is not re-refused',
  (await refused(() => rescheduleWorkOrder(db, manager, {
    workOrderId: squeezed.id, scheduledDate: CAP_DAY,
    assignedUserId: tech.userId, scheduledWindow: 'after 4pm',
  }))) === null);

// Calling work off hands the minutes back. The sum reads live rows, never
// history: staff's 450 + another 450 would not fit, but after the
// cancellation it does.
await cancelWorkOrder(db, manager, {
  workOrderId: differentTruck.id, reason: 'Customer away.',
});
check('a cancelled job hands its minutes back',
  (await refused(() => createWorkOrder(db, manager, {
    customerId: created.id, scheduledDate: CAP_DAY, estimatedMinutes: 450,
    assignedUserId: staff.userId, summary: 'Fits again after the cancellation',
  }))) === null);
```

- [ ] **Step 2: Run to verify the new checks fail**

Dev server stopped. Run: `npm run smoke:writes -w @lcp/db`

Expected: the pre-existing checks all PASS; among the new Capacity section,
these FAIL (nothing refuses yet, no timeline note is written):
`the job that does not fit is refused…`, `a job with no estimate…`,
`and the timeline says so…`, `rescheduling onto a full day is refused…`.
(`tsx` strips types without checking them, so the not-yet-existing
`overrideCapacity` property runs fine; `npm run typecheck` would flag it —
that is why Step 4 comes before Step 5.)

- [ ] **Step 3: Implement the rule in `workOrders.ts`**

Three edits.

**(a)** After the `WORK_ORDER_PRIORITIES` block (line ~56), add:

```ts
/**
 * What a job with no estimate is assumed to occupy. A single number rather
 * than per-type guesses: the office fills in estimated_minutes when it
 * matters, and an unestimated job blocking exactly one hour is legible in a
 * way a lookup table is not. The day board shows the same arithmetic
 * (apps/web/app/(office)/schedule/page.tsx), so keep the two importing this
 * one constant rather than agreeing by coincidence.
 */
export const DEFAULT_JOB_MINUTES = 60;
```

**(b)** Add `overrideCapacity?: boolean;` to **both** input types:
in `WorkOrderInput` after the `tasks?` line, and in `RescheduleInput` after
the `sequence?` line, each with the same one-line comment:

```ts
  /** The office saw the full day and booked anyway. Recorded on the timeline. */
  overrideCapacity?: boolean;
```

**(c)** After the `assigneeName` function, add the check itself:

```ts
/**
 * CORE.md: "Cannot block overbooked service days." Now it can.
 *
 * The day is a minutes budget per person (app_user.daily_capacity_minutes),
 * not a job count, and the guard lives here rather than in the form so that
 * every caller — the customer page, the board, whatever Sprint 4 builds —
 * gets it for free. It is a business guard, not authorization: any dispatch
 * role may book past it by saying so (`overrideCapacity`), because in a real
 * June somebody will have to, and the honest design records the decision on
 * the timeline instead of pretending the ceiling is never broken.
 *
 * Returns the timeline line for an override, null when the job simply fits.
 * Throws the refusal otherwise — with the arithmetic in it, because "the day
 * is full" invites an argument and "480 of 480, this adds 30" does not.
 */
async function assertCapacity(
  db: Db,
  assignedUserId: string,
  date: string,
  addMinutes: number,
  opts: { override: boolean; excludeWorkOrderId?: string | null },
): Promise<string | null> {
  const load = rows<{ name: string; capacity: number; minutes: number }>(await db.execute(sql`
    SELECT u.display_name AS name,
           u.daily_capacity_minutes AS capacity,
           COALESCE(SUM(COALESCE(w.estimated_minutes, ${DEFAULT_JOB_MINUTES})), 0)::int AS minutes
      FROM app_user u
      LEFT JOIN work_order w
        ON w.assigned_user_id = u.id
       AND w.scheduled_date = ${date}::date
       AND w.status <> 'cancelled'
       AND w.id IS DISTINCT FROM ${opts.excludeWorkOrderId ?? null}::uuid
     WHERE u.id = ${assignedUserId}::uuid
     GROUP BY u.display_name, u.daily_capacity_minutes
  `))[0];
  if (!load) return null; // an unknown assignee is assigneeName()'s refusal, not this one

  const total = load.minutes + addMinutes;
  if (total <= load.capacity) return null;

  if (!opts.override) {
    throw new WriteError(
      `${load.name} already has ${load.minutes} of ${load.capacity} minutes on ${date}; `
      + `this job's ${addMinutes} would make ${total}. Pick another day, another person, `
      + `or tick "Book anyway".`,
      'scheduledDate',
    );
  }
  return `Booked over capacity: ${total} of ${load.capacity} minutes for ${load.name} on ${date}.`;
}
```

**(d)** Wire it into `createWorkOrder` — after the `assignedUserId` /
`assignee` resolution block and before `const labels = checklist(...)`:

```ts
  // An unassigned or undated job blocks nobody's day; the check waits until
  // both facts exist.
  let capacityNote: string | null = null;
  if (assignedUserId && date) {
    capacityNote = await assertCapacity(db, assignedUserId, date,
      estimatedMinutes ?? DEFAULT_JOB_MINUTES,
      { override: input.overrideCapacity === true });
  }
```

and add `capacityNote` to the timeline event's `body` array, after
`instructions`:

```ts
      body: [
        scheduleLine({ scheduledDate: date, scheduledWindow: window, assignee }),
        priority !== 'normal' ? `Priority: ${priority}` : null,
        instructions,
        capacityNote,
      ].filter(Boolean).join('\n') || null,
```

**(e)** Wire it into `rescheduleWorkOrder`. First add the job's own size to
the row it loads — in `loadWorkOrder`'s SELECT add `w.estimated_minutes,`
(after `w.summary,`) and add `estimated_minutes: number | null;` to the
`WorkOrderRow` type. Then, after the `if (changes.length === 0)` early
return and before the transaction:

```ts
  // Re-checked only when the day or the person changes: a window edit on a
  // deliberately overloaded day must not re-refuse a decision already made.
  const dayChanged = date !== before.scheduled_date
    || assignedUserId !== before.assigned_user_id;
  let capacityNote: string | null = null;
  if (dayChanged && assignedUserId && date) {
    capacityNote = await assertCapacity(db, assignedUserId, date,
      before.estimated_minutes ?? DEFAULT_JOB_MINUTES,
      { override: input.overrideCapacity === true, excludeWorkOrderId: before.id });
  }
```

and append `capacityNote` to that event's body:

```ts
      body: [
        changes.join('\n'),
        scheduleLine({ scheduledDate: date, scheduledWindow: window, assignee }),
        capacityNote,
      ].filter(Boolean).join('\n\n'),
```

- [ ] **Step 4: Run the checks to verify they pass**

Run: `npm run smoke:writes -w @lcp/db`
Expected: every check PASS, including all 12 new Capacity checks, zero FAIL.

- [ ] **Step 5: Typecheck everything**

Run: `npm run typecheck`
Expected: clean in db, etl, web.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/write/workOrders.ts packages/db/src/smoke-writes.ts
git commit -m "The write layer now refuses an overbooked day, unless the office means it"
```

---

### Task 3: The board shows the load; the forms can say "book anyway"

**Files:**
- Modify: `apps/web/app/actions.ts:327-355` (both work-order actions)
- Modify: `apps/web/lib/queries.ts` (`getDaySchedule` SELECT + `ScheduledJobRow` type, defined above it in the same file)
- Modify: `apps/web/app/(office)/schedule/page.tsx` (group headers + reschedule panel)
- Modify: `apps/web/app/(office)/customers/[id]/page.tsx:462-470` (the Schedule-a-job form)
- Modify: `apps/web/app/globals.css` (two rules, near `.flag` at line ~376)
- Test: `npm run typecheck`, then a scripted click-through (Step 4)

**Interfaces:**
- Consumes: `DEFAULT_JOB_MINUTES` and the `overrideCapacity` inputs from
  Task 2 (both imported via `@lcp/db`); `assignee_capacity` produced here.
- Produces: nothing later tasks use.

- [ ] **Step 1: Pass the checkbox through the actions**

In `apps/web/app/actions.ts`, add to **both** `createWorkOrderAction`'s and
`rescheduleWorkOrderAction`'s input objects (after their `summary`/`sequence`
lines respectively):

```ts
    // A checkbox: present means "on". The write layer treats anything but
    // `true` as unticked, so a missing field is simply a normal booking.
    overrideCapacity: fd.get('overrideCapacity') === 'on',
```

- [ ] **Step 2: Carry capacity onto the board's rows**

In `apps/web/lib/queries.ts`:
- In `getDaySchedule`'s SELECT, after `w.assigned_user_id, u.display_name AS assignee,` add:

```sql
           u.daily_capacity_minutes AS assignee_capacity,
```

- In the `ScheduledJobRow` type (above the function), add:

```ts
  assignee_capacity: number | null;
```

- Same file: the long comment above `getDaySchedule` contains the sentence
  `Note the write path for it is the sync endpoint, not a field on the phone
  yet — today it arrives only from a hand-built payload or seeded data.`
  That stopped being true when TechApp grew its "why" prompt
  (`apps/web/app/tech/TechApp.tsx:380`). Replace the sentence with:
  `The phone writes it through /api/tech/sync when a technician marks a job
  incomplete and says why.`

- [ ] **Step 3: Show the load and offer the override**

In `apps/web/app/(office)/schedule/page.tsx`:

**(a)** Import the constant — add to the imports at the top of the file:

```ts
import { DEFAULT_JOB_MINUTES } from '@lcp/db';
```

**(b)** Extend `Group` and `groupByTechnician` (lines 43-71) so each group
carries its person's capacity:

```ts
type Group = {
  id: string | null;
  name: string;
  capacity: number | null;
  jobs: ScheduledJobRow[];
};
```

and in the `if (!group)` branch:

```ts
      group = {
        id: job.assigned_user_id,
        name: job.assignee ?? 'Nobody assigned yet',
        capacity: job.assignee_capacity,
        jobs: [],
      };
```

**(c)** Above the page component, add the sum — cancelled rows are shown on
the board but hold no minutes, the same rule the write layer applies:

```ts
/** The minutes a column of work actually occupies. Mirrors assertCapacity. */
function loadMinutes(g: Group): number {
  return g.jobs
    .filter((j) => j.status !== 'cancelled')
    .reduce((m, j) => m + (j.estimated_minutes ?? DEFAULT_JOB_MINUTES), 0);
}
```

**(d)** In the group card's `<h3>` (line ~246), append the load — only for a
real person (the unassigned bucket has no ceiling):

```tsx
          <h3>
            {g.name} · {g.jobs.length} {g.jobs.length === 1 ? 'job' : 'jobs'}
            {g.id && g.capacity != null && (
              <span className={`load${loadMinutes(g) > g.capacity ? ' over' : ''}`}>
                {loadMinutes(g)} / {g.capacity} min
              </span>
            )}
          </h3>
```

**(e)** In `JobRow`'s reschedule panel, after the `<ScheduleFields …/>`
element and still inside the `ActionForm`, add:

```tsx
              <label className="hint" style={{ display: 'block' }}>
                <input type="checkbox" name="overrideCapacity" />{' '}
                Book anyway if this person&apos;s day is already full
              </label>
```

- [ ] **Step 4: Same checkbox on the booking form**

In `apps/web/app/(office)/customers/[id]/page.tsx`, inside the
`Schedule a job` ActionForm (line ~465), after `<JobFields …/>`:

```tsx
              <label className="hint" style={{ display: 'block' }}>
                <input type="checkbox" name="overrideCapacity" />{' '}
                Book anyway if this person&apos;s day is already full
              </label>
```

- [ ] **Step 5: The two CSS rules**

In `apps/web/app/globals.css`, next to the `.flag` block (~line 376), matching
the file's existing color idiom (check how `.flag` and `.badge.bad` pick their
colors and reuse the same variables or hex values the file already uses):

```css
.load { margin-left: 0.5rem; font-size: 0.8rem; font-weight: 400; color: #6b7280; }
.load.over { color: #b91c1c; font-weight: 600; }
```

- [ ] **Step 6: Typecheck, then look at it**

Run: `npm run typecheck` — expected clean.

Then start the dev server (`npm run dev -w @lcp/web`), sign in, and walk the
real path — a component that compiles is not a component that works:

1. Open a customer, book a job for today with `estimatedMinutes` 470 assigned
   to a technician. Book a second 60-minute job for the same person and day:
   the form must show the refusal sentence with the arithmetic, and no job is
   created.
2. Tick "Book anyway…", submit again: it lands, and the customer's timeline
   entry shows the `Booked over capacity:` line.
3. Open `/schedule`: the technician's column header reads e.g.
   `530 / 480 min` in the `over` style; another technician's column shows a
   normal load.
4. From the board, reschedule a job onto the full day without the checkbox:
   refused in the panel; with it: lands.

Stop the dev server when done (single-writer).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/actions.ts apps/web/lib/queries.ts \
  "apps/web/app/(office)/schedule/page.tsx" \
  "apps/web/app/(office)/customers/[id]/page.tsx" apps/web/app/globals.css
git commit -m "The board shows each day's load, and booking past it is a decision with a record"
```

---

### Task 4: Photos are scoped like gate codes

**Files:**
- Create: `apps/web/lib/assignment.ts`
- Modify: `apps/web/app/api/tech/photo/route.ts:119-145` (the GET)
- Modify: `apps/web/app/api/gate-code/route.ts:82-94` (use the shared predicate)
- Test: `apps/web/scripts/smoke-tech-api.ts` (new section)

**Interfaces:**
- Consumes: the existing smoke-tech-api fixtures — `mikeJob` (a work order
  assigned to Mike, today), `asMike` / `asJess` / `asOffice` session cookies,
  the `get(path, cookie)` helper, `check`, `randomUUID`.
- Produces: `assignedInWindow(userId: string): SQL` — a drizzle `sql`
  fragment for use as a condition on an aliased `work_order w`.

- [ ] **Step 1: Write the failing probes**

In `apps/web/scripts/smoke-tech-api.ts`, after the gate-code section (the
block ending with the `fromCounter` checks, ~line 390) and before the closing
database phase, add:

```ts
// ── photo scoping ──────────────────────────────────────────────────────────
//
// ADR 0003 point 5's leftover, named in ADRs 0009 and 0010 both: the GET was
// session-gated but not job-scoped, and cached immutable for a year. Photos
// of backyards, equipment and access points are exactly as sensitive as the
// rest of the property profile, so the read is scoped by the same ADR 0009
// window as the gate-code reveal. Jess — a technician with no jobs at all —
// is the ready-made negative, same as the reveal checks above.
//
// A 1x1 PNG: sniffImage trusts bytes, not declared types, so the fixture has
// to be a real image, however small.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const uploadForm = new FormData();
uploadForm.set('clientActionId', randomUUID());
uploadForm.set('workOrderId', mikeJob.id);
uploadForm.set('file', new Blob([PNG_1PX], { type: 'image/png' }), 'fixture.png');

const uploaded = await fetch(`${BASE}/api/tech/photo`, {
  method: 'POST', headers: { cookie: asMike }, body: uploadForm,
});
const uploadedBody: any = await uploaded.json();
check('a technician can upload a photo to their own job',
  uploaded.status === 200 && !!uploadedBody.id, `status ${uploaded.status}`);

const photoUrl = `/api/tech/photo?id=${uploadedBody.id}`;

const mikeGet = await get(photoUrl, asMike);
check('the assigned technician reads the photo back', mikeGet.status === 200);
check('a technician’s copy is cached briefly, not for a year',
  mikeGet.headers.get('cache-control') === 'private, max-age=3600',
  String(mikeGet.headers.get('cache-control')));

const jessGet = await get(photoUrl, asJess);
check('a technician with no job on the property gets the same 404 as a missing id',
  jessGet.status === 404);
// Guarded on status: before the fix lands Jess gets image bytes, and .json()
// on those would crash the suite instead of failing this check.
const jessBody = jessGet.status === 404
  ? JSON.stringify(await jessGet.json()) : `status ${jessGet.status}`;
const missingBody = JSON.stringify(
  await (await get(`/api/tech/photo?id=${randomUUID()}`, asJess)).json());
check('…with the same body, so walking ids confirms nothing',
  jessBody === missingBody);

const officeGet = await get(photoUrl, asOffice);
check('the office reads any photo, uncontested', officeGet.status === 200);
check('and keeps the immutable cache — office access does not expire',
  (officeGet.headers.get('cache-control') ?? '').includes('immutable'));
```

- [ ] **Step 2: Run against a fresh server to verify the new probes fail**

The suite needs seeded jobs for today and the two demo technicians' PINs
(dev server **stopped** for the database phase):

```bash
npm run etl -- demo
npm run etl -- seed:jobs
npm run user -w @lcp/db -- pin --email mtech@lakechamplainpools.example --pin 246810
npm run user -w @lcp/db -- pin --email jtech@lakechamplainpools.example --pin 135791
npm run dev -w @lcp/web   # freshly started — the file's own header explains why
npx tsx apps/web/scripts/smoke-tech-api.ts
```

Expected: all pre-existing checks PASS. Among the new ones, these FAIL:
`a technician with no job … 404` (Jess currently gets 200),
`…confirms nothing`, and `cached briefly` (currently `immutable`). The
upload, Mike-read, and office checks already PASS.

- [ ] **Step 3: Extract the window predicate**

Create `apps/web/lib/assignment.ts`:

```ts
import { sql } from 'drizzle-orm';

/**
 * The ADR 0009 window: the work orders that make a technician "on this job
 * right now" for scoping decisions. Assigned to them, not cancelled, dated
 * between two days back and one day forward — backward-leaning because the
 * revisit that strands somebody carries Monday's date on Thursday — or
 * undated but touched in the last two days, because same-day emergencies are
 * assigned before they are dated and one job parked in March must not stay
 * an open-ended key.
 *
 * Shared by /api/gate-code (the decision this was written for, see the ADR)
 * and the photo GET in /api/tech/photo, so the two checks cannot drift.
 * Composes as a condition on an aliased `work_order w`.
 *
 * CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York', never CURRENT_DATE —
 * the server clock is GMT and CURRENT_DATE rolls over here in the evening.
 */
export function assignedInWindow(userId: string) {
  return sql`
    w.assigned_user_id = ${userId}::uuid
    AND w.status <> 'cancelled'
    AND (
      (w.scheduled_date IS NULL AND w.updated_at > now() - interval '2 days')
      OR w.scheduled_date BETWEEN
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date - 2
       AND (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date + 1
    )`;
}
```

In `apps/web/app/api/gate-code/route.ts`, add
`import { assignedInWindow } from '@/lib/assignment';` and replace the body
of the `assigned` query (lines 82-94) with:

```ts
    const assigned = rows(await db.execute(sql`
      SELECT 1
      FROM work_order w
      WHERE w.property_id = ${propertyId}::uuid
        AND ${assignedInWindow(user.userId)}
      LIMIT 1`));
```

The two comment paragraphs above it that explain the window and the
CURRENT_TIMESTAMP rule (lines 66-81) move with the logic — they now live on
the helper; leave behind the paragraphs about field-vs-office, the office
staying unscoped, and pre-lookup placement, which are about this route.

- [ ] **Step 4: Scope the photo GET**

In `apps/web/app/api/tech/photo/route.ts`, add
`import { assignedInWindow } from '@/lib/assignment';` and replace the GET's
lookup and response (lines 131-144) with:

```ts
  // Field scope, office trust — the same split as /api/gate-code, enforced
  // with the same window (ADR 0009 via assignedInWindow). Folded into the
  // SELECT so an out-of-scope photo and a nonexistent id return the exact
  // same 404: a 403 here would confirm the attachment exists, and walking
  // ids must confirm nothing. The property arm covers history photos on a
  // house the technician is working today; the work-order arm covers a
  // photo on their own job at a property-less work order.
  const scope = user.role === 'tech'
    ? sql` AND EXISTS (
          SELECT 1 FROM work_order w
           WHERE (w.property_id = a.property_id OR w.id = a.work_order_id)
             AND ${assignedInWindow(user.userId)})`
    : sql``;

  const row = rows(await db.execute(sql`
    SELECT a.storage_key, a.mime_type FROM attachment a
     WHERE a.id = ${id}::uuid${scope}`))[0];
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await getObject(row.storage_key);
  if (!body) return NextResponse.json({ error: 'missing from storage' }, { status: 404 });

  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': row.mime_type ?? 'image/jpeg',
      // The bytes behind an id never change, but a technician's RIGHT to
      // them does — it ends with the assignment. An hour bounds how long a
      // browser cache outlives that (the same failure ADR 0009 records for
      // codes cached on a device). Office access does not expire, so the
      // office keeps the immutable year.
      'Cache-Control': user.role === 'tech'
        ? 'private, max-age=3600'
        : 'private, max-age=31536000, immutable',
    },
  });
```

- [ ] **Step 5: Restart the dev server, re-run the suite**

```bash
# stop the dev server, then:
npm run dev -w @lcp/web
npx tsx apps/web/scripts/smoke-tech-api.ts
```

Expected: every check PASS — the new photo section **and** the pre-existing
gate-code checks, which are the regression proof for the Step 3 refactor.
Then stop the dev server and run `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/assignment.ts apps/web/app/api/tech/photo/route.ts \
  apps/web/app/api/gate-code/route.ts apps/web/scripts/smoke-tech-api.ts
git commit -m "A photo is scoped like the gate on the same house"
```

---

### Task 5: The documents stop lying

**Files:**
- Modify: `DEMO.md` (four spots)
- Test: `grep` assertions below; no code.

The gap analysis in `DEMO.md` predates two discoveries: the
`incomplete_reason` phone write path already shipped (TechApp's "why" prompt →
`/api/tech/sync`), and Phase 3 inventory has begun in code
(`packages/db/src/schema/inventory.ts`, migrations 0011-0012, item search)
without any SESSIONS.md entry. This plan's own work closes two more rows.

- [ ] **Step 1: Correct the service table**

In `DEMO.md`, Service & dispatch table: replace the row

```
| Capacity limits (block overbooked days) | not started | Phase 2 roadmap |
```

with

```
| Capacity limits (block overbooked days) | working | Per-person daily minutes budget (default 480) enforced in the write layer; the office may book anyway, and the timeline records the arithmetic |
```

- [ ] **Step 2: Correct the photo rows and the security-limits paragraph**

Replace the property-profiles table row

```
| Photos in cloud storage, signed URLs | designed | R2 with presigned uploads is decided (ADR 0007); today photos are served locally, session-gated but not job-scoped |
```

with

```
| Photos in cloud storage, signed URLs | designed | R2 with presigned uploads is decided (ADR 0007); today photos are served locally, session-gated and job-scoped for field roles |
```

In the "Known security limits" paragraph, delete the clause
`the photo GET is session-gated but not job-scoped and cached ` + backtick +
`immutable` + backtick + `;` — the remaining limits (free text, device-cached
codes until day refresh, unlogged refusals) still stand.

- [ ] **Step 3: Correct inventory and "Next up"**

Replace the Inventory & purchasing section's opening sentence

```
Everything in this section — barcode-first inventory, real-time stock, bulk
edits, reorder suggestions, seasonal forecasting, internal product notes,
large-item visibility, multi-vendor purchasing — is **not started**.
```

with

```
Phase 3 has **begun in code**: an item master with barcodes and fuzzy counter
search, and a sales-channel seam (`packages/db/src/schema/inventory.ts`,
migrations 0011-0012) — so far unrecorded in `SESSIONS.md`. Reorder
suggestions, seasonal forecasting, purchasing, and the rest of this section
are **not started**.
```

and in the non-negotiables table change
`| Strong inventory management | not started (Phase 3) |` to
`| Strong inventory management | begun in code (Phase 3) |`.

In "Next up", delete the two closed items (`a phone write path for
incomplete_reason…` and the capacity work this plan finishes) and leave:
resolve 0004 vs 0006; generate and seal the KMS key, rotation written first.

- [ ] **Step 4: Verify and commit**

Run: `grep -n "not job-scoped\|Phase 2 roadmap\|is \*\*not started\*\*" DEMO.md`
Expected: no hits for the first two; the remaining `not started` phrasing
appears only where it is still true (sales/POS, AI).

```bash
git add DEMO.md
git commit -m "DEMO.md catches up with the code it describes"
```

---

### Task 6: The review gate, then the push

Per `CLAUDE.md` this is not optional and the hook enforces it.

- [ ] **Step 1: Run `repo-reviewer`** over this plan's commits only
  (`git diff df51658..HEAD` — df51658 was HEAD when the plan was written; the
  five Phase 3 commits behind it are already pushed and are not this review's
  scope). Expect it to probe: the 0013
  journal/file pair, `(r?.rows ?? r)` discipline in new SQL, the
  smoke-writes date isolation, and stale comments.
- [ ] **Step 2: Run `sensitive-data-guard`** — Task 4 touches the photo path
  and the gate-code route, which is squarely ADR 0003. Expect it to check:
  the 404-not-403 shape, that no gate code or photo key reaches a log line,
  and the cache-header reasoning.
- [ ] **Step 3: Fix or consciously accept every finding**, re-running the
  affected suite after each fix. If anything was committed as a fix, the
  marker is stale — that is the design.
- [ ] **Step 4: Mark and push**

```bash
node ~/.claude/hooks/mark-reviewed.mjs repo-reviewer sensitive-data-guard
git push
```

- [ ] **Step 5: Close the session** — run `session-scribe` in CLOSE mode so
  `STATE.md` is rewritten against reality (it currently describes `f223373`)
  and `SESSIONS.md` finally records both this work **and** the unlogged
  Phase 3 commits (`d73025b`…`df51658`).

---

## Not doing, and why

- **Parts gating before scheduling** (CORE.md) — needs the inventory model's
  stock levels; belongs to the Phase 3 plan.
- **Route optimization, live GPS** — designed away in ADR 0004; breadcrumbs
  stand.
- **A UI to edit a person's `daily_capacity_minutes`** — `npm run db:studio`
  serves the demo; a settings screen is YAGNI until a second field team
  exists.
- **Recording 403s in the database** — ADR 0009 decided refusals stay out of
  the reveal log; changing that wants its own table and its own ADR.
- **The `updated_at` self-extension of the reveal window** (ADR 0010's open
  item) — real, subtle, and orthogonal; it deserves its own focused change
  rather than a rider on this one.
