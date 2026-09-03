import type { Product, ProductDetailView, ProductListView } from './types.js';

/**
 * The two shapes a product may take on the way out of the API.
 *
 * Splitting them is the cheapest injection defence in the system: the list view
 * has no description field at all, so the route every agent actually calls
 * cannot leak untrusted prose even if someone later forgets why it mattered.
 * Only the details route can carry a description, and most flows never call it.
 */

/** True when an item's description may be shown to a caller. */
export function describable(product: Product): boolean {
  return product.source === 'verified' && !product.flagged;
}

export function toListView(product: Product): ProductListView {
  return {
    sku: product.sku,
    title: product.title,
    price_paise: product.price_paise,
    category: product.category,
    stock: product.stock,
  };
}

export function toDetailView(product: Product): ProductDetailView {
  const view: ProductDetailView = {
    ...toListView(product),
    source: product.source,
    flagged: product.flagged,
  };
  // Omitted, not blanked. An unverified or flagged item simply has no
  // description as far as any caller can tell.
  if (describable(product) && product.description !== undefined) {
    view.description = product.description;
  }
  return view;
}
