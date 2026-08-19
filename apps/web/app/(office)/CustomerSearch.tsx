'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchHit } from '@/lib/queries';

/**
 * The search box.
 *
 * This is the single most-used screen in the building, so it is built for
 * someone standing at a counter with a customer in front of them:
 *
 *  - focused on load, so you type immediately without touching the mouse
 *  - 120ms debounce, fast enough to feel live at this data volume
 *  - responses applied in order, so a slow early request cannot overwrite a
 *    newer one and show stale results
 *  - arrow keys and Enter, so the whole flow works without leaving the keyboard
 */
export default function CustomerSearch() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const router = useRouter();

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setHits([]); setSearched(false); return; }

    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        // Drop responses that a newer keystroke has already superseded.
        if (mine !== seq.current) return;
        setHits(data.hits ?? []);
        setActive(0);
        setSearched(true);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [q]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[active]) { router.push(`/customers/${hits[active]!.id}`); }
    else if (e.key === 'Escape') { setQ(''); }
  }

  return (
    <>
      <div className="searchwrap">
        <input
          ref={inputRef}
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search name, phone, address, or account number…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search customers"
        />
      </div>

      <p className="hint">
        Spelling does not have to be exact. <kbd>↑</kbd> <kbd>↓</kbd> to move,{' '}
        <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to clear.
      </p>

      {searched && hits.length === 0 && !loading && (
        <p className="empty">No customers matched “{q}”.</p>
      )}

      <ul className="results">
        {hits.map((h, i) => (
          <li key={h.id}>
            <a
              className="result"
              href={`/customers/${h.id}`}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
            >
              {h.account_number && <span className="acct">#{h.account_number}</span>}
              <div className="name">{h.display_name}</div>
              <div className="meta">
                {[
                  h.primary_phone,
                  h.city && h.state ? `${h.city}, ${h.state}` : h.city,
                  h.primary_email,
                ].filter(Boolean).join('  ·  ') || '—'}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
