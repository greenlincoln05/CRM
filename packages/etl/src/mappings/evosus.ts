/**
 * Evosus -> LCP field mapping.
 *
 * THIS IS THE FILE YOU EDIT after running `npm run etl -- discover`.
 *
 * Each target field lists candidate source column names, tried in order,
 * case-insensitively. Candidates rather than a single name because we do not
 * yet know what Evosus actually calls things - this way the pipeline runs
 * against real data immediately and you correct it once, here, instead of
 * hunting through transform code.
 *
 * When discovery tells you the real column is `CustNo`, put `CustNo` at the
 * front of the accountNumber list and move on.
 */

export type Candidates = string[];

export type EntityMapping = {
  /** entity name used in legacy_row */
  entity: string;
  /** source column holding the primary key */
  key: Candidates;
  fields: Record<string, Candidates>;
};

export const customerMapping: EntityMapping = {
  entity: 'customer',
  key: ['CustomerID', 'CustomerId', 'CustID', 'CustNo', 'ID'],
  fields: {
    accountNumber: ['CustomerNumber', 'AccountNumber', 'CustNo', 'AcctNo', 'CustomerCode'],
    companyName:   ['CompanyName', 'Company', 'BusinessName'],
    fullName:      ['CustomerName', 'Name', 'FullName'],
    firstName:     ['FirstName', 'First', 'FName'],
    lastName:      ['LastName', 'Last', 'LName'],
    primaryPhone:  ['Phone', 'PhoneNumber', 'HomePhone', 'Phone1', 'MainPhone'],
    mobilePhone:   ['Cell', 'CellPhone', 'Mobile', 'MobilePhone', 'Phone2'],
    primaryEmail:  ['Email', 'EmailAddress', 'Email1'],
    line1:         ['Address1', 'Address', 'AddressLine1', 'Street', 'BillingAddress1'],
    line2:         ['Address2', 'AddressLine2', 'BillingAddress2'],
    city:          ['City', 'BillingCity'],
    state:         ['State', 'ST', 'BillingState', 'Province'],
    postalCode:    ['Zip', 'ZipCode', 'PostalCode', 'BillingZip'],
    customerSince: ['DateCreated', 'CreatedDate', 'CustomerSince', 'DateAdded', 'SetupDate'],
    taxExempt:     ['TaxExempt', 'IsTaxExempt', 'Exempt'],
    taxExemptId:   ['TaxExemptID', 'ExemptNumber', 'ResaleNumber'],
    status:        ['Status', 'Active', 'IsActive', 'Inactive'],
    notes:         ['Notes', 'Comments', 'Memo', 'CustomerNotes'],
  },
};

export const propertyMapping: EntityMapping = {
  entity: 'property',
  key: ['SiteID', 'LocationID', 'ServiceSiteID', 'PropertyID', 'ID'],
  fields: {
    customerLegacyId: ['CustomerID', 'CustID', 'CustomerId'],
    label:            ['SiteName', 'LocationName', 'Description', 'Nickname'],
    line1:            ['Address1', 'ServiceAddress1', 'Address', 'Street'],
    line2:            ['Address2', 'ServiceAddress2'],
    city:             ['City', 'ServiceCity'],
    state:            ['State', 'ServiceState', 'ST'],
    postalCode:       ['Zip', 'ZipCode', 'ServiceZip', 'PostalCode'],
    accessNotes:      ['AccessNotes', 'DirectionsNotes', 'Directions', 'SiteNotes'],
    gateCode:         ['GateCode', 'AccessCode', 'LockboxCode'],
    petNotes:         ['PetNotes', 'Dog', 'Pets'],
    propertyType:     ['SiteType', 'LocationType', 'Type'],
    active:           ['Active', 'IsActive', 'Status'],
  },
};

/**
 * Historical activity -> timeline. Anything with a date, a customer, and a
 * description belongs here: invoices, service calls, deliveries, notes.
 * The point is not to reproduce Evosus reporting - it is so that opening a
 * customer shows twenty years of relationship instead of an empty page.
 */
export const historyMapping: EntityMapping = {
  entity: 'history',
  key: ['ID', 'TransactionID', 'InvoiceID', 'TicketID', 'OrderID'],
  fields: {
    customerLegacyId: ['CustomerID', 'CustID', 'CustomerId'],
    propertyLegacyId: ['SiteID', 'LocationID', 'ServiceSiteID'],
    occurredAt:       ['TransactionDate', 'InvoiceDate', 'Date', 'ServiceDate', 'CreatedDate', 'CompletedDate'],
    kind:             ['Type', 'TransactionType', 'DocumentType'],
    title:            ['Description', 'Summary', 'Subject', 'InvoiceNumber'],
    body:             ['Notes', 'Comments', 'Detail', 'Memo', 'WorkPerformed'],
    amount:           ['Total', 'Amount', 'GrandTotal', 'TotalAmount'],
    actorLabel:       ['CreatedBy', 'UserName', 'Technician', 'SalesRep', 'EnteredBy'],
  },
};

/**
 * Map an Evosus document/transaction type onto our timeline kinds. Update the
 * left-hand side once discovery shows the real values - the fallback is 'note',
 * so an unmapped type still appears on the timeline rather than vanishing.
 */
export const historyKindMap: Record<string, string> = {
  invoice: 'sale',
  sale: 'sale',
  saleorder: 'sale',
  pos: 'sale',
  payment: 'payment',
  credit: 'payment',
  serviceorder: 'service_call',
  servicecall: 'service_call',
  ticket: 'service_call',
  workorder: 'service_call',
  delivery: 'delivery',
  install: 'install',
  installation: 'install',
  quote: 'quote',
  estimate: 'quote',
  watertest: 'water_test',
  note: 'note',
};

/** Case-insensitive lookup of the first candidate present in a legacy row. */
export function pick(row: Record<string, unknown>, candidates: Candidates): unknown {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lower.set(k.toLowerCase(), v);
  for (const c of candidates) {
    const v = lower.get(c.toLowerCase());
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Which candidate actually matched - used by the mapping-coverage report. */
export function pickName(row: Record<string, unknown>, candidates: Candidates): string | null {
  const lower = new Set(Object.keys(row).map((k) => k.toLowerCase()));
  for (const c of candidates) if (lower.has(c.toLowerCase())) return c;
  return null;
}
