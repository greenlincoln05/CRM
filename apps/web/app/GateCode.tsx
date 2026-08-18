'use client';

import { useState } from 'react';

/**
 * Gate and lockbox codes are masked until deliberately revealed.
 *
 * ADR 0003: this database holds the means of physical entry to several hundred
 * homes. Nobody should be able to shoulder-surf a code off a screen that
 * happened to be left open, and a reveal is the hook the access log will hang
 * on once auth exists.
 */
export default function GateCode({ code }: { code: string }) {
  const [shown, setShown] = useState(false);

  if (shown) return <span className="secret">{code}</span>;

  return (
    <button
      className="secret"
      style={{ cursor: 'pointer' }}
      onClick={() => setShown(true)}
      aria-label="Reveal gate code"
    >
      •••• show
    </button>
  );
}
