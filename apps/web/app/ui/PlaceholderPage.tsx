import { subsectionFor } from '@/lib/nav';

const STATUS_LINE = {
  partial: 'Begun in code — the data layer exists; this screen does not yet. See DEMO.md for exact status.',
  planned: 'Not started. This page marks the intended destination. See DEMO.md for the roadmap.',
  built: '',
} as const;

/**
 * What an unbuilt destination shows: the aim, in CORE.md's own language,
 * and an honest status. Deliberately no fake data and no mock charts — a
 * placeholder that looks like a working dashboard would lie, and this
 * repository's whole documentation culture is honest status.
 */
export default function PlaceholderPage({ href }: { href: string }) {
  const found = subsectionFor(href);
  if (!found?.sub.placeholder) {
    throw new Error(`No placeholder copy in nav.ts for ${href}`);
  }
  const { sub } = found;
  const copy = sub.placeholder!;

  return (
    <div className="ph">
      <div className="pagehead">
        <h2>{sub.label}</h2>
        <span className="chip planned">{copy.phase}</span>
      </div>
      <p className="lead">{copy.lead}</p>
      <ul className="ph-aims">
        {copy.aims.map((aim) => <li key={aim}>{aim}</li>)}
      </ul>
      <p className="ph-status">{STATUS_LINE[sub.status]}</p>
      {copy.today?.length ? (
        <p className="ph-today">
          Today: {copy.today.map((t, i) => (
            <span key={t.href}>{i > 0 && ' · '}<a href={t.href}>{t.label}</a></span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
