import { notFound } from 'next/navigation';
import GateCode from '../../GateCode';
import {
  getCustomer, getProperties, getContacts, getTimeline,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  sale: 'sale',
  payment: 'payment',
  service_call: 'service',
  delivery: 'delivery',
  install: 'install',
  quote: 'quote',
  water_test: 'water test',
  note: 'note',
  sms: 'text',
  call: 'call',
  email: 'email',
  photo: 'photo',
};

function fmtDate(v: string) {
  const d = new Date(v);
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    iso: d.toISOString(),
  };
}

function fmtMoney(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : null;
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const customer = await getCustomer(id).catch(() => null);
  if (!customer) notFound();

  const [properties, contacts, timeline] = await Promise.all([
    getProperties(id), getContacts(id), getTimeline(id),
  ]);

  return (
    <>
      <a className="back" href="/">← Search</a>

      <div className="header">
        <h2>{customer.display_name}</h2>
        <div className="meta">
          {[customer.primary_phone, customer.primary_email].filter(Boolean).join('  ·  ') || '—'}
        </div>
        <div className="badges">
          {customer.account_number && <span className="badge">#{customer.account_number}</span>}
          <span className="badge">{customer.kind}</span>
          {customer.status !== 'active' && <span className="badge warn">{customer.status}</span>}
          {customer.tax_exempt && <span className="badge accent">tax exempt</span>}
          {customer.customer_since && (
            <span className="badge">since {String(customer.customer_since).slice(0, 4)}</span>
          )}
          {customer.legacy_id && <span className="badge">evosus {customer.legacy_id}</span>}
        </div>
      </div>

      <div className="grid">
        <div>
          <div className="card">
            <h3>Billing</h3>
            <dl className="kv">
              <dt>Address</dt>
              <dd>
                {customer.line1
                  ? <>{customer.line1}<br />{[customer.city, customer.state].filter(Boolean).join(', ')} {customer.postal_code}</>
                  : <span style={{ color: 'var(--text-dim)' }}>None on file</span>}
              </dd>
              <dt>Phone</dt><dd>{customer.primary_phone ?? '—'}</dd>
              <dt>Email</dt><dd>{customer.primary_email ?? '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <h3>Contacts ({contacts.length})</h3>
            {contacts.length === 0 && <p className="empty" style={{ padding: 0 }}>None.</p>}
            {contacts.map((c) => (
              <div className="prop" key={c.id}>
                <div className="label">
                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed contact'}
                  {c.is_primary && <span className="pin"> primary</span>}
                </div>
                <div className="addr">
                  {[c.role, c.phone, c.mobile, c.email].filter(Boolean).join('  ·  ') || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="card">
            <h3>Properties ({properties.length})</h3>
            {properties.length === 0 && <p className="empty" style={{ padding: 0 }}>None.</p>}
            {properties.map((p) => (
              <div className="prop" key={p.id}>
                <div className="label">
                  {p.label ?? 'Unnamed property'}
                  {p.property_type && <span className="badge" style={{ marginLeft: 8 }}>{p.property_type}</span>}
                  {!p.active && <span className="badge warn" style={{ marginLeft: 6 }}>inactive</span>}
                </div>
                {p.line1 && (
                  <div className="addr">
                    {p.line1}, {[p.city, p.state].filter(Boolean).join(', ')} {p.postal_code}
                  </div>
                )}
                {p.access_notes && <div className="note"><b>Access</b> · {p.access_notes}</div>}
                {p.pet_notes && <div className="note"><b>Pets</b> · {p.pet_notes}</div>}
                {p.has_gate_code && (
                  <div className="note"><b>Gate code</b> · <GateCode propertyId={p.id} /></div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Timeline ({timeline.length})</h3>
        {timeline.length === 0 && <p className="empty" style={{ padding: 0 }}>Nothing recorded yet.</p>}
        <ul className="timeline">
          {timeline.map((e) => {
            const { date, iso } = fmtDate(e.occurred_at);
            const amount = fmtMoney((e.payload as any)?.amount);
            return (
              <li className="event" key={e.id}>
                <time className="when" dateTime={iso}>{date}</time>
                <div>
                  {amount && <span className="amount">{amount}</span>}
                  <div className="title">
                    <span className={`kind ${e.kind}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                    {e.title ?? '—'}
                    {e.pinned && <span className="pin">pinned</span>}
                  </div>
                  {e.body && <div className="body">{e.body}</div>}
                  <div className="who">
                    {[
                      e.property_label,
                      e.actor_label,
                      e.source !== 'app' ? `via ${e.source}` : null,
                    ].filter(Boolean).join('  ·  ')}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
