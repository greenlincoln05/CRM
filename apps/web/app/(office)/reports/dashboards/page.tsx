import PlaceholderPage from '../../../ui/PlaceholderPage';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireUser();
  return <PlaceholderPage href="/reports/dashboards" />;
}
