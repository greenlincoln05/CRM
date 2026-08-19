import { sql } from 'drizzle-orm';
import type { Actor } from '../auth.js';
import {
  WriteError, clean, formatPhone, normalizeEmail, oneOf,
} from './input.js';
import {
  type AddressInput, type Db, MANUAL_SOURCE, assertUuid, describeChanges,
  formatAddress, normalizeAddress, addressIsEmpty, isUniqueViolation,
  recordEvent, rows, upsertAddress,
} from './shared.js';

const ACCOUNT_NUMBER_INDEX = 'customer_account_number_unique_idx';

const accountTaken = (accountNumber: string) => new WriteError(
  `Account number ${accountNumber} already belongs to another customer.`,
  'accountNumber',
);

/**
 * Run a write, converting a lost race on the account number into the same
 * message the pre-flight check produces. Anything else is somebody else's
 * problem and travels on untouched.
 */
async function catchingAccountClash<T>(
  accountNumber: string | null, work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (accountNumber && isUniqueViolation(err, ACCOUNT_NUMBER_INDEX)) throw accountTaken(accountNumber);
    throw err;
  }
}

/**
 * Creating and correcting the customer record itself.
 *
 * display_name and search_text are not written here. A trigger derives both on
 * every insert and update (migration 0001), which means a customer typed in at
 * the counter is findable by the same fuzzy search as one migrated from Evosus,
 * without this code knowing anything about how search works.
 */

export const CUSTOMER_KINDS = ['residential', 'commercial'] as const;
export const CUSTOMER_STATUSES = ['active', 'inactive'] as const;

export type CustomerInput = {
  kind?: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  accountNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  customerSince?: string | null;
  taxExempt?: boolean;
  taxExemptId?: string | null;
  status?: string;
  billing?: AddressInput;
};

type CustomerRow = {
  id: string; display_name: string; kind: string; status: string;
  first_name: string | null; last_name: string | null; company_name: string | null;
  account_number: string | null; primary_phone: string | null; primary_email: string | null;
  customer_since: string | null; tax_exempt: boolean; tax_exempt_id: string | null;
  billing_address_id: string | null;
  line1: string | null; city: string | null; state: string | null; postal_code: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  kind: 'Type',
  status: 'Status',
  firstName: 'First name',
  lastName: 'Last name',
  companyName: 'Company',
  accountNumber: 'Account number',
  phone: 'Phone',
  email: 'Email',
  customerSince: 'Customer since',
  taxExempt: 'Tax exempt',
  taxExemptId: 'Tax exempt ID',
  billing: 'Billing address',
};

function validate(input: CustomerInput) {
  const kind = oneOf(input.kind, CUSTOMER_KINDS, 'kind', 'residential');
  const companyName = clean(input.companyName);
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);

  if (kind === 'commercial' && !companyName) {
    throw new WriteError('A commercial account needs a company name.', 'companyName');
  }
  if (!companyName && !firstName && !lastName) {
    throw new WriteError('Enter a name, or a company name.', 'lastName');
  }

  const customerSince = clean(input.customerSince);
  if (customerSince && !/^\d{4}-\d{2}-\d{2}$/.test(customerSince)) {
    throw new WriteError('Customer since must be a date (YYYY-MM-DD).', 'customerSince');
  }

  const taxExemptId = clean(input.taxExemptId);
  if (input.taxExempt && !taxExemptId) {
    throw new WriteError('A tax-exempt account needs its exemption ID on file.', 'taxExemptId');
  }

  return {
    kind,
    status: oneOf(input.status, CUSTOMER_STATUSES, 'status', 'active'),
    companyName,
    firstName,
    lastName,
    accountNumber: clean(input.accountNumber),
    phone: formatPhone(input.phone),
    email: normalizeEmail(input.email),
    customerSince,
    taxExempt: Boolean(input.taxExempt),
    taxExemptId,
  };
}

