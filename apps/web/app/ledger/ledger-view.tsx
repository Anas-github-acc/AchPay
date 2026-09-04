'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LedgerRow, VerifyChainResult } from '@storefront/shared';
import { apiGet, ApiError } from '../../lib/api';
import { formatPaise, formatTime } from '../../lib/format';

const POLL_MS = 3000;

interface LedgerResponse {
  rows: LedgerRow[];
  count: number;
}

export function LedgerView() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [chain, setChain] = useState<VerifyChainResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await apiGet<LedgerResponse>('/ledger?limit=100');
        if (cancelled) return;
        // Newest first: on a projector the interesting row is the one that just
        // landed, and nobody wants to watch a table scroll.
        setRows([...data.rows].sort((a, b) => b.seq - a.seq));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      setChain(await apiGet<VerifyChainResult>('/ledger/verify'));
    } catch (err) {
      setChain(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, []);

  return (
    <>
      <div className="ledger-tools" style={{ marginBottom: 'var(--space-5)' }}>
        <button className="button" onClick={() => void verify()} disabled={verifying}>
          {verifying ? 'Verifying chain…' : 'Verify ledger'}
        </button>

        {chain !== null && (
          <output className={`chain-result ${chain.ok ? 'chain-result--ok' : 'chain-result--broken'}`}>
            {chain.ok ? (
              <>Chain intact — {chain.rows_checked} rows verified</>
            ) : (
              <>
                Chain broken at seq {chain.broken_at_seq} — {chain.reason.replace(/_/g, ' ')}
              </>
            )}
          </output>
        )}

        <span className="chip" style={{ marginLeft: 'auto' }}>
          <span className="live-dot" aria-hidden="true" /> live · {rows.length} rows · every{' '}
          {POLL_MS / 1000}s
        </span>
      </div>

      {chain !== null && !chain.ok && <div className="error-banner">{chain.detail}</div>}
      {error !== null && <div className="error-banner">{error}</div>}

      {loaded && rows.length === 0 && !error ? (
        <p className="empty">
          The ledger is empty. Run a checkout — allowed, gated or denied — and the row appears here
          within {POLL_MS / 1000} seconds.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Intent</th>
                <th scope="col">Decision</th>
                <th scope="col">Rule</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Amount
                </th>
                <th scope="col">Razorpay ref</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.seq} className={row.decision ? `row--${row.decision}` : undefined}>
                  <td className="mono dim">
                    {formatTime(row.ts)}
                    <span style={{ marginLeft: 8 }}>#{row.seq}</span>
                  </td>
                  <td>{row.actor}</td>
                  <td className="intent" title={row.intent_text ?? undefined}>
                    {row.intent_text ?? <span className="dim">{row.event_type}</span>}
                  </td>
                  <td>
                    <span className={`decision decision--${row.decision ?? 'none'}`}>
                      {row.decision ?? row.event_type}
                    </span>
                  </td>
                  <td className="mono">{row.rule_id ?? <span className="dim">—</span>}</td>
                  <td className="amount">{formatPaise(row.amount_paise)}</td>
                  <td className="mono dim">{row.razorpay_ref ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
