import { NotYetAvailableError } from './errors.js';
import type { ChargeRequest, ChargeResult, PaymentAdapter } from './types.js';

/**
 * UPI Reserve Pay — the swap point.
 *
 * Reserve Pay is Razorpay's implementation of NPCI's Single Block Multi Debit:
 * the user authorises once, an amount is *blocked* in their own bank account
 * against this merchant, and the merchant debits against that block as goods
 * are delivered — several times, no fresh authentication each time, and the
 * money sits with the user until it is actually drawn.
 *
 * That is a closer match to this system than AutoPay is. The policy engine
 * already reasons in terms of a ceiling and the headroom left under it, which
 * is exactly what a block is. Under AutoPay the same shape is enforced by us;
 * under Reserve Pay the bank enforces it too.
 *
 * It is in closed pilot: activation is per-account and on request, so there is
 * no test-mode path to it today. Everything else in this class exists so that
 * when it opens, this is the only file that changes — `PAYMENT_ADAPTER` moves
 * from `razorpay` to `reserve-pay` and nothing above the adapter seam moves at
 * all. That is the whole argument for having built the interface first.
 *
 * `charge()` throws rather than returning `failed` on purpose. A failed charge
 * means the rail was reached and said no, which is a reconcilable event. This
 * is a misconfiguration: nothing was attempted and there is nothing to
 * reconcile, so it must not reach the ledger looking like a decline.
 */
export class ReservePayAdapter implements PaymentAdapter {
  readonly name = 'reserve-pay';

  async charge(_req: ChargeRequest): Promise<ChargeResult> {
    throw new NotYetAvailableError(
      'UPI Reserve Pay (Single Block Multi Debit) is in closed pilot and not ' +
        'enabled on this account. Select the `razorpay` adapter until it is.',
    );
  }
}
