import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { buildKey, putObject, getObject, sniffImage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** 15MB. Compressed shots land near 300KB; this only catches something wrong. */
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Receive one photo from the field.
 *
 * The doc says technicians rarely capture equipment photos "because the process
 * is cumbersome". So this asks for nothing: no filename, no category, no form.
 * The device sends the bytes and what it already knows — which job, which
 * property, when, and where — and everything else is derived.
 *
 * Idempotent on clientActionId, because the upload will be retried.
 *
 * Photographs of customers' backyards, equipment and access points are exactly
 * as sensitive as the rest of the property profile, so this is behind a session
 * and behind the same assignment check as everything else on a job.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to upload photos.' }, { status: 401 });
  }

  const { db } = await getDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart form data' }, { status: 400 });
  }

  const clientActionId = String(form.get('clientActionId') ?? '');
  const workOrderId = String(form.get('workOrderId') ?? '');
  const file = form.get('file');

  if (!clientActionId || !workOrderId || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'clientActionId, workOrderId and file are required' },
      { status: 400 },
    );
  }

  // Already stored: the previous attempt succeeded and the response was lost.
  const existing = rows(await db.execute(sql`
    SELECT id FROM attachment WHERE client_action_id = ${clientActionId}::uuid`));
  if (existing.length) {
    return NextResponse.json({ ok: true, duplicate: true, id: existing[0].id });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large' }, { status: 400 });
  }

  // Trust the bytes, not the declared type.
  const ext = sniffImage(bytes);
  if (!ext) {
    return NextResponse.json({ error: 'not a recognized image' }, { status: 400 });
  }

  const job = rows(await db.execute(sql`
    SELECT customer_id, property_id, assigned_user_id FROM work_order WHERE id = ${workOrderId}::uuid`))[0];
  if (!job) {
    return NextResponse.json({ error: 'unknown work order' }, { status: 400 });
  }

  const supervisor = user.role === 'admin' || user.role === 'manager';
  if (!supervisor && job.assigned_user_id !== user.userId) {
    return NextResponse.json({ error: 'That job is not assigned to you.' }, { status: 403 });
  }

  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const key = buildKey(clientActionId, ext);
  await putObject(key, bytes);

  const capturedAt = String(form.get('capturedAt') ?? '') || new Date().toISOString();
  const lat = form.get('lat');
  const lng = form.get('lng');
  const caption = form.get('caption');

  const inserted = rows(await db.execute(sql`
    INSERT INTO attachment (customer_id, property_id, work_order_id, client_action_id,
                            kind, storage_key, mime_type, byte_size, content_hash,
                            captured_at, captured_lat, captured_lng, captured_by_user_id,
                            caption, uploaded, tags)
    VALUES (${job.customer_id}::uuid, ${job.property_id ?? null}::uuid, ${workOrderId}::uuid,
            ${clientActionId}::uuid, 'photo', ${key}, ${`image/${ext === 'jpg' ? 'jpeg' : ext}`},
            ${bytes.length}, ${contentHash},
            ${new Date(capturedAt).toISOString()}::timestamptz,
            ${lat ? String(lat) : null}, ${lng ? String(lng) : null},
            ${user.userId}::uuid,
            ${caption ? String(caption) : null}, true, '["field"]'::jsonb)
    ON CONFLICT (client_action_id) WHERE client_action_id IS NOT NULL DO NOTHING
    RETURNING id`));

  return NextResponse.json({ ok: true, id: inserted[0]?.id ?? null, key });
}

/**
 * Serve a stored photo.
 *
 * Keyed by attachment id, so the storage key is never exposed and cannot be
 * guessed or enumerated from the outside.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to view photos.' }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { db } = await getDb();
  const rows = (r: any) => (r?.rows ?? r) as any[];

  const row = rows(await db.execute(sql`
    SELECT storage_key, mime_type FROM attachment WHERE id = ${id}::uuid`))[0];
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await getObject(row.storage_key);
  if (!body) return NextResponse.json({ error: 'missing from storage' }, { status: 404 });

  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': row.mime_type ?? 'image/jpeg',
      // Immutable: an attachment id always points at the same bytes.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
