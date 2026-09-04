'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LedgerRow, VerifyChainResult } from '@storefront/shared';
import { apiGet, ApiError } from '../../lib/api';
import { formatPaise, formatTime } from '../../lib/format';

const POLL_MS = 3000;

/**
 * A gate the approval page already cleared. The policy engine re-evaluates on
 * the approved run and returns `gate` again — the amount did not change — so
 * without this marker the row above the charge reads as an ignored gate.
 */
function authorisedByHuman(row: LedgerRow): boolean {
  if (row.decision !== 'gate') return false;
  const payload = row.payload as { authorised_by?: string } | null | undefined;
  return payload?.authorised_by === 'human_approved';
}


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

  /* Which rows are open. Only the phone layout collapses anything — the table
     shows every column at once — so this set is inert above 640px. */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const toggle = useCallback((seq: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }, []);

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
      <div className="ledger-tools">
        <button className="button button--secondary" onClick={() => void verify()} disabled={verifying}>
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

        <span className="chip ledger-live">
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
              {rows.map((row) => {
                const isOpen = open.has(row.seq);
                const intent = row.intent_text ?? row.event_type;
                return (
                  <tr
                    key={row.seq}
                    className={row.decision ? `row--${row.decision}` : undefined}
                    data-open={isOpen ? '' : undefined}
                  >
                    <td data-label="Time" data-role="detail" className="mono dim">
                      <span>
                        {formatTime(row.ts)} · #{row.seq}
                      </span>
                    </td>
                    <td data-label="Actor" data-role="detail">{row.actor}</td>
                    <td data-label="Intent" data-role="intent" className="intent" title={row.intent_text ?? undefined}>
                      {/* Covers the whole card on a phone, so the tap target is
                          the row rather than a chevron. display:none on desktop. */}
                      <button
                        type="button"
                        className="row-toggle"
                        aria-expanded={isOpen}
                        aria-label={`${intent} — ${formatPaise(row.amount_paise)}. Show time, actor, rule and payment reference.`}
                        onClick={() => toggle(row.seq)}
                      />
                      {row.intent_text ?? <span className="dim intent-fallback">{row.event_type}</span>}
                    </td>
                    <td data-label="Decision" data-role="decision">
                      <span className={`decision decision--${row.decision ?? 'none'}`}>
                        {row.decision ?? row.event_type}
                      </span>
                      {authorisedByHuman(row) && (
                        <span className="decision-note" title="A human approved this gate before it charged">
                          cleared
                        </span>
                      )}
                    </td>
                    <td data-label="Rule" data-role="detail" className="mono">
                      {row.rule_id ?? <span className="dim">—</span>}
                    </td>
                    <td data-label="Amount" data-role="amount" className="amount">
                      {formatPaise(row.amount_paise)}
                    </td>
                    <td data-label="Razorpay" data-role="detail" className="mono dim">
                      {row.razorpay_ref ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
