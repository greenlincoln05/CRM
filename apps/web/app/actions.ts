'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  WriteError,
  createCustomer, updateCustomer,
  addContact, updateContact, removeContact,
  addProperty, updateProperty, setPropertyActive,
  addNote, setEventPinned, redactEvent, unredactEvent,
  recordWaterTest,
  type Actor,
} from '@lcp/db';
import { getDb } from '@/lib/db';
import { endSession, requireUser, startSession } from '@/lib/session';

/**
 * Every write the counter app can perform.
 *
 * These are thin on purpose. The rules - what a valid phone number is, what
 * gets appended to the timeline, who may hide an entry - all live in @lcp/db,
 * where they can be tested without a browser. What belongs here is the three
 * things a server action is actually for: find out who is asking, hand the work
 * to the write layer, and tell Next.js what to re-render.
 */

export type FormState = {
  ok?: boolean;
  error?: string;
  /** Names the input the message belongs next to. */
  field?: string;
  /** Set by actions that create something the caller needs to navigate to. */
  id?: string;
};

const str = (fd: FormData, name: string): string | null => {
  const v = fd.get(name);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const bool = (fd: FormData, name: string): boolean => fd.get(name) === 'on' || fd.get(name) === 'true';

/**
 * Shared shape for every action below.
 *
 * A WriteError is a sentence meant for the person who typed it, so it goes back
 * as-is. Anything else is a bug or an outage: it gets logged in full and the
 * user gets something that does not leak a stack trace onto the counter screen.
 */
async function run(
  paths: string[],
  work: (db: any, actor: Actor) => Promise<unknown>,
): Promise<FormState> {
  const user = await requireUser();
  const { db } = await getDb();

  try {
    const result = await work(db, user);
    for (const p of paths) revalidatePath(p);

    // Only creators return an id worth navigating to; the rest return whatever
    // suits them, so this reads it if it is there and shrugs if it is not.
    const id = (result as { id?: unknown } | null | undefined)?.id;
    return { ok: true, id: typeof id === 'string' ? id : undefined };
  } catch (err: unknown) {
    if (err instanceof WriteError) {
      return { ok: false, error: err.message, field: err.field };
    }
    console.error('[action]', err);
    return { ok: false, error: 'That could not be saved. The error has been logged.' };
  }
}

// ── Sessions ───────────────────────────────────────────────────────────────

/**
 * Where to land after signing in.
 *
 * Middleware puts the path the person was actually trying to reach in `next`,
 * so a bookmark to a customer opens that customer rather than dumping them on
 * the search page.
 *
 * Only same-site absolute paths are honoured. A value starting with `//` is a
 * protocol-relative URL to another host, which is how a login form turns into an
 * open redirect, so anything but a single leading slash falls back home.
 */
function safeNext(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

export async function signInAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, 'email');
  const pin = str(fd, 'pin');
  if (!email) return { ok: false, error: 'Enter your email address.', field: 'email' };
  if (!pin) return { ok: false, error: 'Enter your PIN.', field: 'pin' };

  const result = await startSession(email, pin);
  if (!result.ok) return { ok: false, error: result.error, field: 'pin' };

  // Redirect from the server rather than pushing from the client on success.
  // A client-side push races the refresh that picks up the new session: the
  // refresh re-renders /login, whose server component now redirects to '/'
  // because the session exists, and that lands first - silently discarding
  // wherever the person was actually trying to go.
  redirect(safeNext(fd.get('next')));
}

export async function signOutAction(): Promise<void> {
  await endSession();
  revalidatePath('/');
}

// ── Customers ──────────────────────────────────────────────────────────────

function customerFields(fd: FormData) {
  return {
    kind: str(fd, 'kind') ?? 'residential',
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    companyName: str(fd, 'companyName'),
    accountNumber: str(fd, 'accountNumber'),
    phone: str(fd, 'phone'),
    email: str(fd, 'email'),
    customerSince: str(fd, 'customerSince'),
    taxExempt: bool(fd, 'taxExempt'),
    taxExemptId: str(fd, 'taxExemptId'),
    status: str(fd, 'status') ?? 'active',
    billing: {
      line1: str(fd, 'line1'),
      line2: str(fd, 'line2'),
      city: str(fd, 'city'),
      state: str(fd, 'state'),
      postalCode: str(fd, 'postalCode'),
    },
  };
}

export async function createCustomerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return run(['/'], (db, actor) => createCustomer(db, actor, customerFields(fd)));
}

export async function updateCustomerAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get('customerId') ?? '');
  return run([`/customers/${id}`], (db, actor) => updateCustomer(db, actor, id, customerFields(fd)));
}

