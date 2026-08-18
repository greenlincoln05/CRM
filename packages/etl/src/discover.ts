/**
 * Schema discovery - the Sprint 0 spike, as a repeatable tool.
 *
 * Nobody has the Evosus schema documented, and twenty years of a vendor
 * product means hundreds of tables of which maybe fifteen matter. This
 * connects read-only, profiles what is actually there, and writes a report you
 * can read at the kitchen table to decide what to migrate.
 *
 * It answers, per table: how many rows, which columns, how often each column is
 * empty, and what the values look like. Column emptiness is the important one -
 * a field that is 94% null across 20 years is a field the business does not
 * actually use, and migrating it is wasted work.
 *
 * OUTPUT CONTAINS CUSTOMER DATA. It lands in ./data (gitignored). Do not put it
 * on a shared drive or paste it into a chat window.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sql from 'mssql';
import { config, assertLegacyConfigured } from './config.js';

type ColumnProfile = {
  column: string;
  dataType: string;
  maxLength: number | null;
  nullable: boolean;
  nullPct: number | null;
  distinctCount: number | null;
  samples: string[];
};

type TableProfile = {
  schema: string;
  table: string;
  rowCount: number;
  columns: ColumnProfile[];
};

/** Tables worth profiling deeply. Everything else just gets a row count. */
const INTEREST = [
  'customer', 'client', 'contact', 'address', 'site', 'location',
  'invoice', 'order', 'sale', 'transaction', 'payment', 'ticket',
  'item', 'inventory', 'product', 'sku', 'stock',
  'service', 'workorder', 'work_order', 'job', 'dispatch', 'schedule',
  'equipment', 'serial', 'vendor', 'purchase', 'po',
  'note', 'comment', 'history', 'log',
];

function looksInteresting(table: string): boolean {
  const t = table.toLowerCase();
  return INTEREST.some((k) => t.includes(k));
}

export async function discover(opts: { deep?: boolean; sampleSize?: number } = {}) {
  assertLegacyConfigured();
  const sampleSize = opts.sampleSize ?? 5;

  const pool = await sql.connect({
    server: config.legacy.host,
    port: config.legacy.port,
    database: config.legacy.database,
    user: config.legacy.user,
    password: config.legacy.password,
    options: {
      encrypt: config.legacy.encrypt,
      trustServerCertificate: config.legacy.trustServerCertificate,
      readOnlyIntent: true,
    },
    requestTimeout: 120_000,
  });

  console.log(`[discover] connected to ${config.legacy.database} on ${config.legacy.host}`);

  // Row counts from system views: instant, even on tables with millions of rows.
  const counts = await pool.request().query<{
    schema_name: string; table_name: string; row_count: number;
  }>(`
    SELECT s.name AS schema_name, t.name AS table_name,
           SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS row_count
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.partitions p ON p.object_id = t.object_id
    GROUP BY s.name, t.name
    ORDER BY row_count DESC
  `);

  const tables = counts.recordset;
  console.log(`[discover] ${tables.length} tables, ${tables.reduce((a, t) => a + Number(t.row_count), 0).toLocaleString()} rows total`);

  const profiles: TableProfile[] = [];

  for (const t of tables) {
    const interesting = looksInteresting(t.table_name);
    if (!interesting && !opts.deep) continue;
    if (Number(t.row_count) === 0) continue;

    const cols = await pool.request()
      .input('s', sql.NVarChar, t.schema_name)
      .input('t', sql.NVarChar, t.table_name)
      .query<{ COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null; IS_NULLABLE: string }>(`
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION
      `);

    const columns: ColumnProfile[] = [];
    const rowCount = Number(t.row_count);

    for (const c of cols.recordset) {
      const q = `[${t.schema_name}].[${t.table_name}]`;
      const col = `[${c.COLUMN_NAME}]`;
      let nullPct: number | null = null;
      let distinctCount: number | null = null;
      let samples: string[] = [];

      try {
        // TABLESAMPLE keeps this cheap on multi-million-row tables.
        const stat = await pool.request().query<{ nulls: number; total: number; distinct_count: number }>(`
          SELECT
            SUM(CASE WHEN ${col} IS NULL OR LTRIM(RTRIM(CAST(${col} AS NVARCHAR(MAX)))) = '' THEN 1 ELSE 0 END) AS nulls,
            COUNT(*) AS total,
            COUNT(DISTINCT CAST(${col} AS NVARCHAR(400))) AS distinct_count
          FROM (SELECT TOP 20000 ${col} FROM ${q}) x
        `);
        const s = stat.recordset[0];
        if (s && s.total > 0) {
          nullPct = Math.round((s.nulls / s.total) * 1000) / 10;
          distinctCount = s.distinct_count;
        }

        const sam = await pool.request().query(`
          SELECT DISTINCT TOP ${sampleSize} CAST(${col} AS NVARCHAR(200)) AS v
          FROM ${q}
          WHERE ${col} IS NOT NULL AND LTRIM(RTRIM(CAST(${col} AS NVARCHAR(MAX)))) <> ''
        `);
        samples = sam.recordset.map((r: any) => String(r.v)).slice(0, sampleSize);
      } catch (err: any) {
        // Geography, image, and other exotic types will not cast. Not fatal.
        samples = [`<unprofilable: ${err.message?.slice(0, 60)}>`];
      }

      columns.push({
        column: c.COLUMN_NAME,
        dataType: c.DATA_TYPE,
        maxLength: c.CHARACTER_MAXIMUM_LENGTH,
        nullable: c.IS_NULLABLE === 'YES',
        nullPct,
        distinctCount,
        samples,
      });
    }

    profiles.push({ schema: t.schema_name, table: t.table_name, rowCount, columns });
    console.log(`[discover]   profiled ${t.schema_name}.${t.table_name} (${rowCount.toLocaleString()} rows, ${columns.length} cols)`);
  }

  await pool.close();

  const outDir = join(config.dataDir, 'discovery');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);

  await writeFile(
    join(outDir, `schema-${stamp}.json`),
    JSON.stringify({ allTables: tables, profiles }, null, 2),
    'utf8',
  );
  await writeFile(join(outDir, `schema-${stamp}.md`), renderMarkdown(tables, profiles), 'utf8');

  console.log(`\n[discover] wrote ${outDir}/schema-${stamp}.md`);
  console.log('[discover] CONTAINS CUSTOMER DATA - keep it local.');
  return { tables, profiles };
}

