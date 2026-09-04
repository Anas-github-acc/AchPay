export type Decision = 'allow' | 'gate' | 'deny';

export type RuleId =
  | 'category_denylist'
  | 'max_qty_per_sku'
  | 'max_line_items'
  | 'category_median_multiple'
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
