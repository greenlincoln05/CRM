import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Lake Champlain Pools',
  description: 'One customer. One timeline. One workflow.',
};

/**
 * Root layout only.
 *
 * The counter chrome lives in (office)/layout.tsx and the technician app has
 * its own, so this deliberately renders nothing but the document. Anything
 * added here lands on both, including the phone in a truck bed.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
