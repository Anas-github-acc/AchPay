import type { PaymentAdapter } from './types.js';
import { RECLAIM_AFTER_MS, reclaimStaleReservations } from './reclaim.js';

/** How often the sweep runs. Independent of how old a row must be to qualify. */
const EVERY_MS = 5 * 60_000;

/**
 * Runs the reclaim sweep on an interval for as long as the process lives.
 *
 * In-process and unscheduled by anything fancier because the work is idempotent
 * and cheap: it reconciles the same rows again if a run is missed, and a
 * duplicate run writes nothing the first did not. If this grows a second
 * instance, the sweep still holds — every write is guarded by
 * `settlePayment`'s status predicate, so two sweeps racing settle once.
 *
 * `unref` so a dev server still exits on Ctrl-C rather than waiting on a timer.
 */
export function startReclaimLoop(adapter: PaymentAdapter): () => void {
  if (!adapter.reconcile) return () => {};

  const timer = setInterval(() => {
    void reclaimStaleReservations(adapter, RECLAIM_AFTER_MS)
      .then((summary) => {
        if (summary.released.length > 0 || summary.settled.length > 0) {
          console.log(
            `[reclaim] released ${summary.released.length}, settled ${summary.settled.length}` +
              ` of ${summary.examined} stale reservation(s)`,
          );
        }
        for (const err of summary.errors) {
          console.warn(`[reclaim] ${err.order_ref}: ${err.reason}`);
        }
      })
      .catch((err: unknown) => {
        // A sweep that throws must not take the process with it. The next one
        // sees the same rows.
        console.warn('[reclaim] sweep failed:', err instanceof Error ? err.message : err);
      });
  }, EVERY_MS);

  timer.unref();
  return () => clearInterval(timer);
}
