import type { ChargeStatus } from '../payments/types.js';
import type { SignedQuote } from '../quotes/types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** One parked purchase, exactly as the table holds it. */
export interface PendingApproval {
  token: string;
  quote_id: string;
  mandate_id: string;
  amount_paise: number;
  /** The policy rule that gated it. Engine-produced, never caller-supplied. */
  rule_id: string;
  reason: string;
  /** The signed quote as it was priced at gate time. */
  quote: SignedQuote;
  status: ApprovalStatus;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  order_ref: string | null;
  charge_error: string | null;
  /** seq of the ledger row that recorded the gate. */
  gate_seq: number | null;
}

/**
 * What GET /approvals/:token answers, and what the agent's get_order_status
 * relays. Two axes, kept separate on purpose:
 *
 *   status         — where the human is: pending, approved, rejected, expired
 *   payment_status — where the money is: created, captured, failed, abandoned
 *
 * Collapsing them would let "approved" read as "paid", and an approval is not
 * a payment. payment_status is absent until a charge has actually been booked.
 */
export interface ApprovalStatusView {
  approval_token: string;
  approval_url: string;
  status: ApprovalStatus;
  quote_id: string;
  mandate_id: string;
  amount_paise: number;
  rule_id: string;
  reason: string;
  expires_at: string;
  decided_at: string | null;
  order_ref: string | null;
  payment_status: ChargeStatus | null;
  charge_error: string | null;
}