// ── Contacts ───────────────────────────────────────────────────────────────

function contactFields(fd: FormData) {
  return {
    firstName: str(fd, 'firstName'),
    lastName: str(fd, 'lastName'),
    role: str(fd, 'role'),
    phone: str(fd, 'phone'),
    mobile: str(fd, 'mobile'),
    email: str(fd, 'email'),
    isPrimary: bool(fd, 'isPrimary'),
    doNotContact: bool(fd, 'doNotContact'),
    notes: str(fd, 'notes'),
  };
}

export async function addContactAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => addContact(db, actor, customerId, contactFields(fd)));
}

export async function updateContactAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const contactId = String(fd.get('contactId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => updateContact(db, actor, contactId, contactFields(fd)));
}

export async function removeContactAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const contactId = String(fd.get('contactId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => removeContact(db, actor, contactId));
}

// ── Properties ─────────────────────────────────────────────────────────────

function propertyFields(fd: FormData) {
  const fields: Record<string, unknown> = {
    label: str(fd, 'label'),
    propertyType: str(fd, 'propertyType'),
    isPrimary: bool(fd, 'isPrimary'),
    accessNotes: str(fd, 'accessNotes'),
    petNotes: str(fd, 'petNotes'),
    waterShutoffNotes: str(fd, 'waterShutoffNotes'),
    electricalNotes: str(fd, 'electricalNotes'),
    parkingNotes: str(fd, 'parkingNotes'),
    address: {
      line1: str(fd, 'line1'),
      line2: str(fd, 'line2'),
      city: str(fd, 'city'),
      state: str(fd, 'state'),
      postalCode: str(fd, 'postalCode'),
    },
  };

  // Absent and empty mean different things for a gate code: the edit form only
  // submits this field when someone deliberately opened it, and an empty value
  // then means "clear the code", not "leave it".
  if (fd.has('gateCode')) fields.gateCode = str(fd, 'gateCode') ?? '';

  return fields;
}

export async function addPropertyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => addProperty(db, actor, customerId, propertyFields(fd)));
}

export async function updatePropertyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const propertyId = String(fd.get('propertyId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => updateProperty(db, actor, propertyId, propertyFields(fd)));
}

export async function setPropertyActiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const propertyId = String(fd.get('propertyId') ?? '');
  const active = fd.get('active') === 'true';
  return run([`/customers/${customerId}`],
    (db, actor) => setPropertyActive(db, actor, propertyId, active));
}

// ── Timeline ───────────────────────────────────────────────────────────────

export async function addNoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  return run([`/customers/${customerId}`], (db, actor) => addNote(db, actor, {
    customerId,
    propertyId: str(fd, 'propertyId'),
    kind: str(fd, 'kind') ?? 'note',
    direction: str(fd, 'direction'),
    title: str(fd, 'title'),
    body: str(fd, 'body'),
    occurredAt: str(fd, 'occurredAt'),
    pinned: bool(fd, 'pinned'),
  }));
}

export async function togglePinAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const eventId = String(fd.get('eventId') ?? '');
  const pinned = fd.get('pinned') === 'true';
  return run([`/customers/${customerId}`],
    (db, actor) => setEventPinned(db, actor, eventId, pinned));
}

export async function redactEventAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const eventId = String(fd.get('eventId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => redactEvent(db, actor, eventId, String(fd.get('reason') ?? '')));
}

export async function unredactEventAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  const eventId = String(fd.get('eventId') ?? '');
  return run([`/customers/${customerId}`],
    (db, actor) => unredactEvent(db, actor, eventId));
}

// ── Water tests ────────────────────────────────────────────────────────────

export async function recordWaterTestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = String(fd.get('customerId') ?? '');
  return run([`/customers/${customerId}`], (db, actor) => recordWaterTest(db, actor, {
    customerId,
    propertyId: str(fd, 'propertyId'),
    source: str(fd, 'source') ?? 'in_store',
    freeChlorine: str(fd, 'freeChlorine'),
    totalChlorine: str(fd, 'totalChlorine'),
    ph: str(fd, 'ph'),
    totalAlkalinity: str(fd, 'totalAlkalinity'),
    calciumHardness: str(fd, 'calciumHardness'),
    cyanuricAcid: str(fd, 'cyanuricAcid'),
    salt: str(fd, 'salt'),
    phosphates: str(fd, 'phosphates'),
    temperatureF: str(fd, 'temperatureF'),
    recommendation: str(fd, 'recommendation'),
    notes: str(fd, 'notes'),
  }));
}
