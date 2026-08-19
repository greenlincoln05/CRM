'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker that makes /tech open without signal.
 *
 * Kept as its own component so the app shell stays server-rendered and this is
 * the only thing that needs to be a client component for it.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch((err) => console.warn('[sw] registration failed', err));
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);

  return null;
}
