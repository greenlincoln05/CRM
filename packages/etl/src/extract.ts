/**
 * Extraction: legacy system -> staging.legacy_row, verbatim.
 *
 * Two paths, because the biggest risk in this whole project is not being able
 * to get the data out:
 *
 *   mssql : direct read-only pull from the on-prem server. Best case.
 *   csv   : the fallback if the vendor will only produce exports. Same landing
 *           zone, same downstream transforms, so nothing after this point cares
 *           which one you used.
 *
 * Nothing is interpreted here. Rows land as JSONB exactly as they came out.
 * Interpretation happens in transform, which can be re-run as many times as it
 * takes to get the mapping right - without touching the source system again.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import sql from 'mssql';
import { sql as dsql } from 'drizzle-orm';
import { createDb } from '@lcp/db';
import { config, assertLegacyConfigured } from './config.js';
import { protectRow } from './sensitive.js';
import { initFieldKey } from '@lcp/db';

function hashRow(payload: unknown): string {
  return createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/** SQL Server returns Dates and Buffers; JSONB needs plain values. */
function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

async function openBatch(db: any, opts: { entity: string; mode: string; notes?: string }) {
  const r = await db.execute(dsql`
    INSERT INTO import_batch (source, mode, entity, status, notes)
    VALUES (${config.legacy.source}, ${opts.mode}, ${opts.entity}, 'running', ${opts.notes ?? null})
    RETURNING id
  `);
  return ((r as any).rows ?? r)[0].id as string;
}

async function closeBatch(
  db: any,
  batchId: string,
  stats: { read: number; written: number; skipped: number; watermark?: string | null; error?: string },
) {
  await db.execute(dsql`
    UPDATE import_batch SET
      status       = ${stats.error ? 'failed' : 'succeeded'},
      finished_at  = now(),
      rows_read    = ${stats.read},
      rows_written = ${stats.written},
      rows_skipped = ${stats.skipped},
      watermark    = ${stats.watermark ?? null},
      error        = ${stats.error ?? null}
    WHERE id = ${batchId}
  `);
}

/** Insert a chunk of raw rows. Conflict = already seen this row in this batch. */
async function landRows(
  db: any,
  batchId: string,
  entity: string,
  rows: Array<{ legacyId: string; payload: Record<string, unknown> }>,
): Promise<number> {
  if (rows.length === 0) return 0;

  // Gate codes are encrypted before they touch the staging table (ADR 0005).
  // The hash is taken over the protected payload so incremental runs stay
  // stable — hashing the cleartext would make every row look changed.
  const values = rows.map((r) => {
    const payload = protectRow(r.payload);
    return dsql`(${batchId}::uuid, ${config.legacy.source}, ${entity}, ${r.legacyId},
          ${JSON.stringify(payload)}::jsonb, ${hashRow(payload)})`;
  });

  await db.execute(dsql`
    INSERT INTO legacy_row (batch_id, source, entity, legacy_id, payload, row_hash)
    VALUES ${dsql.join(values, dsql`, `)}
    ON CONFLICT (batch_id, source, entity, legacy_id) DO NOTHING
  `);
  return rows.length;
}

// ── SQL Server path ────────────────────────────────────────────────────────

