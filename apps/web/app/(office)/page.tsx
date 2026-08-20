import CustomerSearch from './CustomerSearch';
import { getStats } from '@/lib/queries';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;

  let stats = { customers: 0, properties: 0, events: 0 };
  let error: string | null = null;

  try {
    stats = await getStats();
  } catch (err: any) {
    error = String(err?.message ?? err);
  }

  return (
    <>
      <CustomerSearch initialQuery={q ?? ''} />

      {error ? (
        <p className="empty">
          Database not reachable: {error}
          <br />
          Run <code>npm run db:migrate</code>, then <code>npm run etl -- demo</code>.
        </p>
      ) : stats.customers === 0 ? (
        <p className="empty">
          No customers loaded yet. Run <code>npm run etl -- demo</code> to load sample
          data, or <code>npm run etl -- discover</code> to start from Evosus.
        </p>
      ) : (
        <p className="hint">
          {stats.customers.toLocaleString()} customers ·{' '}
          {stats.properties.toLocaleString()} properties ·{' '}
          {stats.events.toLocaleString()} timeline events
        </p>
      )}

      {/* Below the search box, not above it: the overwhelmingly common case is
          looking someone up, and a customer who is not found is the rare one. */}
      <p className="hint">
        Not on file? <a className="linkish" href="/customers/new">Add a customer</a>
      </p>
    </>
  );
}
