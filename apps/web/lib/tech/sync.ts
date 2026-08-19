/**
 * The offline queue.
 *
 * Everything a technician does is written locally first and applied to the UI
 * immediately, then replayed to the server when there is signal. A tech should
 * never wait on a network they do not have, and should never be told an action
 * "failed" because they were standing behind a boathouse.
 *
 * Every action carries a client-generated id, and the server records which ids
 * it has applied. That is what makes replay safe: networks fail after the
 * server commits but before the response arrives, the device retries, and the
 * second attempt lands once.
 */
import {
  getOutbox, dequeue, updateAction, getPhoto, delPhoto,
  type OutboxAction,
} from './store';

export type SyncResult = {
  sent: number;
  failed: number;
  remaining: number;
  /** Set when the server refused for lack of a session. */
  authRequired?: boolean;
};

let syncing = false;

export async function syncNow(): Promise<SyncResult> {
  if (syncing) return { sent: 0, failed: 0, remaining: (await getOutbox()).length };
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { sent: 0, failed: 0, remaining: (await getOutbox()).length };
  }

  syncing = true;
  let sent = 0;
  let failed = 0;
  let authRequired = false;

  try {
    const queue = await getOutbox();

    for (const action of queue) {
      try {
        const result = action.kind === 'photo'
          ? await sendPhoto(action)
          : await sendAction(action);

        if (result === 'unauthorized') {
          // The session expired mid-day. Stop, keep everything queued, and let
          // the app ask for a sign-in. Nothing is discarded: this work is real
          // and the only thing wrong with it is that nobody is signed in yet.
          authRequired = true;
          failed++;
          break;
        }

        if (result === 'done') {
          await dequeue(action.clientActionId);
          if (action.kind === 'photo') await delPhoto(action.clientActionId);
          sent++;
        } else {
          failed++;
          await updateAction({
            ...action,
            attempts: action.attempts + 1,
            lastError: result === 'rejected' ? 'Refused by the server' : 'Send failed',
          });
        }
      } catch (err: any) {
        // Record and move on. One poisoned action must not block the rest of
        // the day's work from reaching the office.
        failed++;
        await updateAction({
          ...action,
          attempts: action.attempts + 1,
          lastError: String(err?.message ?? err).slice(0, 200),
        });
      }
    }
  } finally {
    syncing = false;
  }

  return { sent, failed, remaining: (await getOutbox()).length, authRequired };
}

/**
 * done         - applied, drop it
 * retry        - transient, keep it and try again later
 * rejected     - the server will never accept it; keep it so it is visible
 * unauthorized - no session; keep everything and stop
 */
type SendResult = 'done' | 'retry' | 'rejected' | 'unauthorized';

async function sendAction(action: OutboxAction): Promise<SendResult> {
  const res = await fetch('/api/tech/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientActionId: action.clientActionId,
      kind: action.kind,
      payload: action.payload,
      occurredAt: action.occurredAt,
    }),
  });

  if (res.status === 401) return 'unauthorized';

  // 403 means this device may not do this. Keep it rather than discarding it:
  // a technician's completed work must never disappear quietly because of a
  // permissions problem they cannot see.
  if (res.status === 403) {
    console.warn('[sync] refused', action.kind, await res.text());
    return 'rejected';
  }

  // Other 4xx is malformed and will never succeed. Keep it too, flagged, so it
  // shows up as stuck rather than vanishing.
  if (res.status >= 400 && res.status < 500) {
    console.warn('[sync] rejected', action.kind, await res.text());
    return 'rejected';
  }

  return res.ok ? 'done' : 'retry';
}

async function sendPhoto(action: OutboxAction): Promise<SendResult> {
  const photo = await getPhoto(action.clientActionId);
  if (!photo) return 'done'; // bytes already gone; nothing left to send

  const form = new FormData();
  form.set('clientActionId', action.clientActionId);
  form.set('workOrderId', photo.workOrderId);
  if (photo.propertyId) form.set('propertyId', photo.propertyId);
  form.set('capturedAt', photo.capturedAt);
  if (photo.lat != null) form.set('lat', String(photo.lat));
  if (photo.lng != null) form.set('lng', String(photo.lng));
  if (photo.caption) form.set('caption', photo.caption);
  form.set('file', photo.blob, `${action.clientActionId}.jpg`);

  const res = await fetch('/api/tech/photo', { method: 'POST', body: form });
  if (res.status === 401) return 'unauthorized';
  if (res.status >= 400 && res.status < 500) {
    console.warn('[sync] photo rejected', await res.text());
    return 'rejected';
  }
  return res.ok ? 'done' : 'retry';
}

/**
 * Retry whenever the browser thinks it is back online, and on a slow timer
 * because that event is optimistic - "online" often means "attached to a wifi
 * access point with no route to anywhere".
 */
export function startSyncLoop(onResult?: (r: SyncResult) => void) {
  const run = () => { void syncNow().then((r) => onResult?.(r)); };

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  const timer = setInterval(run, 30_000);
  run();

  return () => {
    window.removeEventListener('online', run);
    clearInterval(timer);
  };
}

// ── capture helpers ────────────────────────────────────────────────────────

/**
 * Position, best effort and never blocking.
 *
 * A PWA cannot report location in the background (ADR 0004), so this is called
 * at the moments that matter: en route, arrival, each photo, completion. If the
 * fix is slow or denied, the action still goes through without it - a photo
 * without coordinates is worth far more than no photo.
 */
export function getPosition(timeoutMs = 8000): Promise<GeolocationPosition | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: GeolocationPosition | null) => { if (!settled) { settled = true; resolve(v); } };
    navigator.geolocation.getCurrentPosition(
      (p) => done(p),
      () => done(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
    setTimeout(() => done(null), timeoutMs + 500);
  });
}

/**
 * Shrink a photo before it is stored or sent.
 *
 * A modern phone camera produces 4-12MB per shot. Technicians take a dozen per
 * job, often on cellular, sometimes on their own data plan. 1600px at quality
 * 0.7 is far more than enough to show a corroded union or a cracked gasket, and
 * turns a 9MB upload into roughly 300KB.
 */
export async function compressImage(file: File, maxEdge = 1600, quality = 0.7): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  return blob ?? file;
}
