'use client';

import { useState } from 'react';
import { supabaseBrowser } from '../../lib/supabase';

export function AuthPanel({ merchant = false, nextPath }: { merchant?: boolean; nextPath?: string }) {
  const [busy, setBusy] = useState<'google' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function continueWithGoogle() {
    setBusy('google');
    setError(null);
    try {
      const next = nextPath ?? (merchant ? '/shops' : '/ledger');
      const role = merchant ? 'merchant' : 'client';
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}&role=${role}`;
      const { error: authError } = await supabaseBrowser().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (authError) throw authError;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in.');
      setBusy(null);
    }
  }

  async function continueAsDemo() {
    setBusy('demo');
    setError(null);
    try {
      const response = await fetch('/api/demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: merchant ? 'merchant' : 'client' }) });
      if (!response.ok) throw new Error('Could not start the demo account');
      window.location.href = merchant ? '/shops' : '/ledger';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the demo account.');
      setBusy(null);
    }
  }

  return (
    <div className="auth-panel">
      <button className="button auth-google" type="button" onClick={() => void continueWithGoogle()} disabled={busy !== null}>
        <span className="google-mark" aria-hidden="true">G</span>
        {busy === 'google' ? 'Opening Google…' : merchant ? 'Register with Google' : 'Continue with Google'}
      </button>
      <div className="auth-divider"><span>or</span></div>
      <button className="button button--secondary auth-demo" type="button" onClick={() => void continueAsDemo()} disabled={busy !== null}>
        {busy === 'demo' ? 'Signing in…' : 'Sign in as demo user'}
      </button>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </div>
  );
}