export async function extractMssql(opts: {
  entity: string;
  table: string;
  keyColumn: string;
  /** Optional column for incremental pulls (a modified-date). */
  watermarkColumn?: string;
  since?: string;
  limit?: number;
}) {
  await initFieldKey(); // landing encrypts gate codes
  assertLegacyConfigured();
  const { db, close } = await createDb();
  const batchId = await openBatch(db, {
    entity: opts.entity,
    mode: 'extract',
    notes: `mssql ${opts.table}`,
  });

  let read = 0, written = 0, maxWatermark: string | null = null;

  try {
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
      requestTimeout: 600_000,
    });

    const where = opts.watermarkColumn && opts.since
      ? `WHERE [${opts.watermarkColumn}] > @since`
      : '';
    const top = opts.limit ? `TOP ${opts.limit}` : '';

    const request = pool.request();
    if (opts.watermarkColumn && opts.since) request.input('since', sql.DateTime2, new Date(opts.since));
    request.stream = true;

    let buffer: Array<{ legacyId: string; payload: Record<string, unknown> }> = [];

    await new Promise<void>((resolve, reject) => {
      const pending: Promise<unknown>[] = [];

      request.on('row', (row: Record<string, unknown>) => {
        read++;
        const payload = normalizeRow(row);
        const legacyId = String(payload[opts.keyColumn] ?? '');
        if (!legacyId) return; // keyless row: caught by the report, not silently dropped
        if (opts.watermarkColumn) {
          const w = payload[opts.watermarkColumn];
          if (typeof w === 'string' && (!maxWatermark || w > maxWatermark)) maxWatermark = w;
        }
        buffer.push({ legacyId, payload });

        if (buffer.length >= config.batchSize) {
          const chunk = buffer;
          buffer = [];
          request.pause();
          pending.push(
            landRows(db, batchId, opts.entity, chunk)
              .then((n) => {
                written += n;
                process.stdout.write(`\r[extract] ${opts.entity}: ${written.toLocaleString()} rows`);
                request.resume();
              })
              .catch(reject),
          );
        }
      });

      request.on('error', reject);
      request.on('done', () => {
        Promise.all(pending)
          .then(() => landRows(db, batchId, opts.entity, buffer))
          .then((n) => { written += n; resolve(); })
          .catch(reject);
      });

      request.query(`SELECT ${top} * FROM ${opts.table} ${where}`);
    });

    await pool.close();
    await closeBatch(db, batchId, { read, written, skipped: read - written, watermark: maxWatermark });
    console.log(`\n[extract] ${opts.entity}: read ${read.toLocaleString()}, landed ${written.toLocaleString()}, batch ${batchId}`);
  } catch (err: any) {
    await closeBatch(db, batchId, { read, written, skipped: 0, error: String(err?.message ?? err) });
    throw err;
  } finally {
    await close();
  }

  return { batchId, read, written };
}

// ── CSV path ───────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180 parser. Deliberately dependency-free: an export from a
 * twenty-year-old system will have quoted commas, embedded newlines in note
 * fields, and a BOM, and this handles all three.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // handled by the \n case
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header) return [];

  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => { o[h.trim()] = r[i] ?? ''; });
      return o;
    });
}

export async function extractCsv(opts: { entity: string; file: string; keyColumn: string }) {
  await initFieldKey(); // landing encrypts gate codes
  const { db, close } = await createDb();
  const batchId = await openBatch(db, {
    entity: opts.entity,
    mode: 'extract',
    notes: `csv ${basename(opts.file)}`,
  });

  let read = 0, written = 0, skipped = 0;

  try {
    const text = await readFile(opts.file, 'utf8');
    const parsed = parseCsv(text);
    read = parsed.length;

    let buffer: Array<{ legacyId: string; payload: Record<string, unknown> }> = [];
    for (const rec of parsed) {
      const legacyId = String(rec[opts.keyColumn] ?? '').trim();
      if (!legacyId) { skipped++; continue; }
      buffer.push({ legacyId, payload: rec });
      if (buffer.length >= config.batchSize) {
        written += await landRows(db, batchId, opts.entity, buffer);
        buffer = [];
        process.stdout.write(`\r[extract] ${opts.entity}: ${written.toLocaleString()} rows`);
      }
    }
    written += await landRows(db, batchId, opts.entity, buffer);

    await closeBatch(db, batchId, { read, written, skipped });
    console.log(`\n[extract] ${opts.entity}: read ${read.toLocaleString()}, landed ${written.toLocaleString()}, skipped ${skipped}, batch ${batchId}`);
  } catch (err: any) {
    await closeBatch(db, batchId, { read, written, skipped, error: String(err?.message ?? err) });
    throw err;
  } finally {
    await close();
  }

  return { batchId, read, written };
}

/** Pull every .csv in a directory, using the filename as the entity name. */
export async function extractCsvDir(dir: string, keyColumn: string) {
  const files = (await readdir(dir)).filter((f) => extname(f).toLowerCase() === '.csv');
  const results = [];
  for (const f of files) {
    results.push(await extractCsv({
      entity: basename(f, extname(f)).toLowerCase(),
      file: join(dir, f),
      keyColumn,
    }));
  }
  return results;
}
