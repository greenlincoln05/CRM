'use client';

import { useState } from 'react';

/**
 * Gate and lockbox codes are fetched only when deliberately revealed.
 *
 * ADR 0003. The code is never in the page payload - the server sends a boolean
 * saying one exists, and this asks for it by property id. Every reveal is
 * recorded in sensitive_access_log, so "who had our code" has a real answer.
 *
 * It also re-hides after a minute, because the realistic failure here is not an
 * attacker: it is a browser left open on the counter.
 */
export default function GateCode({ propertyId }: { propertyId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function reveal() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/gate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Unavailable'); return; }
      setCode(data.code);
      setTimeout(() => setCode(null), 60_000);
    } catch {
      setError('Unavailable offline');
    } finally {
      setLoading(false);
    }
  }

  if (code) {
    return (
      <span className="secret" title="Hides automatically after a minute">
        {code}
      </span>
    );
  }

  return (
    <>
      <button
        className="secret"
        style={{ cursor: 'pointer' }}
        onClick={reveal}
        disabled={loading}
        aria-label="Reveal gate code"
      >
        {loading ? 'checking…' : '•••• show'}
      </button>
      {error && <span style={{ color: 'var(--danger)', fontSize: 13, marginLeft: 8 }}>{error}</span>}
    </>
  );
}
