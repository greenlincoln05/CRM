import type { Metadata, Viewport } from 'next';
import './tech.css';

export const metadata: Metadata = {
  title: 'LCP Tech',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'LCP Tech' },
};

export const viewport: Viewport = {
  themeColor: '#0f1216',
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled deliberately: technicians squint at serial numbers, and
  // disabling pinch-zoom to make an app feel "native" is an accessibility
  // regression, not a polish item.
  maximumScale: 5,
};

export default function TechLayout({ children }: { children: React.ReactNode }) {
  return <div className="t-root">{children}</div>;
}
