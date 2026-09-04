import type { MandateRecord } from '../mandates/types.js';

/**
 * Where a payment is.
 *
 * 'awaiting_authorisation' is a mandate-registration order: the provider has
 * an order but no one has authorised it, so nothing has been submitted and no
 * money can move until a person acts. It is not 'created', which means the
 * charge is in flight.
 *
 * 'abandoned' is reachable only by reconciliation, never by a charge or a
 * webhook: it means the provider says this order was never attempted and its
 * authorisation window has closed. Kept distinct from 'failed' because the
 * rail declining a payment and the rail never being asked are different
 * facts, and only one of them is evidence about the customer.
 */
export type ChargeStatus =
  | 'awaiting_authorisation'
  | 'created'
  | 'captured'
  | 'failed'
  | 'abandoned';

export interface ChargeRequest {
  /** Integer paise. Always derived from a verified quote, never from a caller. */
  amountPaise: number;
  mandate: MandateRecord;
  /** Passed through to the provider so a retry cannot double-charge upstream. */
  idempotencyKey: string;
  note: string;
}

/**
 * What an adapter reports back from a charge attempt.
 *
 * 'authorisation_required' is the honest answer to the first charge on a
 * mandate the provider has never seen authorised. An order exists; a payment
 * does not, and cannot until a human authorises the mandate. Reporting it as
 * a charge would mean an agent could tell a user money had moved on the
 * strength of an order id, which is exactly the confusion this avoids.
 */
export type ChargeOutcome = 'authorisation_required' | ChargeStatus;

export interface ChargeResult {
  ref: string;
  status: ChargeOutcome;
  /** Present when status is 'failed'. Safe to show an agent. */
  error?: string;
  /**
   * The provider customer the order was opened against. Carried out of the
   * adapter so the authorisation page can be rendered from the payment row
   * alone, without a second lookup against the provider.
   */
  provider_customer_id?: string;
  /**
   * Why the adapter answered as it did, when the answer was not the obvious
   * one — a registered mandate that had to fall back to asking the payer, say.
   * Recorded in the ledger. Never a substitute for the status.
   */
  provider_note?: string;
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
  /**
   * The mandate token, when the reconciled payment is the one that registered
   * the mandate. A capture the webhook never delivered carries the
   * registration the webhook never delivered, and both have to land.
   */
  tokenRef?: string | null;
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
