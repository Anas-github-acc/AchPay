export type LedgerActor = 'agent' | 'user' | 'system';
export type LedgerEventType = 'decision' | 'charge' | 'webhook';
export type LedgerDecision = 'allow' | 'gate' | 'deny';

/** The caller-supplied part of a ledger row. seq/ts/hashes are assigned by append(). */
export interface LedgerEventInput {
  event_id?: string;
  actor: LedgerActor;
  event_type: LedgerEventType;
  intent_text?: string | null;
  quote_id?: string | null;
  decision?: LedgerDecision | null;
  rule_id?: string | null;
  /** Integer paise. */
  amount_paise?: number | null;
  razorpay_ref?: string | null;
  payload?: unknown;
}

export interface LedgerRow {
  seq: number;
  event_id: string;
  ts: string;
  actor: LedgerActor;
  event_type: LedgerEventType;
  intent_text: string | null;
  quote_id: string | null;
  decision: LedgerDecision | null;
  rule_id: string | null;
  amount_paise: number | null;
  razorpay_ref: string | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export type VerifyChainResult =
  | { ok: true; rows_checked: number }
  | {
      ok: false;
      /** The seq of the first row that does not match the chain. */
      broken_at_seq: number;
      reason: 'hash_mismatch' | 'prev_hash_mismatch' | 'missing_row';
      detail: string;
      rows_checked: number;
    };
