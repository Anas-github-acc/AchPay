export interface QuoteLine {
  sku: string;
  title: string;
  /**
   * Catalog category, carried on the quote so the policy engine can apply the
   * denylist without a catalog lookup. It is signed along with everything
   * else, so it cannot be swapped in transit.
   */
  category: string;
  qty: number;
  /** Integer paise, copied from the catalog at signing time. */
  unit_price_paise: number;
  /** unit_price_paise * qty, integer paise. */
  line_total_paise: number;
  /**
   * Median unit price across this line's catalog category, integer paise,
   * computed by the quote service at signing time.
   *
   * It lives on the quote so the policy engine can compare a price against its
   * category without querying anything — the engine stays a pure function of its
   * arguments. And because it is inside the signed payload, a caller cannot
   * inflate the median to make an expensive item look ordinary.
   */
  category_median_paise: number;
}

/** A quote before it is signed. `signature` covers exactly these fields. */
export interface UnsignedQuote {
  quote_id: string;
  /** The shop whose catalog priced this quote. Older quotes may omit it. */
  shop_id?: string;
  currency: 'INR';
  lines: QuoteLine[];
  total_paise: number;
  issued_at: string;
  expires_at: string;
}

/** A quote as it travels: priced from the catalog, signed, and expiring. */
export interface SignedQuote extends UnsignedQuote {
  signature: string;
}
