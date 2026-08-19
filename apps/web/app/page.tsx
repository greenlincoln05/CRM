import CustomerSearch from './CustomerSearch';
import { getStats } from '@/lib/queries';
import { requirePageUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { denied } = await requirePageUser();
  if (denied) return denied;

  let stats = { customers: 0, properties: 0, events: 0 };
  let error: string | null = null;

  try {
    stats = await getStats();
  } catch (err: any) {
    error = String(err?.message ?? err);
  }

  return (
    <>
      <CustomerSearch />

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
    </>
  );
}
