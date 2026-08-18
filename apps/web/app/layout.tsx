import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Lake Champlain Pools',
  description: 'One customer. One timeline. One workflow.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <div className="topbar">
            <h1>Lake Champlain Pools, Spas &amp; Stoves</h1>
            <span className="sub">Phase 1 &middot; customers</span>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
