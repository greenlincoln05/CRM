import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, boolean, timestamp, date, numeric, jsonb,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { provenance, timestamps } from './_shared.js';

/**
 * Addresses are their own entity because one customer can have a billing
 * address, several service properties, and a seasonal camp - and Evosus
 * conflating these is a named pain point.
 */
export const address = pgTable('address', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  line1: text('line1'),
  line2: text('line2'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  country: text('country').notNull().default('US'),

  lat: numeric('lat', { precision: 10, scale: 7 }),
  lng: numeric('lng', { precision: 10, scale: 7 }),

  // Verbatim legacy address string, kept even after parsing succeeds.
  rawInput: text('raw_input'),
  // Set once USPS/Smarty confirms it. Unvalidated legacy addresses stay usable.
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  validationSource: text('validation_source'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('address_postal_idx').on(t.postalCode),
  index('address_city_state_idx').on(t.city, t.state),
]);

/**
 * THE customer record. One per household or business - the "one customer"
 * half of the guiding principle.
 */
export const customer = pgTable('customer', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

  /**
   * Evosus account number. Staff have twenty years of muscle memory with these
   * and will keep saying "pull up 14032" long after cutover, so it stays
   * searchable forever.
   */
  accountNumber: text('account_number'),

  kind: text('kind').notNull().default('residential'), // residential | commercial
  companyName: text('company_name'),
  firstName: text('first_name'),
  lastName: text('last_name'),

  /** Denormalized for search and display. Maintained by trigger. */
  displayName: text('display_name').notNull().default(''),

  /** Denormalized from the primary contact so search hits phone/email fast. */
  primaryPhone: text('primary_phone'),
  primaryEmail: text('primary_email'),

  billingAddressId: uuid('billing_address_id').references(() => address.id),

  status: text('status').notNull().default('active'), // active | inactive | merged
  /** Set when this record loses a merge; all reads follow the pointer. */
  mergedIntoCustomerId: uuid('merged_into_customer_id'),

  customerSince: date('customer_since'),
  taxExempt: boolean('tax_exempt').notNull().default(false),
  taxExemptId: text('tax_exempt_id'),

  ...provenance,
  ...timestamps,
}, (t) => [
  uniqueIndex('customer_legacy_key_idx').on(t.legacySource, t.legacyId),
  index('customer_account_number_idx').on(t.accountNumber),
  index('customer_status_idx').on(t.status),
]);

/**
 * People attached to a customer: spouse, property manager, tenant, AP clerk.
 * "Poor handling of multiple contacts" is a named pain point.
 */
export const contact = pgTable('contact', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid('customer_id').notNull().references(() => customer.id, { onDelete: 'cascade' }),
  firstName: text('first_name'),
  lastName: text('last_name'),
  role: text('role'),               // owner | spouse | property_manager | tenant | ap
  phone: text('phone'),
  mobile: text('mobile'),
  email: text('email'),
  isPrimary: boolean('is_primary').notNull().default(false),
  /** Suppress marketing and automated texts for this person. */
  doNotContact: boolean('do_not_contact').notNull().default(false),
  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('contact_customer_idx').on(t.customerId),
  index('contact_phone_idx').on(t.phone),
  index('contact_email_idx').on(t.email),
]);

/**
 * A physical place we service. The doc: "No easy way to distinguish which
 * property is being serviced." This table is that answer, and it is also the
 * property profile the technician reads before getting out of the truck.
 */
export const property = pgTable('property', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  customerId: uuid('customer_id').notNull().references(() => customer.id, { onDelete: 'cascade' }),
  addressId: uuid('address_id').references(() => address.id),

  label: text('label'),                // "Main house", "Camp", "Shelburne rental"
  propertyType: text('property_type'), // pool | spa | stove | multiple

  isPrimary: boolean('is_primary').notNull().default(false),
  active: boolean('active').notNull().default(true),

  // -- Arrival knowledge: the Sprint 3 payload -------------------------------
  accessNotes: text('access_notes'),
  /**
   * SENSITIVE. Gate and lockbox codes. Needs column-level encryption before any
   * non-employee access exists - see docs/adr/0003-sensitive-fields.md.
   */
  gateCode: text('gate_code'),
  petNotes: text('pet_notes'),
  waterShutoffNotes: text('water_shutoff_notes'),
  electricalNotes: text('electrical_notes'),
  parkingNotes: text('parking_notes'),

  /** Structured detail that varies by type: pool gallons, liner, flue size. */
  attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),

  ...provenance,
  ...timestamps,
}, (t) => [
  index('property_customer_idx').on(t.customerId),
  index('property_address_idx').on(t.addressId),
]);

/**
 * Equipment installed at a property - heater, pump, filter, spa, stove.
 * Photographed once, referenced for the next ten years of service calls.
 */
export const propertyEquipment = pgTable('property_equipment', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  propertyId: uuid('property_id').notNull().references(() => property.id, { onDelete: 'cascade' }),
  category: text('category'),       // heater | pump | filter | spa | stove | cover | liner
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNumber: text('serial_number'),
  installedOn: date('installed_on'),
  warrantyExpiresOn: date('warranty_expires_on'),
  /** Did we sell it? Changes the warranty and service conversation. */
  soldByUs: boolean('sold_by_us'),
  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('property_equipment_property_idx').on(t.propertyId),
  index('property_equipment_serial_idx').on(t.serialNumber),
]);

/**
 * Twenty years of data guarantees duplicate customers. Merges are recorded
 * rather than executed destructively, so a bad merge is reversible.
 */
export const customerMerge = pgTable('customer_merge', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  survivorId: uuid('survivor_id').notNull().references(() => customer.id),
  mergedId: uuid('merged_id').notNull().references(() => customer.id),
  reason: text('reason'),
  /** Full snapshot of the losing record, so the merge can be undone. */
  mergedSnapshot: jsonb('merged_snapshot'),
  mergedBy: text('merged_by'),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('customer_merge_survivor_idx').on(t.survivorId),
  uniqueIndex('customer_merge_merged_idx').on(t.mergedId),
]);
