import ActionForm from '../../../ui/ActionForm';
import { CustomerFields } from '../../../ui/Fields';
import { createCustomerAction } from '../../../actions';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Adding a customer at the counter.
 *
 * The only required thing is a name, because the moment this gets used is the
 * moment someone is standing there with a bag of chemicals and no account. Fill
 * in what you have now; everything else is editable from the record afterwards.
 */
export default async function NewCustomerPage() {
  await requireUser();

  return (
    <>
      <a className="back" href="/">← Search</a>

      <div className="header">
        <h2>New customer</h2>
        <div className="meta">
          A name is enough to start. The rest can be filled in later.
        </div>
      </div>

      <div className="card">
        <ActionForm
          action={createCustomerAction}
          submitLabel="Create customer"
          pendingLabel="Creating…"
          successPathPrefix="/customers/"
        >
          <CustomerFields />
        </ActionForm>
      </div>
    </>
  );
}
