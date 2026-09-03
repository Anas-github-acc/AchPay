import type { RuleId } from '../policy/types.js';
import type { SignedQuote, StaleLineDelta } from '../quotes/types.js';

export interface CheckoutRequest {
  /** Either a quote_id to look up, or the signed quote itself. Never an amount. */
  quote_id?: string;
  quote?: unknown;
  mandate_id: string;
  /** What the user asked for, in their words. Recorded, never evaluated. */
  intent_text?: string;
}

interface Base {
  quote_id: string;
  mandate_id: string;
}

export type CheckoutResult =
  | (Base & {
      status: 'charged';
      amount_paise: number;
      rule_id: RuleId;
      order_ref: string;
      /**
       * Always 'created'. A charge is pending until a webhook settles it;
       * query GET /payments/:order_ref for the reconciled status.
       */
      charge_status: 'created';
      ledger_seq: number;
    })
  | (Base & { status: 'denied'; rule_id: RuleId; reason: string; ledger_seq: number })
  | (Base & {
      status: 'pending_approval';
      amount_paise: number;
      rule_id: RuleId;
      reason: string;
      ledger_seq: number;
    })
  | (Base & {
      status: 'charge_failed';
      amount_paise: number;
      rule_id: RuleId;
      error: string;
      ledger_seq: number;
    })
  | {
      status: 'quote_invalid';
      error: string;
      reason: string;
      deltas?: StaleLineDelta[];
      total_delta_paise?: number;
      /** A freshly priced replacement, so the agent can recover in one hop. */
      new_quote?: SignedQuote;
    };
