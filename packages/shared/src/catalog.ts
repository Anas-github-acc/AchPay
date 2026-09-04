/**
 * Trust tier for a catalog item.
 *
 * `verified` means a human put this row in the catalog. `unverified` means it
 * arrived from somewhere less trustworthy — a supplier feed, a merchant upload,
 * anything that an attacker might be able to write to. Unverified items are
 * still sellable; they just do not get to speak free text to an agent.
 */
export type ProductSource = 'verified' | 'unverified';

/** A catalog row as it appears in data/catalog.json, before sanitisation. */
export interface RawProduct {
  sku: string;
  title: string;
  price_paise: number;
  stock: number;
  category: string;
  description?: string;
  /** Defaults to 'verified' when absent. */
  source?: ProductSource;
}

export interface Product extends RawProduct {
  /** Always resolved by the ingest sanitiser; never left to a caller's guess. */
  source: ProductSource;
  /**
   * Set by the ingest sanitiser when a field contained instruction-shaped text.
   * A flagged item keeps trading — only its free text is withheld.
   */
  flagged: boolean;
  /**
   * Free text. Never read by the policy engine (see apps/api/src/policy), and
   * returned to a caller only via GET /products/:sku/details, and only when the
   * item is both verified and unflagged. Treated as untrusted content
   * throughout.
   */
  description?: string;
}
