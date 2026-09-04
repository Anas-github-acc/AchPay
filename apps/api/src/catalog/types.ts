import type { ProductSource } from '@storefront/shared';

export type { Product, ProductSource, RawProduct } from '@storefront/shared';

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
