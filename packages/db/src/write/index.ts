/**
 * The write layer.
 *
 * Every function here takes (db, actor, ...) and every one of them appends to
 * the timeline when it changes something a person would want explained. That
 * is the whole contract, and it lives in this package rather than in the web
 * app so it can be tested without a browser - see src/smoke-writes.ts.
 */
export * from './input.js';
export * from './shared.js';
export * from './customers.js';
export * from './contacts.js';
export * from './properties.js';
export * from './timeline.js';
export * from './waterTests.js';
export * from './workOrders.js';
export * from './channels.js';
