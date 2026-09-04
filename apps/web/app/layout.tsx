import type { ReactNode } from 'react';
import { NavLink } from './nav-link';
import './globals.css';

export const metadata = {
  title: 'Agent storefront — audit dashboard',
  description: 'Ledger feed, chain verification, mandates and the attack log.',
};

const links = [
  { href: '/security', label: 'Security' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/mandates', label: 'Mandates' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* A link rather than next/font: the demo machine may well be offline,
            and a font that fails to load must fall back rather than fail a build. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap"
        />
      </head>
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">
              <span className="brand-dot" aria-hidden="true" />
              <span>Agent-ready storefront</span>
            </div>
            <nav className="nav" aria-label="Dashboard sections">
              {links.map((link) => (
                <NavLink key={link.href} href={link.href}>
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
