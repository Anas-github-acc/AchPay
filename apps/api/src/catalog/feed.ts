import type { Catalog } from './catalog.js';
import { describable } from './views.js';
import type { Product } from './types.js';

/**
 * The catalog, rendered as an Agentic Commerce Protocol product feed.
 *
 * Targets ACP spec version 2026-04-17 — the `ProductsResponse` envelope from
 * spec/2026-04-17/json-schema/schema.feed.json: `{ products: [ { id, title,
 * description, url, variants: [ { id, title, price, availability, ... } ] } ] }`.
 *
 * Two things about this shape are worth saying out loud:
 *
 * 1. ACP prices are `{ amount, currency }` with `amount` an integer in ISO 4217
 *    *minor units*. For INR that is paise, which is what the catalog already
 *    stores, so the export is a copy and never a conversion. No float touches
 *    money on the way out any more than it does on the way in.
 *
 * 2. A description is emitted only for an item the ingest sanitiser left both
 *    verified and unflagged, using the same `describable()` predicate as
 *    GET /products/:sku/details. The feed is the most widely read surface in the
 *    system, so it gets the strictest version of the same rule rather than its
 *    own.
 *
 * Each catalog row is one product with exactly one variant. This storefront has
 * no variant axes (no colour, no size), and inventing a grouping the catalog
 * does not have would be a lie in a machine-readable file.
 */

export interface FeedOptions {
  /** Absolute origin the product URLs are built from. */
  baseUrl: string;
  sellerName: string;
  sellerUrl?: string;
  privacyPolicyUrl?: string;
  termsUrl?: string;
}

interface FeedPrice {
  amount: number;
  currency: 'INR';
}

interface FeedLink {
  type: string;
  title: string;
  url: string;
}

interface FeedSeller {
  name: string;
  links?: FeedLink[];
}

interface FeedVariant {
  id: string;
  title: string;
  description?: { plain: string };
  url: string;
  price: FeedPrice;
  availability: { available: boolean; status: string };
  categories: Array<{ value: string; taxonomy: string }>;
  condition: string;
  seller: FeedSeller;
}

interface FeedProduct {
  id: string;
  title: string;
  description?: { plain: string };
  url: string;
  variants: FeedVariant[];
}

export interface ProductFeed {
  products: FeedProduct[];
}

/** `in_stock` / `limited_stock` / `out_of_stock`, all from the ACP status list. */
function availability(product: Product): { available: boolean; status: string } {
  if (product.stock <= 0) return { available: false, status: 'out_of_stock' };
  if (product.stock < 5) return { available: true, status: 'limited_stock' };
  return { available: true, status: 'in_stock' };
}

function sellerLinks(opts: FeedOptions): FeedLink[] {
  const links: FeedLink[] = [];
  if (opts.sellerUrl) {
    links.push({ type: 'storefront', title: 'Storefront', url: opts.sellerUrl });
  }
  if (opts.privacyPolicyUrl) {
    links.push({ type: 'privacy_policy', title: 'Privacy Policy', url: opts.privacyPolicyUrl });
  }
  if (opts.termsUrl) {
    links.push({ type: 'terms_of_service', title: 'Terms of Service', url: opts.termsUrl });
  }
  return links;
}

export function buildProductFeed(catalog: Catalog, opts: FeedOptions): ProductFeed {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const links = sellerLinks(opts);
  const seller: FeedSeller = {
    name: opts.sellerName,
    ...(links.length > 0 ? { links } : {}),
  };

  const products = catalog.all().map((product): FeedProduct => {
    const url = `${base}/products/${encodeURIComponent(product.sku)}/details`;
    // Same predicate as the details route: untrusted prose never leaves here.
    const description =
      describable(product) && product.description !== undefined
        ? { plain: product.description }
        : undefined;

    const variant: FeedVariant = {
      id: product.sku,
      title: product.title,
      ...(description ? { description } : {}),
      url,
      price: { amount: product.price_paise, currency: 'INR' },
      availability: availability(product),
      categories: [{ value: product.category, taxonomy: 'merchant' }],
      condition: 'new',
      seller,
    };

    return {
      id: product.sku,
      title: product.title,
      ...(description ? { description } : {}),
      url,
      variants: [variant],
    };
  });

  return { products };
}
