import type { ReactNode } from 'react';
import Link from 'next/link';
import { NavLink } from './nav-link';
import { BrandMark } from './brand-mark';
import './globals.css';

export const metadata = {
  title: 'AchPay — Agentic Commerce Hub for secure AI payments',
  description:
    'AchPay gives an AI agent a wallet it cannot misuse: signed quotes, a pure policy engine, human approval and a hash-chained ledger.',
};

const links = [
  { href: '/security', label: 'Attack log' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/mandates', label: 'Mandates' },
  { href: '/lab', label: 'Agent Lab' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* A link rather than next/font: the demo machine may well be offline,
            and a font that fails to load must fall back rather than fail a build.
            Source Serif stands in for Tiempos Headline, Georgia behind it. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap"
        />
      </head>
      <body>
        <div className="shell">
          <a className="skip-link" href="#main">
            Skip to content
          </a>
          <header className="topbar">
            <Link href="/" className="brand" aria-label="AchPay — home">
              <BrandMark />
              <span className="brand-name">
                <strong>AchPay</strong>
              </span>
              <span className="brand-tag">Agentic Commerce Hub</span>
            </Link>
            <nav className="nav" aria-label="Sections">
              {links.map((link) => (
                <NavLink key={link.href} href={link.href}>
                  {link.label}
                </NavLink>
              ))}
            </nav>
          </header>
          {children}
          <footer className="site-foot">
            <span>AchPay — an agentic commerce hub for secure AI payments.</span>
            <span className="mono">every amount is an integer number of paise</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
