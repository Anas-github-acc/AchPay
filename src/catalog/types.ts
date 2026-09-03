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
   * Free text. Never read by the policy engine (see src/policy), and returned
   * to a caller only via GET /products/:sku/details, and only when the item is
   * both verified and unflagged. Treated as untrusted content throughout.
   */
  description?: string;
}

export interface ProductQuery {
  q?: string;
  max_price_paise?: number;
  category?: string;
  limit?: number;
}

/** One thing the ingest sanitiser noticed about one field of one item. */
export interface IngestIssue {
  field: string;
  kind: string;
  detail: string;
}

export interface IngestEntry {
  sku: string;
  flagged: boolean;
  quarantined: boolean;
  issues: IngestIssue[];
}

/**
 * The record of what ingest saw. Written to disk at load time, because the
 * point of flagging rather than stripping is that an attempt leaves a trace.
 */
export interface IngestReport {
  generated_at: string;
  source: string;
  items_seen: number;
  items_loaded: number;
  items_flagged: number;
  items_quarantined: number;
  /** Only items with something to report. A clean catalog yields an empty list. */
  entries: IngestEntry[];
}

/** What GET /products returns. There is no description field to omit. */
export interface ProductListView {
  sku: string;
  title: string;
  price_paise: number;
  category: string;
  stock: number;
}

/**
 * What GET /products/:sku/details returns — the only shape in the system that
 * can carry a description, and only for a verified, unflagged item. The field
 * is absent rather than empty: a blank string is still a string an agent might
 * reason about, and "the field does not exist" is a clearer contract.
 */
export interface ProductDetailView extends ProductListView {
  source: ProductSource;
  flagged: boolean;
  description?: string;
}
