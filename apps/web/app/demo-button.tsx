'use client';

import { useState } from 'react';

export function DemoButton({ className = 'button button--compact' }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  async function startDemo() {
    setBusy(true);
    try {
      const response = await fetch('/api/demo/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client' }),
      });
      if (!response.ok) throw new Error('Could not start demo');
      await response.json();
      window.location.href = '/ledger';
    } catch {
      setBusy(false);
    }
  }

  return (
    <button className={className} type="button" onClick={startDemo} disabled={busy}>
      {busy ? 'Starting…' : 'Try Demo'}
    </button>
  );
}
