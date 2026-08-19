/**
 * On-device storage for the technician app.
 *
 * Properties on Lake Champlain have no signal. The app therefore reads from
 * IndexedDB FIRST and treats the network as a background refresh, rather than
 * fetching on load and showing a spinner to someone standing in a driveway.
 *
 * Hand-rolled rather than pulling in a wrapper library: this is about 150 lines
 * of the IndexedDB API, it has no dependencies to age, and the person
 * maintaining it is the person who runs the store.
 *
 * BYOD note (ADR 0004): technicians use personal phones. Gate codes live in a
 * separate store with an explicit expiry and are wiped on sign-out and at the
 * end of the day. Everything else is ordinary job data.
 */

const DB_NAME = 'lcp-tech';
const DB_VERSION = 1;

export type StoreName = 'meta' | 'jobs' | 'tasks' | 'outbox' | 'photos' | 'secrets';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tasks')) {
        const s = db.createObjectStore('tasks', { keyPath: 'id' });
        s.createIndex('byJob', 'work_order_id');
      }
      // Queued actions, replayed in the order they happened.
      if (!db.objectStoreNames.contains('outbox')) {
        const s = db.createObjectStore('outbox', { keyPath: 'clientActionId' });
        s.createIndex('bySeq', 'seq');
      }
      // Photo bytes, held until the upload confirms.
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'clientActionId' });
      }
      // Gate codes. Separate store so it can be wiped independently.
      if (!db.objectStoreNames.contains('secrets')) {
        db.createObjectStore('secrets', { keyPath: 'propertyId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: IDBValidKey) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>),
  all: <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  put: (store: StoreName, value: unknown, key?: IDBValidKey) =>
    tx(store, 'readwrite', (s) => s.put(value as any, key)),
  del: (store: StoreName, key: IDBValidKey) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: StoreName) => tx(store, 'readwrite', (s) => s.clear()),
};

// ── meta ───────────────────────────────────────────────────────────────────

export const meta = {
  get: <T>(key: string) => idb.get<T>('meta', key),
  set: (key: string, value: unknown) => idb.put('meta', value, key),
};

// ── jobs ───────────────────────────────────────────────────────────────────

export type Job = {
  id: string;
  number: string | null;
  type: string;
  status: string;
  priority: string;
  scheduled_window: string | null;
  estimated_minutes: number | null;
  sequence: number | null;
  summary: string | null;
  instructions: string | null;
  customer_name: string;
  customer_phone: string | null;
  property_label: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  access_notes: string | null;
  pet_notes: string | null;
  has_gate_code: boolean;
  property_id: string | null;
  customer_id: string;
  work_performed?: string | null;
  /** Why a job could not be finished. Carried by /api/tech/day for the tech's own jobs. */
  incomplete_reason?: string | null;
  /** Set locally the moment a tech acts, before any sync. */
  dirty?: boolean;
};

export type Task = {
  id: string;
  work_order_id: string;
  sequence: number;
  label: string;
  done: boolean;
};

/**
 * The fields a technician authors on the phone.
 *
 * Everything else about a job belongs to the office - the window they moved,
 * the instruction they added - and should arrive on the next refresh. These
 * three are the ones the phone is the source of truth for until the outbox
 * drains, so they are laid back over the fresh server row rather than the whole
 * local row being kept. `incomplete_reason` is on this list for exactly the
 * same reason `work_performed` is: it is typed in a driveway with no signal,
 * and losing it on the next refresh would mean the tech said why for nothing.
 */
const LOCAL_FIELDS = ['status', 'work_performed', 'incomplete_reason'] as const;

function withLocalEdits(server: Job, local: Job): Job {
  const merged: Job = { ...server, dirty: true };
  for (const field of LOCAL_FIELDS) {
    const value = local[field];
    if (value != null) (merged as Record<string, unknown>)[field] = value;
  }
  return merged;
}

export async function saveDay(jobs: Job[], tasks: Task[]) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['jobs', 'tasks'], 'readwrite');
    const jobStore = t.objectStore('jobs');
    const taskStore = t.objectStore('tasks');

    // Local edits that have not synced yet must survive a refresh, otherwise a
    // tech who fills in notes in a dead zone loses them the moment signal
    // returns - which would be the single fastest way to lose their trust.
    const existing = jobStore.getAll();
    existing.onsuccess = () => {
      const dirty = new Map(
        (existing.result as Job[]).filter((j) => j.dirty).map((j) => [j.id, j]),
      );
      jobStore.clear();
      taskStore.clear();
      for (const j of jobs) {
        const local = dirty.get(j.id);
        jobStore.put(local ? withLocalEdits(j, local) : j);
      }
      for (const k of tasks) taskStore.put(k);
    };

    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const getJobs = () => idb.all<Job>('jobs');
