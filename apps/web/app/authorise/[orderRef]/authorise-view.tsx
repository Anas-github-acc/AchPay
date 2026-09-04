'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '../../../lib/api';
import { formatPaise } from '../../../lib/format';

/**
 * Mandate authorisation, in the browser.
 *
 * What this page can do: open Razorpay's own Checkout against an order the
 * storefront already created, and then poll.
 *
 * What it cannot do, and this is the part that matters: register anything. The
 * mandate becomes usable only when Razorpay sends a signature-verified webhook
 * carrying the token, which the API stores against the mandate the order
 * belongs to. Nothing this page posts back is trusted, because it posts nothing
 * back — a page that could confirm its own authorisation would be a page an
 * agent could drive.
 */

interface AuthorisationLine {
  sku: string;
  title: string;
  qty: number;
  unit_price_paise: number;
  line_total_paise: number;
}

interface Authorisation {
  order_ref: string;
  status: string;
  amount_paise: number;
  currency: string;
  quote_id: string | null;
  mandate_id: string;
  key_id: string | null;
  customer_id: string | null;
  mandate_registered: boolean;
  mandate_max_amount_paise: number | null;
  lines: AuthorisationLine[];
  merchant_name: string;
}

const POLL_MS = 3000;
const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

/** Loads Razorpay's script once, and resolves if it is already present. */
function loadCheckout(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Razorpay Checkout failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Razorpay Checkout failed to load'));
    document.head.appendChild(script);
  });
}

export function AuthoriseView({ orderRef }: { orderRef: string }) {
  const [data, setData] = useState<Authorisation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Authorisation>(`/authorise/${encodeURIComponent(orderRef)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [orderRef]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling until the webhook has done its work. The page never decides
  // it is finished; it waits to be told by the API, which waits to be told by
  // a verified webhook.
  useEffect(() => {
    // Poll while the payment is unsettled; a settled one never changes again.
    if (data && (data.status === 'captured' || data.status === 'failed' || data.status === 'abandoned')) {
      return;
    }
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, data?.status]);

  const open = useCallback(async () => {
    if (!data?.key_id) {
      setNote('This deployment has no Razorpay key configured, so Checkout cannot open.');
      return;
    }
    setOpening(true);
    setNote(null);
    try {
      await loadCheckout();
      if (!window.Razorpay) throw new Error('Razorpay Checkout is unavailable');
      new window.Razorpay({
        key: data.key_id,
        order_id: data.order_ref,
        ...(data.customer_id ? { customer_id: data.customer_id } : {}),
        // Only a registration mints a token. A fallback payment on an
        // already-registered mandate is an ordinary one-off.
        ...(data.mandate_registered ? {} : { recurring: 1 }),
        name: data.merchant_name,
        description: !data.mandate_registered
          ? `Authorise spending up to ${
              data.mandate_max_amount_paise === null
                ? 'the mandate ceiling'
                : formatPaise(data.mandate_max_amount_paise)
            }`
          : `Payment of ${formatPaise(data.amount_paise)}`,
        // Nothing is confirmed here. The handler only stops the spinner; the
        // mandate is registered by the webhook or not at all.
        handler: () => {
          setOpening(false);
          setNote('Authorisation submitted. Waiting for Razorpay to confirm it.');
          void load();
        },
        modal: {
          ondismiss: () => {
            setOpening(false);
            setNote('Authorisation was closed before it finished. Nothing was registered.');
          },
        },
      }).open();
    } catch (err) {
      setOpening(false);
      setNote(err instanceof Error ? err.message : String(err));
    }
  }, [data, load]);

  if (error) {
    return (
      <main className="page" id="main">
        <div className="page-head">
          <div>
            <p className="eyebrow">Mandate</p>
            <h1>Authorisation</h1>
          </div>
        </div>
        <p className="error-banner">{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="page" id="main">
        <p className="dim">Loading…</p>
      </main>
    );
  }

  // What this page shows is decided by the *payment*, not by the mandate.
  // A registered mandate can still land here: if the account cannot debit a
  // token from a server, the adapter falls back to an order the payer
  // confirms, and that order needs this button exactly as a first one does.
  const settled = data.status === 'captured';
  const dead = data.status === 'failed' || data.status === 'abandoned';
  const pending = !settled && !dead;
  const registering = !data.mandate_registered;

  return (
    <main className="page authorise-stack" id="main">
      <div className="page-head">
        <div>
          <p className="eyebrow">{registering ? 'One-time setup' : 'Confirm payment'}</p>
          <h1>{registering ? 'Authorise this mandate' : 'Confirm this purchase'}</h1>
          <p>
            {registering
              ? 'An agent is asking to spend on your behalf. Approving here registers the mandate with Razorpay once — after this, purchases inside the limits happen without you, and every one of them lands in the ledger.'
              : 'This mandate is already authorised, but this payment could not be taken automatically, so it needs your confirmation. The amount and the basket below are the ones the policy already approved.'}
          </p>
        </div>
      </div>

      <section className="card">
        <h2>The purchase</h2>
        <table className="ledger">
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.sku}>
                <td>
                  {line.title}
                  <br />
                  <span className="dim mono">
                    {line.sku} · {line.qty} × {formatPaise(line.unit_price_paise)}
                  </span>
                </td>
                <td className="amount">{formatPaise(line.line_total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="total-row">
          <span>Total</span>
          <strong className="amount">{formatPaise(data.amount_paise)}</strong>
        </p>
        {registering && data.mandate_max_amount_paise !== null && (
          <p className="dim">
            You are also authorising future purchases up to{' '}
            {formatPaise(data.mandate_max_amount_paise)}, inside the spending policy.
          </p>
        )}
      </section>

      {settled ? (
        <section className="card card--ok">
          <h2>Paid</h2>
          <p>
            Razorpay confirmed this payment.
            {data.mandate_registered
              ? ' The mandate is registered, so the agent can spend inside the policy without asking you again.'
              : ' The mandate was not registered by it, so a future purchase may ask you once more.'}
          </p>
        </section>
      ) : dead ? (
        <section className="card card--bad">
          <h2>Not registered</h2>
          <p>
            This authorisation ended as <span className="mono">{data.status}</span>. Nothing was
            charged and no mandate was registered. Ask the agent to start again.
          </p>
        </section>
      ) : (
        <section className="card">
          <h2>{registering ? 'Authorise' : 'Confirm this payment'}</h2>
          <p className="dim">
            Opens Razorpay. Nothing is settled until Razorpay confirms it back to this storefront —
            this page cannot confirm itself.
          </p>
          <button className="button" onClick={() => void open()} disabled={opening}>
            {opening
              ? 'Waiting for Razorpay…'
              : registering
                ? 'Authorise with Razorpay'
                : 'Pay with Razorpay'}
          </button>
          {note && <p className="dim">{note}</p>}
        </section>
      )}

      <section className="card">
        <h2>Details</h2>
        <dl className="detail-list">
          <dt>Status</dt>
          <dd className="mono">{data.status}</dd>
          <dt>Order</dt>
          <dd className="mono">{data.order_ref}</dd>
          <dt>Mandate</dt>
          <dd className="mono">{data.mandate_id}</dd>
          {data.quote_id && (
            <>
              <dt>Quote</dt>
              <dd className="mono">{data.quote_id}</dd>
            </>
          )}
        </dl>
      </section>
    </main>
  );
}
