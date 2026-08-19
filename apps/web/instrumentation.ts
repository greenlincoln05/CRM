/**
 * Startup work for the web app.
 *
 * Next calls register() once per server instance, before any request is
 * served — and it calls it on the edge runtime too, where node:crypto does not
 * exist. The runtime check plus a separate module is the supported way to keep
 * Node-only startup out of the edge bundle; webpack understands NEXT_RUNTIME
 * and drops the branch entirely.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}
