import CustomerSearch from '../CustomerSearch';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function CustomersDirectory({ searchParams }: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;
  return (
    <>
      <div className="pagehead"><h2>Directory</h2></div>
      <CustomerSearch initialQuery={q ?? ''} />
      <p className="hint">
        Not on file? <a className="linkish" href="/customers/new">Add a customer</a>
      </p>
    </>
  );
}
