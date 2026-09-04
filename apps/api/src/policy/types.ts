import type { MandateStatus } from '@storefront/shared';

export type { Decision, MandateStatus, PolicyDecision, RuleId } from '@storefront/shared';

export interface PolicyConfig {
  per_txn_max_paise: number;
  daily_max_paise: number;
  velocity_max_per_hour: number;
  gate_above_paise: number;
  category_denylist: string[];
  require_mandate_headroom: boolean;
  /** Most units of any single sku one transaction may contain. */
  max_qty_per_sku: number;
  /** Most distinct skus one transaction may contain. */
  max_line_items: number;
  /**
   * A unit price above this multiple of its category median needs a human look.
   * A ratio, not money, so it may be fractional — see evaluate() for how it is
   * compared without a float ever touching a paise amount.
   */
  gate_if_price_above_category_median_multiple: number;
}

/**
 * The only view of a quote the policy engine ever sees.
 *
 * Note what is absent: `title`, `description`, and every other free-text field.
 * The projection in project.ts drops them, so the engine cannot read
 * attacker-influenced prose even by accident. This is the prompt-injection
 * defence, and it is structural rather than a matter of discipline.
 */
export interface PolicyQuote {
  quote_id: string;
  total_paise: number;
  lines: PolicyQuoteLine[];
}

export interface PolicyQuoteLine {
  sku: string;
  category: string;
  qty: number;
  unit_price_paise: number;
  line_total_paise: number;
  /**
   * Median unit price for this line's category, stamped onto the quote by the
   * quote service and covered by the quote signature. The engine reads it; it
   * never computes it, because computing it would mean reaching for the catalog.
   */
  category_median_paise: number;
}

export interface PolicyMandate {
  id: string;
  status: MandateStatus;
  /** Ceiling for the mandate's whole life, integer paise. */
  max_amount_paise: number;
  /** Already spent against this mandate, integer paise. */
  used_paise: number;
  expires_at: string;
}

/** One prior charge against this mandate, read from the ledger by the caller. */
export interface HistoryEntry {
  ts: string;
  amount_paise: number;
}

export interface PolicyInput {
  quote: PolicyQuote;
  mandate: PolicyMandate | null | undefined;
  /**
   * Prior successful charges for this mandate. Passed in, never queried — that
   * is what keeps evaluate() a pure function.
   */
  history: HistoryEntry[];
  /** Evaluation time. Passed in so the function is deterministic in tests. */
  now?: Date;
  /** Defaults to the policy.yaml loaded at boot. */
  policy?: PolicyConfig;
}
