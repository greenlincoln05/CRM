'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { NAV, sectionForPath, type Section } from '@/lib/nav';

/**
 * The icon rail and section panel. Client-side only because active-state
 * needs usePathname; everything it renders comes from the NAV data.
 * Icons are inline SVG — nothing loads from a third-party host.
 */

const ICONS: Record<string, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.6a3.2 3.2 0 1 1 0 4.9M16.2 14.3c2 .5 3.4 2.1 3.9 4.7" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  wrench: <path d="M14.7 6.5a4.2 4.2 0 0 0 5.6-5l-3 3-2.8-.8-.8-2.8 3-3a4.2 4.2 0 0 0-5 5.6L4 11.2a2.3 2.3 0 1 0 3.2 3.2l7.5-7.9Z" transform="translate(1.5 4.5)" />,
  box: <><path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2V8.2Z" /><path d="M4 8.2 12 12l8-3.8M12 12v8" /></>,
  cart: <><circle cx="9.5" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /><path d="M3.5 4.5h2.5l2.2 10.5h9.6l2.2-8H7" /></>,
  dollar: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.7 9.2c-.6-1-1.6-1.4-2.7-1.4-1.4 0-2.5.7-2.5 1.9 0 2.7 5.4 1.3 5.4 4 0 1.3-1.2 2-2.9 2-1.2 0-2.3-.5-2.9-1.5" /></>,
  chart: <path d="M4.5 19.5v-6.5M10 19.5V8M15.5 19.5v-9.5M21 19.5V4.5M3 19.5h18.5" />,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M18 6l-1.7 1.7M7.7 16.3 6 18M18 18l-1.7-1.7M7.7 7.7 6 6" /></>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.2" /><path d="M10.5 18.5h3" /></>,
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

export default function OfficeNav({ sections }: { sections: Section[] }) {
  const pathname = usePathname();
  const active = sectionForPath(pathname);

  // "/" focuses the global search from anywhere, unless typing already.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const main = sections.filter((s) => s.key !== 'settings');
  const settings = sections.find((s) => s.key === 'settings');

  return (
    <>
      <nav className="o-rail" aria-label="Sections">
        <div className="o-logo" title="Lake Champlain Pools, Spas & Stoves">C</div>
        {main.map((s) => (
          <a key={s.key} href={s.href} className="o-item"
            data-active={active?.key === s.key ? 'true' : undefined}>
            <Icon name={s.icon} />{s.label}
          </a>
        ))}
        <div className="o-spacer" />
        {settings && (
          <a href={settings.href} className="o-item"
            data-active={active?.key === 'settings' ? 'true' : undefined}>
            <Icon name={settings.icon} />{settings.label}
          </a>
        )}
        <div className="o-sep" />
        <a href="/tech" className="o-item" title="Opens the technician app">
          <Icon name="phone" />Tech app
        </a>
      </nav>

      {active?.subsections?.length ? (
        <nav className="o-panel" aria-label="Section pages">
          <>
            <h2>{active.label}</h2>
            {active.subsections.map((sub) => (
              <a key={sub.href} href={sub.href}
                data-active={
                  (pathname === sub.href
                    || (sub.href !== '/' && pathname.startsWith(sub.href + '/'))
                    || (sub.href === '/customers' && pathname.startsWith('/customers/') && !pathname.startsWith('/customers/new')))
                    ? 'true' : undefined
                }>
                {sub.label}
                {sub.status !== 'built' && <span className="chip planned">planned</span>}
              </a>
            ))}
          </>
        </nav>
      ) : null}
    </>
  );
}
