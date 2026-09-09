'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'achpay_demo_session';
type DemoState = { state: 'login' | 'logout'; user_id: string | null };

export function DemoButton({ className = 'button button--compact' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoState>({ state: 'logout', user_id: null });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setDemo(JSON.parse(stored) as DemoState);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  async function startDemo() {
    setBusy(true);
    try {
      const response = await fetch('/api/demo/session', { method: 'POST' });
      if (!response.ok) throw new Error('Could not start demo');
      const session = (await response.json()) as { user_id: string };
      const next = { state: 'login' as const, user_id: session.user_id };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setDemo(next);
      window.location.href = '/ledger';
    } catch {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    await fetch('/api/demo/session', { method: 'DELETE' }).catch(() => undefined);
    const next = { state: 'logout' as const, user_id: demo.user_id };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setDemo(next);
    setBusy(false);
    window.location.href = '/';
  }

  return (
    demo.state === 'login' ? (
      <button className={className} type="button" onClick={signOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    ) : (
      <button className={className} type="button" onClick={startDemo} disabled={busy}>
        {busy ? 'Starting…' : 'Start demo'}
      </button>
    )
  );
}
