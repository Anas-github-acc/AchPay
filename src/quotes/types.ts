export interface QuoteLine {
  sku: string;
  title: string;
  qty: number;
  /** Integer paise, copied from the catalog at signing time. */
  unit_price_paise: number;
  /** unit_price_paise * qty, integer paise. */
  line_total_paise: number;
}

/** A quote before it is signed. `signature` covers exactly these fields. */
export interface UnsignedQuote {
  quote_id: string;
  currency: 'INR';
  lines: QuoteLine[];
  total_paise: number;
  issued_at: string;
  expires_at: string;
}

export interface SignedQuote extends UnsignedQuote {
  signature: string;
}

export interface QuoteRequestItem {
  sku: string;
  qty: number;
}

export type QuoteFailureCode =
  | 'QUOTE_MALFORMED'
  | 'QUOTE_SIGNATURE_INVALID'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_STALE'
  | 'QUOTE_NOT_FOUND';

export interface StaleLineDelta {
  sku: string;
  quoted_unit_price_paise: number;
  current_unit_price_paise: number;
  /** current - quoted, in paise. Negative means the price dropped. */
  delta_paise: number;
}

export type VerifyQuoteResult =
  | { ok: true; quote: SignedQuote }
  | {
      ok: false;
      code: QuoteFailureCode;
      reason: string;
      /** Present on QUOTE_STALE: which lines drifted and by how much. */
      deltas?: StaleLineDelta[];
      /** Present on QUOTE_STALE: total drift in paise across the quote. */
      total_delta_paise?: number;
    };
