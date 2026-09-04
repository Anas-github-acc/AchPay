import { withTransaction } from '../db/pool.js';
import { append } from '../ledger/ledger.js';
import { releaseUsed } from '../mandates/repo.js';
import { getPayment, settlePayment, staleReservations } from './repo.js';
import type { PaymentRecord } from './repo.js';
import type { PaymentAdapter, SettlementView } from './types.js';

/**
 * Reclaiming headroom from payments that stopped happening.
 *
 * checkout books used_paise the moment the rail accepts a charge, and a
 * webhook is what normally releases or confirms that booking. The gap this
 * closes is the payment that never reaches a webhook at all: a UPI mandate
 * order nobody authorises is never attempted, so it is never captured and
 * never declined. It simply stops, and without this the reservation behind it
 * stops with it — permanently.
 *
 * The clock decides *when to ask*, never *what the answer is*. Every release
 * here is on the provider's word that the order was not attempted. Releasing
 * on elapsed time alone would mean treating a lost webhook as a lost payment,
 * and that is the one direction this must never get wrong: it would hand back
 * headroom for money that already left the customer's account.
 */

/** How long a reservation may sit unsettled before the sweep asks about it. */
export const RECLAIM_AFTER_MS = 15 * 60_000;

/** A ceiling on one sweep, so a backlog cannot turn into a long transaction. */
const BATCH = 50;

export interface ReclaimOutcome {
  order_ref: string;
  status: SettlementView['status'];
  released_paise?: number;
  detail: string;
}

export interface ReclaimSummary {
  examined: number;
  released: ReclaimOutcome[];
  settled: ReclaimOutcome[];
  unchanged: ReclaimOutcome[];
  errors: { order_ref: string; reason: string }[];
}

export async function reclaimStaleReservations(
  adapter: PaymentAdapter,
  olderThanMs: number = RECLAIM_AFTER_MS,
): Promise<ReclaimSummary> {
  const summary: ReclaimSummary = {
    examined: 0,
    released: [],
    settled: [],
    unchanged: [],
    errors: [],
  };

  // An adapter with no reconcile cannot produce evidence, and this function
  // does not act without evidence. Returning empty is the correct behaviour,
  // not a degraded one.
  if (!adapter.reconcile) return summary;

  const stale = await staleReservations(olderThanMs, BATCH);
  summary.examined = stale.length;

  for (const payment of stale) {
    try {
      // Asked outside the transaction: it is a network call, and holding a
      // mandate row locked across one would block every checkout for that
      // user until Razorpay answered.
      const view = await adapter.reconcile(payment.order_ref);
      const outcome = await apply(payment, view);
      if (!outcome) {
        summary.unchanged.push({
          order_ref: payment.order_ref,
          status: view.status,
          detail: view.detail,
        });
      } else if (view.status === 'abandoned') {
        summary.released.push(outcome);
      } else {
        summary.settled.push(outcome);
      }
    } catch (err) {
      // One unreachable order must not stop the sweep. It stays `created` and
      // the next sweep asks again.
      summary.errors.push({
        order_ref: payment.order_ref,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/**
 * Applies one reconciliation, in the transaction that also moves the mandate.
 *
 * Re-reads the payment under the transaction before writing: the sweep asked
 * the provider without a lock, and a webhook may have landed in the meantime.
 * settlePayment's own `where status = any(...)` is the second guard — if the
 * row already moved, nothing here writes and nothing is double-counted.
 */
async function apply(
  payment: PaymentRecord,
  view: SettlementView,
): Promise<ReclaimOutcome | undefined> {
  // 'created' means the provider says this is still in flight. Nothing to do.
  if (view.status === 'created') return undefined;
  const terminal: Exclude<SettlementView['status'], 'created'> = view.status;

  return withTransaction(async (tx) => {
    const current = await getPayment(payment.order_ref, tx);
    if (!current || current.status !== 'created') return undefined;

    const settled = await settlePayment(payment.order_ref, terminal, view.paymentRef, tx);
    if (!settled) return undefined;

    // 'abandoned' gives the reservation back; a capture the webhook missed
    // keeps it, and 'failed' releases it for the same reason a webhook
    // failure does.
    const released = terminal === 'abandoned' || terminal === 'failed';
    const mandate = released
      ? await releaseUsed(current.mandate_id, current.amount_paise, tx)
      : undefined;

    await append(
      {
        actor: 'system',
        event_type: 'webhook',
        quote_id: current.quote_id,
        amount_paise: current.amount_paise,
        razorpay_ref: current.order_ref,
        payload: {
          // Not a delivery. The row says so, so nobody reading the ledger
          // mistakes a reconciliation for something the provider sent us.
          event: 'reconciliation',
          source: 'reclaim_sweep',
          order_ref: current.order_ref,
          payment_ref: view.paymentRef,
          mandate_id: current.mandate_id,
          matched: true,
          status: settled.status,
          applied: true,
          detail: view.detail,
          ...(released
            ? {
                released_paise: current.amount_paise,
                mandate_used_paise: mandate?.used_paise ?? null,
              }
            : {}),
        },
      },
      tx,
    );

    return {
      order_ref: current.order_ref,
      status: terminal,
      ...(released ? { released_paise: current.amount_paise } : {}),
      detail: view.detail,
    };
  });
}