function renderMarkdown(
  all: Array<{ schema_name: string; table_name: string; row_count: number }>,
  profiles: TableProfile[],
): string {
  const lines: string[] = [];
  lines.push('# Evosus schema discovery', '');
  lines.push(`Generated ${new Date().toISOString()}`, '');
  lines.push('> Contains real customer data. Keep local.', '');

  lines.push('## Biggest tables', '');
  lines.push('| Table | Rows |', '|---|---:|');
  for (const t of all.slice(0, 40)) {
    lines.push(`| ${t.schema_name}.${t.table_name} | ${Number(t.row_count).toLocaleString()} |`);
  }
  lines.push('');

  lines.push('## Profiled tables', '');
  for (const p of profiles) {
    lines.push(`### ${p.schema}.${p.table} — ${p.rowCount.toLocaleString()} rows`, '');
    lines.push('| Column | Type | Empty % | Distinct | Samples |', '|---|---|---:|---:|---|');
    for (const c of p.columns) {
      const flag = c.nullPct !== null && c.nullPct > 90 ? ' ⚠️' : '';
      const samples = c.samples.map((s) => s.replace(/\|/g, '\\|').slice(0, 40)).join(' · ');
      lines.push(
        `| ${c.column}${flag} | ${c.dataType}${c.maxLength ? `(${c.maxLength})` : ''} | ` +
        `${c.nullPct ?? '—'} | ${c.distinctCount ?? '—'} | ${samples} |`,
      );
    }
    lines.push('');
  }

  lines.push('## How to read this', '');
  lines.push('- ⚠️ marks columns empty more than 90% of the time. Those are almost');
  lines.push('  always dead fields the business stopped using. Do not migrate them');
  lines.push('  without asking who still relies on them.');
  lines.push('- Distinct counts near the row count mean a natural key candidate.');
  lines.push('- Distinct counts under ~20 mean an enum worth mapping explicitly.');
  return lines.join('\n');
}
