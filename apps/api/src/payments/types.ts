import type { MandateRecord } from '../mandates/types.js';

/**
 * Where a payment is.
 *
 * 'abandoned' is reachable only by reconciliation, never by a charge or a
 * webhook: it means the provider says this order was never attempted and its
 * authorisation window has closed. Kept distinct from 'failed' because the
 * rail declining a payment and the rail never being asked are different
 * facts, and only one of them is evidence about the customer.
 */
export type ChargeStatus = 'created' | 'captured' | 'failed' | 'abandoned';

export interface ChargeRequest {
  /** Integer paise. Always derived from a verified quote, never from a caller. */
  amountPaise: number;
  mandate: MandateRecord;
  /** Passed through to the provider so a retry cannot double-charge upstream. */
  idempotencyKey: string;
  note: string;
}

export interface ChargeResult {
  ref: string;
  status: ChargeStatus;
  /** Present when status is 'failed'. Safe to show an agent. */
  error?: string;
}

/**
 * The seam between the policy machinery and whoever actually moves money.
 *
 * Everything upstream of this interface is built and tested with fake money.
 * Swapping in the real provider changes nothing above it — which is the point
 * of defining the interface before the integration exists.
 */
/** What the provider says about an order, asked rather than waited for. */
export interface SettlementView {
  status: ChargeStatus;
  /** The provider's payment id, once one exists. */
  paymentRef: string | null;
  /** Why the reconciler reached that status. Recorded, never shown to an agent. */
  detail: string;
}

export interface PaymentAdapter {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /**
   * Asks the provider what actually became of one order.
   *
   * Optional, and its absence is meaningful: the reclaim sweep will not
   * release a reservation for an adapter that cannot answer this. Releasing
   * headroom on a timer alone would mean guessing that a lost webhook implies
   * a lost payment, and guessing wrong in that direction hands back money that
   * has already left the customer's account.
   */
  reconcile?(orderRef: string): Promise<SettlementView>;
}
