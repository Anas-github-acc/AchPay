import type { ReactNode } from 'react';
import Link from 'next/link';
import { BrandMark } from './brand-mark';
import './globals.css';
import { AuthProvider } from './auth/auth-provider';
import { AuthStatus } from './auth/auth-status';
import { RoleNav } from './role-nav';

export const metadata = {
  title: 'AchPay — Agentic Commerce Hub for secure AI payments',
  description:
    'AchPay gives an AI agent a wallet it cannot misuse: signed quotes, a pure policy engine, human approval and a hash-chained ledger.',
};

/* viewportFit: 'cover' is what lets the tab bar and the header pad themselves
   against the notch and the home indicator with env(safe-area-inset-*). */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
  themeColor: '#f4f3ee',
};

/** `short` is the tab-bar label: four of these sit side by side on a 360px phone. */
const links = [
  { href: '/shops', label: 'Shops', short: 'Shops' },
  { href: '/security', label: 'Attack log', short: 'Attacks' },
  { href: '/ledger', label: 'Ledger', short: 'Ledger' },
  { href: '/mandates', label: 'Mandates', short: 'Mandates' },
  { href: '/lab', label: 'Agent Lab', short: 'Lab' },
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
          <AuthProvider>
            <header className="topbar">
              <Link href="/" className="brand" aria-label="AchPay — home">
                <BrandMark />
                <span className="brand-name">
                  <strong>AchPay</strong>
                </span>
                <span className="brand-tag">Agentic Commerce Hub</span>
              </Link>
              <RoleNav links={links} />
              <AuthStatus />
            </header>
            {children}
          </AuthProvider>
          <footer className="site-foot">
            <span>AchPay — an agentic commerce hub for secure AI payments.</span>
            <span className="mono">every amount is an integer number of paise</span>
          </footer>
          {/* The phone navigation. Four sections, always all four visible, no
              hamburger — the same rule the desktop nav follows, moved to the
              thumb. Hidden above 640px, where .nav does the job. */}
          <RoleNav links={links} mobile />
        </div>
      </body>
    </html>
  );
}
