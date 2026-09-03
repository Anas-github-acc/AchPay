export type Decision = 'allow' | 'gate' | 'deny';

export interface PolicyConfig {
  per_txn_max_paise: number;
  daily_max_paise: number;
  velocity_max_per_hour: number;
  gate_above_paise: number;
  category_denylist: string[];
  require_mandate_headroom: boolean;
}

/**
 * The only view of a quote the policy engine ever sees.
 *
 * Note what is absent: `title`, `description`, and every other free-text field.
 * The projection in src/policy/project.ts drops them, so the engine cannot read
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
  line_total_paise: number;
}

export type MandateStatus = 'active' | 'revoked' | 'expired';

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

export type RuleId =
  | 'category_denylist'
  | 'mandate_missing'
  | 'mandate_revoked'
  | 'mandate_expired'
  | 'headroom'
  | 'per_txn_max'
  | 'daily_max'
  | 'velocity'
  | 'gate_threshold'
  | 'all_checks_passed';

export interface PolicyDecision {
  decision: Decision;
  /** Always present, including on allow. This is what makes the ledger explainable. */
  rule_id: RuleId;
  reason: string;
  /** The numbers the rule actually compared. Written to the ledger payload. */
  observed: Record<string, number | string>;
}
