/**
 * Walks every destination in lib/nav.ts against a running dev server and
 * asserts each one answers 200 with its own content — a broken placeholder
 * route or a nav entry with no page cannot hide.
 *
 * Needs a FRESHLY started dev server (same PGlite page-cache reasoning as
 * smoke-tech-api.ts — sessions minted below must be visible to it):
 *   PGLITE_DIR=$REPO/.pgdata2 npm run dev -w @lcp/web
 *   npx tsx apps/web/scripts/smoke-nav.ts
 */
import { sql } from 'drizzle-orm';
import { createDb, loadRepoEnv, signIn, createUser, setPin, SESSION_COOKIE } from '@lcp/db';
import { NAV } from '../lib/nav.js';

loadRepoEnv();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3100';

{
  const host = (() => { try { return new URL(BASE).hostname; } catch { return ''; } })();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local || process.env.DATABASE_URL) {
    console.error('Refusing to run outside the local demo database.');
    process.exit(1);
  }
}

const rows = (r: any) => (r?.rows ?? r) as any[];
let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

const NAV_EMAIL = 'nav-smoke@lakechamplainpools.example';
const NAV_PIN = '918273';

const cookie = await (async () => {
  const { db, close } = await createDb();
  try {
    const existing = rows(await db.execute(sql`
      SELECT id FROM app_user WHERE lower(email) = ${NAV_EMAIL}`))[0];
    const id: string = existing?.id
      ?? (await createUser(db, { email: NAV_EMAIL, displayName: 'Nav smoke fixture', pin: NAV_PIN })).id;
    await setPin(db, id, NAV_PIN);
    await db.execute(sql`UPDATE app_user SET active = true WHERE id = ${id}::uuid`);
    const r = await signIn(db, { email: NAV_EMAIL, pin: NAV_PIN });
    if (!r.ok) throw new Error(`sign-in failed: ${r.error}`);
    return `${SESSION_COOKIE}=${r.token}`;
  } finally {
    await close();
  }
})();

const targets: { href: string; probe: string }[] = [];
for (const s of NAV) {
  if (!s.subsections?.length) targets.push({ href: s.href, probe: s.probe ?? s.label });
  for (const sub of s.subsections ?? []) {
    targets.push({ href: sub.href, probe: sub.probe ?? sub.label });
  }
}

for (const t of targets) {
  const res = await fetch(`${BASE}${t.href}`, { headers: { cookie }, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  check(`${t.href} answers 200 and shows "${t.probe}"`,
    res.status === 200 && html.includes(t.probe),
    `status ${res.status}`);
  if (res.status === 200) {
    check(`${t.href} renders inside the shell`, html.includes('o-rail'));
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL NAV CHECKS PASSED');
process.exit(failures ? 1 : 0);