export async function createCustomer(
  db: Db, actor: Actor, input: CustomerInput,
): Promise<{ id: string; displayName: string }> {
  const v = validate(input);

  // An account number staff will later search by must not point at two records.
  // The index added in migration 0009 is what enforces that; this is here to
  // say so in a sentence rather than as a constraint violation.
  if (v.accountNumber) {
    const clash = rows(await db.execute(sql`
      SELECT 1 FROM customer WHERE account_number = ${v.accountNumber}
    `));
    if (clash.length > 0) throw accountTaken(v.accountNumber);
  }

  return catchingAccountClash(v.accountNumber, () => db.transaction(async (tx: Db) => {
    const billingAddressId = input.billing
      ? await upsertAddress(tx, null, input.billing)
      : null;

    const created = rows<{ id: string; display_name: string }>(await tx.execute(sql`
      INSERT INTO customer (
        kind, company_name, first_name, last_name, account_number,
        primary_phone, primary_email, billing_address_id, status,
        customer_since, tax_exempt, tax_exempt_id, legacy_source
      ) VALUES (
        ${v.kind}, ${v.companyName}, ${v.firstName}, ${v.lastName}, ${v.accountNumber},
        ${v.phone}, ${v.email}, ${billingAddressId}, ${v.status},
        ${v.customerSince}, ${v.taxExempt}, ${v.taxExemptId}, ${MANUAL_SOURCE}
      )
      RETURNING id, display_name
    `))[0]!;

    // The first entry on the timeline says where the record came from. Without
    // it, a customer created today looks identical to one migrated from a 2006
    // Evosus row, and "why does this account have no history" has no answer.
    await recordEvent(tx, actor, {
      customerId: created.id,
      kind: 'system',
      title: 'Customer record created',
      body: `Added at the counter by ${actor.label}.`,
    });

    return { id: created.id, displayName: created.display_name };
  }));
}

export async function updateCustomer(
  db: Db, actor: Actor, customerId: string, input: CustomerInput,
): Promise<{ id: string; displayName: string; changes: string[] }> {
  const id = assertUuid(customerId, 'customerId');
  const v = validate(input);

  const before = rows<CustomerRow>(await db.execute(sql`
    SELECT c.*, a.line1, a.city, a.state, a.postal_code
      FROM customer c
      LEFT JOIN address a ON a.id = c.billing_address_id
     WHERE c.id = ${id}::uuid
  `))[0];
  if (!before) throw new WriteError('That customer could not be found.', 'customerId');

  if (v.accountNumber && v.accountNumber !== before.account_number) {
    const clash = rows(await db.execute(sql`
      SELECT 1 FROM customer WHERE account_number = ${v.accountNumber} AND id <> ${id}::uuid
    `));
    if (clash.length > 0) throw accountTaken(v.accountNumber);
  }

  const nextAddress = input.billing ? normalizeAddress(input.billing) : null;

  return catchingAccountClash(v.accountNumber, () => db.transaction(async (tx: Db) => {
    const billingAddressId = input.billing
      ? await upsertAddress(tx, before.billing_address_id, input.billing)
      : before.billing_address_id;

    const after = rows<{ id: string; display_name: string }>(await tx.execute(sql`
      UPDATE customer SET
        kind = ${v.kind}, company_name = ${v.companyName},
        first_name = ${v.firstName}, last_name = ${v.lastName},
        account_number = ${v.accountNumber},
        primary_phone = ${v.phone}, primary_email = ${v.email},
        billing_address_id = ${billingAddressId}, status = ${v.status},
        customer_since = ${v.customerSince}, tax_exempt = ${v.taxExempt},
        tax_exempt_id = ${v.taxExemptId}
      WHERE id = ${id}::uuid
      RETURNING id, display_name
    `))[0]!;

    const changes = describeChanges(
      {
        kind: before.kind,
        status: before.status,
        firstName: before.first_name,
        lastName: before.last_name,
        companyName: before.company_name,
        accountNumber: before.account_number,
        phone: before.primary_phone,
        email: before.primary_email,
        customerSince: before.customer_since,
        taxExempt: before.tax_exempt,
        taxExemptId: before.tax_exempt_id,
        billing: formatAddress({
          line1: before.line1, city: before.city,
          state: before.state, postalCode: before.postal_code,
        }),
      },
      {
        ...v,
        billing: nextAddress && !addressIsEmpty(nextAddress)
          ? formatAddress(nextAddress)
          : formatAddress({
            line1: before.line1, city: before.city,
            state: before.state, postalCode: before.postal_code,
          }),
      },
      FIELD_LABELS,
    );

    // A save that changed nothing is not worth a timeline row. Staff open the
    // edit form to read it as often as to change it.
    if (changes.length > 0) {
      await recordEvent(tx, actor, {
        customerId: id,
        kind: 'system',
        title: 'Customer details edited',
        body: changes.join('\n'),
      });
    }

    return { id: after.id, displayName: after.display_name, changes };
  }));
}
