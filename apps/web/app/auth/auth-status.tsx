'use client';

import { useAuth } from './auth-provider';
import Link from 'next/link';

export function AuthStatus() {
  const auth = useAuth();
  if (!auth.isAuthenticated) return <Link className="button button--compact nav-try" href="/auth/sign-in">Sign in</Link>;

  async function signOut() {
    await fetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
    localStorage.removeItem('achpay_demo_session');
    window.location.href = '/';
  }

  return <button className="button button--compact nav-try" type="button" onClick={() => void signOut()}>Sign out</button>;
}
