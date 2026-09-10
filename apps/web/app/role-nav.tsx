'use client';

import { NavLink } from './nav-link';
import { useAuth } from './auth/auth-provider';

type NavItem = { href: string; label: string; short: string };

export function RoleNav({ links, mobile = false }: { links: NavItem[]; mobile?: boolean }) {
  const auth = useAuth();
  const visible = links.filter((link) => {
    if (link.href === '/shops') return auth.role === 'merchant';
    if (link.href === '/ledger' || link.href === '/mandates') return auth.role === 'client';
    return true;
  });

  return (
    <nav className={mobile ? 'tabbar' : 'nav'} aria-label="Sections">
      {visible.map((link) => (
        <NavLink key={link.href} href={link.href} className={mobile ? 'tabbar-link' : undefined}>
          {mobile ? link.short : link.label}
        </NavLink>
      ))}
    </nav>
  );
}
