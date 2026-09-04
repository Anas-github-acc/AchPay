'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A nav item that knows whether it is the current page, for aria-current. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={current ? 'page' : undefined}>
      {children}
    </Link>
  );
}
