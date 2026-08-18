/**
 * Data quality report.
 *
 * This is the artefact you actually read after an import. It is not a log - it
 * is a worklist. Every line is either "the mapping is wrong, fix the mapping"
 * or "the data has always been wrong, decide whether to clean it".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { createDb } from '@lcp/db';
import { config } from './config.js';

export async function report(opts: { write?: boolean } = {}) {
  const { db, close } = await createDb();
  const rows = (r: any) => (r.rows ?? r) as any[];

  const batches = rows(await db.execute(dsql`
    SELECT mode, entity, status, started_at, finished_at,
           rows_read, rows_written, rows_skipped, issue_count, error
    FROM import_batch ORDER BY started_at DESC LIMIT 20`));

  const counts = rows(await db.execute(dsql`
    SELECT
      (SELECT count(*) FROM customer)                              AS customers,
      (SELECT count(*) FROM customer WHERE status = 'active')      AS active_customers,
      (SELECT count(*) FROM contact)                               AS contacts,
      (SELECT count(*) FROM property)                              AS properties,
      (SELECT count(*) FROM address)                               AS addresses,
      (SELECT count(*) FROM timeline_event)                        AS timeline_events,
      (SELECT count(*) FROM legacy_row)                            AS staged_rows`))[0];

  const issues = rows(await db.execute(dsql`
    SELECT severity, code, count(*)::int AS n,
           (array_agg(message ORDER BY id))[1] AS example
    FROM import_issue
    GROUP BY severity, code
    ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, n DESC`));

  // Completeness of the fields that decide whether search and dispatch work.
  const completeness = rows(await db.execute(dsql`
    SELECT
      count(*)::int                                                          AS total,
      count(*) FILTER (WHERE primary_phone IS NOT NULL)::int                 AS with_phone,
      count(*) FILTER (WHERE primary_email IS NOT NULL)::int                 AS with_email,
      count(*) FILTER (WHERE billing_address_id IS NOT NULL)::int            AS with_address,
      count(*) FILTER (WHERE first_name IS NULL AND last_name IS NULL
                         AND company_name IS NULL)::int                      AS nameless
    FROM customer`))[0];

  // Likely duplicates: same normalized phone, or same surname at the same ZIP.
  const dupePhones = rows(await db.execute(dsql`
    SELECT primary_phone, count(*)::int AS n
    FROM customer WHERE primary_phone IS NOT NULL
    GROUP BY primary_phone HAVING count(*) > 1
    ORDER BY n DESC LIMIT 25`));

  const timelineSpan = rows(await db.execute(dsql`
    SELECT min(occurred_at) AS earliest, max(occurred_at) AS latest,
           count(DISTINCT customer_id)::int AS customers_with_history
    FROM timeline_event`))[0];

  const lines: string[] = [];
  const p = (s = '') => lines.push(s);

  p('# Import report');
  p();
  p(`Generated ${new Date().toISOString()}`);
  p();

  p('## What landed');
  p();
  p('| Table | Rows |');
  p('|---|---:|');
  for (const [k, v] of Object.entries(counts)) {
    p(`| ${k.replace(/_/g, ' ')} | ${Number(v).toLocaleString()} |`);
  }
  p();

  if (timelineSpan?.earliest) {
    p(`Timeline spans **${String(timelineSpan.earliest).slice(0, 10)} to ${String(timelineSpan.latest).slice(0, 10)}**, ` +
      `covering ${Number(timelineSpan.customers_with_history).toLocaleString()} customers.`);
    p();
  }

  p('## Field completeness');
  p();
  const pct = (n: number) => completeness.total ? `${Math.round((n / completeness.total) * 100)}%` : '—';
  p('| Field | Populated | Share |');
  p('|---|---:|---:|');
  p(`| phone | ${Number(completeness.with_phone).toLocaleString()} | ${pct(completeness.with_phone)} |`);
  p(`| email | ${Number(completeness.with_email).toLocaleString()} | ${pct(completeness.with_email)} |`);
  p(`| billing address | ${Number(completeness.with_address).toLocaleString()} | ${pct(completeness.with_address)} |`);
  p();
  if (Number(completeness.nameless) > 0) {
    p(`> ${Number(completeness.nameless).toLocaleString()} customers have no name at all. They are searchable by account number only.`);
    p();
  }

  p('## Issues');
  p();
  if (issues.length === 0) {
    p('None recorded.');
  } else {
    p('| Severity | Code | Count | Example |');
    p('|---|---|---:|---|');
    for (const i of issues) {
      p(`| ${i.severity} | \`${i.code}\` | ${Number(i.n).toLocaleString()} | ${String(i.example).replace(/\|/g, '\\|').slice(0, 90)} |`);
    }
  }
  p();

  if (dupePhones.length) {
    p('## Probable duplicate customers');
    p();
    p('Same phone number on more than one account. Twenty years of counter staff');
    p('creating a new record instead of finding the old one. Review before cutover.');
    p();
    p('| Phone | Accounts |');
    p('|---|---:|');
    for (const d of dupePhones) p(`| ${d.primary_phone} | ${d.n} |`);
    p();
  }

  p('## Recent batches');
  p();
  p('| Started | Mode | Entity | Status | Read | Written | Skipped | Issues |');
  p('|---|---|---|---|---:|---:|---:|---:|');
  for (const b of batches) {
    p(`| ${String(b.started_at).slice(0, 19).replace('T', ' ')} | ${b.mode} | ${b.entity ?? '—'} | ` +
      `${b.status}${b.error ? ' ⚠️' : ''} | ${Number(b.rows_read).toLocaleString()} | ` +
      `${Number(b.rows_written).toLocaleString()} | ${Number(b.rows_skipped).toLocaleString()} | ${b.issue_count} |`);
  }
  p();

  p('## What to do with this');
  p();
  p('1. **`error` rows block a clean cutover.** Orphans and missing customer links');
  p('   usually mean the mapping key is wrong, not that the data is bad.');
  p('2. **`UNMAPPED_KIND` is a one-line fix** in `mappings/evosus.ts` - add the type');
  p('   to `historyKindMap` and re-run the transform.');
  p('3. **Duplicate phones are a business decision**, not a technical one. Merge them');
  p('   in the app after go-live; the merge is reversible.');
  p('4. Re-running the transform is free and idempotent. Fix, re-run, re-read.');

  const text = lines.join('\n');
  console.log(text);

  if (opts.write !== false) {
    const outDir = join(config.dataDir, 'reports');
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `import-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
    await writeFile(file, text, 'utf8');
    console.log(`\n[report] written to ${file}`);
  }

  await close();
  return text;
}
