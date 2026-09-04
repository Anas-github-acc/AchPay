import type { MandateRecord } from '../mandates/types.js';

export type ChargeStatus = 'created' | 'captured' | 'failed';

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
export interface PaymentAdapter {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
}