export const getJob = (id: string) => idb.get<Job>('jobs', id);
export const putJob = (job: Job) => idb.put('jobs', job);
export const getTasks = () => idb.all<Task>('tasks');
export const putTask = (task: Task) => idb.put('tasks', task);

// ── outbox ─────────────────────────────────────────────────────────────────

export type OutboxAction = {
  clientActionId: string;
  seq: number;
  kind: 'job_status' | 'task_toggle' | 'job_notes' | 'photo' | 'ping';
  payload: Record<string, unknown>;
  occurredAt: string;
  attempts: number;
  lastError?: string;
};

export async function enqueue(
  kind: OutboxAction['kind'],
  payload: Record<string, unknown>,
): Promise<OutboxAction> {
  const action: OutboxAction = {
    clientActionId: crypto.randomUUID(),
    seq: Date.now(),
    kind,
    payload,
    occurredAt: new Date().toISOString(),
    attempts: 0,
  };
  await idb.put('outbox', action);
  return action;
}

export const getOutbox = async () =>
  (await idb.all<OutboxAction>('outbox')).sort((a, b) => a.seq - b.seq);
export const dequeue = (clientActionId: string) => idb.del('outbox', clientActionId);
export const updateAction = (action: OutboxAction) => idb.put('outbox', action);

// ── photos ─────────────────────────────────────────────────────────────────

export type PendingPhoto = {
  clientActionId: string;
  workOrderId: string;
  propertyId: string | null;
  blob: Blob;
  capturedAt: string;
  lat: number | null;
  lng: number | null;
  caption: string | null;
};

export const putPhoto = (p: PendingPhoto) => idb.put('photos', p);
export const getPhoto = (id: string) => idb.get<PendingPhoto>('photos', id);
export const getPhotos = () => idb.all<PendingPhoto>('photos');
export const delPhoto = (id: string) => idb.del('photos', id);

// ── secrets ────────────────────────────────────────────────────────────────

type CachedSecret = { propertyId: string; code: string; expiresAt: number };

/**
 * Gate codes are cached only for properties on today's route, and only until
 * end of day. On a personal phone that is the difference between "the codes for
 * four houses, until tonight" and "the codes for every customer we have".
 */
export async function cacheSecret(propertyId: string, code: string) {
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  await idb.put('secrets', { propertyId, code, expiresAt: endOfDay.getTime() } satisfies CachedSecret);
}

export async function readSecret(propertyId: string): Promise<string | null> {
  const s = await idb.get<CachedSecret>('secrets', propertyId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    await idb.del('secrets', propertyId);
    return null;
  }
  return s.code;
}

export async function purgeExpiredSecrets() {
  for (const s of await idb.all<CachedSecret>('secrets')) {
    if (Date.now() > s.expiresAt) await idb.del('secrets', s.propertyId);
  }
}

/**
 * Drop every cached gate code, keeping the rest of the day.
 *
 * Called when the server stops recognising the session. The jobs stay readable
 * because a technician standing at a property should not lose their route to an
 * expired cookie, but the codes go: those are only cached on the strength of a
 * session that no longer exists.
 */
export async function wipeSecrets() {
  await idb.clear('secrets');
}

/** Sign-out, or a device being handed over. Leaves nothing sensitive behind. */
export async function wipeDevice() {
  await Promise.all([
    idb.clear('jobs'), idb.clear('tasks'), idb.clear('outbox'),
    idb.clear('photos'), idb.clear('secrets'), idb.clear('meta'),
  ]);
}
