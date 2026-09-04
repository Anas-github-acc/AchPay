import type { ReactNode } from 'react';

export const metadata = {
  title: 'Agent storefront',
  description: 'Ledger feed, chain verification and the adversarial grid.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
